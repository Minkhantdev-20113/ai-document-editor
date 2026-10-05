import { AppError } from '../core/errors/appError';

/**
 * Glossary domain (Phase 4): user-defined terminology rules that steer the
 * translation prompt and back the post-translation validation.
 *
 * Pure by design - validation, normalization and rule projection live here so
 * the service, the prompt builder and the validation checks all agree on what
 * a rule is and when it is violated.
 */

/** Slim projection handed to the prompt and the validators. */
export interface GlossaryRule {
  /** Source-language term (e.g. "the Submit button"). */
  readonly source: string;
  /** Required target-language rendering of the term. */
  readonly preferred: string;
  /** Wording that must never appear for this term. */
  readonly forbidden?: string;
  /** Optional human note (context, register, do-not-translate hints). */
  readonly notes?: string;
}

/** What the UI submits when creating/updating an entry. */
export interface GlossaryEntryInput {
  readonly sourceTerm: string;
  readonly preferredTranslation: string;
  readonly forbiddenTranslation?: string | null;
  readonly notes?: string | null;
}

/** Shape shared by stored entries and rule projection. */
export interface GlossaryEntryFields {
  readonly sourceTerm: string;
  readonly preferredTranslation: string;
  readonly forbiddenTranslation: string | null;
  readonly notes: string | null;
}

export const GLOSSARY_LIMITS = {
  maxTermLength: 200,
  maxTranslationLength: 500,
  maxNotesLength: 1_000,
} as const;

function fail(message: string): never {
  throw new AppError(message, { code: 'validation', retryable: false });
}

/**
 * Normalized form used for duplicate detection and violation matching:
 * trimmed, lowercased, whitespace collapsed. Matching on this keeps
 * "Submit Button" and "submit  button" from becoming two competing rules.
 */
export function normalizeTerm(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface NormalizedGlossaryEntry {
  readonly sourceTerm: string;
  readonly preferredTranslation: string;
  readonly forbiddenTranslation: string | null;
  readonly notes: string | null;
}

/**
 * Validates and normalizes one input. Throws a typed `validation` error with
 * a message safe to show the user; never coerces empty input into a rule.
 */
export function validateGlossaryInput(input: GlossaryEntryInput): NormalizedGlossaryEntry {
  const sourceTerm = input.sourceTerm.trim();
  const preferredTranslation = input.preferredTranslation.trim();
  const forbiddenTranslation = input.forbiddenTranslation?.trim() ?? '';
  const notes = input.notes?.trim() ?? '';

  if (!sourceTerm) fail('A glossary term is required');
  if (sourceTerm.length > GLOSSARY_LIMITS.maxTermLength) {
    fail(`Glossary terms are limited to ${GLOSSARY_LIMITS.maxTermLength} characters`);
  }
  if (!preferredTranslation) fail('A preferred translation is required');
  if (preferredTranslation.length > GLOSSARY_LIMITS.maxTranslationLength) {
    fail(`Preferred translations are limited to ${GLOSSARY_LIMITS.maxTranslationLength} characters`);
  }
  if (forbiddenTranslation.length > GLOSSARY_LIMITS.maxTranslationLength) {
    fail(`Forbidden translations are limited to ${GLOSSARY_LIMITS.maxTranslationLength} characters`);
  }
  if (notes.length > GLOSSARY_LIMITS.maxNotesLength) {
    fail(`Notes are limited to ${GLOSSARY_LIMITS.maxNotesLength} characters`);
  }

  return {
    sourceTerm,
    preferredTranslation,
    forbiddenTranslation: forbiddenTranslation || null,
    notes: notes || null,
  };
}

/** True when another entry already owns the same normalized term. */
export function isDuplicateTerm(
  entries: readonly (GlossaryEntryFields & { readonly id?: string })[],
  sourceTerm: string,
  excludeId?: string,
): boolean {
  const needle = normalizeTerm(sourceTerm);
  if (!needle) return false;
  return entries.some(
    (entry) => entry.id !== excludeId && normalizeTerm(entry.sourceTerm) === needle,
  );
}

/** Projects a stored entry into the slim rule the prompt/validators consume. */
export function toGlossaryRule(entry: GlossaryEntryFields): GlossaryRule {
  return {
    source: entry.sourceTerm,
    preferred: entry.preferredTranslation,
    ...(entry.forbiddenTranslation ? { forbidden: entry.forbiddenTranslation } : {}),
    ...(entry.notes ? { notes: entry.notes } : {}),
  };
}
