import type { GlossaryRule } from './glossary';
import { normalizeForMatch } from './translationMemory';
import type { UnitStatus } from './types';

/**
 * Post-translation validation (Phase 4).
 *
 * Pure checks comparing a source text with its translation. They never edit
 * text - they only report findings so the editor can surface them as
 * warnings the user resolves (or consciously dismisses) manually.
 *
 * Design rule: every check must be conservative. A false positive teaches the
 * user to ignore warnings, so each comparison is exact (token multisets,
 * marker counts) rather than heuristic, except where a clear convention
 * exists (identical text when languages differ, glossary containment).
 */

export type WarningCode =
  | 'missing_text'
  | 'unexpected_empty'
  | 'untranslated'
  | 'numbers_changed'
  | 'units_changed'
  | 'urls_changed'
  | 'code_changed'
  | 'duplicated_text'
  | 'structure_mismatch'
  | 'glossary_violation';

export interface ValidationWarning {
  readonly code: WarningCode;
  readonly detail?: string;
}

export interface UnitCheckContext {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly glossary?: readonly GlossaryRule[];
}

export interface UnitCheckInput {
  readonly sourceText: string;
  readonly translatedText: string | null;
  readonly status: UnitStatus;
}

/** Measurement expressions that the prompt requires to survive verbatim. */
const MEASURE_RE =
  /\d+(?:[.,]\d+)?\s*(?:%|°[CF]|km|cm|mm|kg|mg|ml|kb|mb|gb|tb|ms|khz|ghz|px|dpi)\b/gi;
/** Digit runs (decimals and grouped digits kept as written). */
const NUMBER_RE = /\b\d+(?:[.,]\d+)?\b/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
/** Inline code spans and machine identifiers the rules say to preserve. */
const CODE_SPAN_RE = /`[^`\n]+`/g;
const SNAKE_CASE_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const CAMEL_CASE_RE = /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g;

/**
 * Case-insensitive multiset difference: tokens `left` has but `right` lacks.
 * Details keep the ORIGINAL casing (a user recognises `buildPath`, not
 * `buildpath`); each distinct missing token is reported once.
 */
function missingFrom(left: readonly string[], right: readonly string[]): string[] {
  const have = new Map<string, number>();
  for (const token of right) {
    const key = token.toLowerCase();
    have.set(key, (have.get(key) ?? 0) + 1);
  }
  const missing: string[] = [];
  for (const token of left) {
    const key = token.toLowerCase();
    const available = have.get(key) ?? 0;
    if (available > 0) {
      have.set(key, available - 1);
      continue;
    }
    if (!missing.includes(token)) missing.push(token);
  }
  return missing;
}

function extract(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((match) => match[0]);
}

/** URLs, with sentence-final punctuation trimmed (".", "।") excluded. */
function extractUrls(text: string): string[] {
  return extract(text, URL_RE).map((url) => url.replace(/[.,;:!?、。]+$/, ''));
}

interface StructureCounts {
  readonly headings: number;
  readonly lists: number;
  readonly tables: number;
  readonly quotes: number;
  readonly links: number;
}

function structureOf(text: string): StructureCounts {
  const lines = text.split('\n');
  return {
    headings: lines.filter((line) => /^#{1,6}\s/.test(line.trim())).length,
    lists: lines.filter((line) => /^\s*(?:[-*+]|\d+\.)\s/.test(line)).length,
    tables: lines.filter((line) => /^\s*\|.*\|\s*$/.test(line)).length,
    quotes: lines.filter((line) => /^\s*>\s?/.test(line)).length,
    links: (text.match(/\[[^\]]*\]\([^)]*\)/g) ?? []).length,
  };
}

function structureDetail(source: StructureCounts, target: StructureCounts): string | undefined {
  const parts: string[] = [];
  const check = (name: keyof StructureCounts): void => {
    if (source[name] !== target[name]) parts.push(`${name} ${source[name]} → ${target[name]}`);
  };
  check('headings');
  check('lists');
  check('tables');
  check('quotes');
  check('links');
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** True when the text plausibly contains translatable prose. */
function isProse(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length >= 3 || text.trim().length > 24;
}

/**
 * Glossary findings for one unit pair: forbidden wording present, or a
 * source term that appears in the source but whose preferred rendering is
 * missing from a translation that also dropped the original term.
 */
function glossaryWarnings(
  source: string,
  translation: string,
  rules: readonly GlossaryRule[],
): ValidationWarning[] {
  if (rules.length === 0) return [];
  const sourceNorm = normalizeForMatch(source);
  const translationNorm = normalizeForMatch(translation);
  const out: ValidationWarning[] = [];

  for (const rule of rules) {
    const preferred = normalizeForMatch(rule.preferred);
    if (rule.forbidden) {
      const forbidden = normalizeForMatch(rule.forbidden);
      if (forbidden && translationNorm.includes(forbidden)) {
        out.push({ code: 'glossary_violation', detail: `forbidden: ${rule.forbidden}` });
        continue;
      }
    }
    const term = normalizeForMatch(rule.source);
    if (!term || !sourceNorm.includes(term)) continue;
    const keepsPreferred = preferred !== '' && translationNorm.includes(preferred);
    const keepsSourceTerm = translationNorm.includes(term);
    if (!keepsPreferred && !keepsSourceTerm) {
      out.push({ code: 'glossary_violation', detail: `missing: ${rule.preferred}` });
    }
  }
  return out;
}

/**
 * All findings for one unit. Document-level checks (`duplicated_text`) are
 * separate - see `duplicateWarnings`.
 */
export function unitWarnings(
  input: UnitCheckInput,
  context: UnitCheckContext,
): ValidationWarning[] {
  const { sourceText, translatedText, status } = input;
  const out: ValidationWarning[] = [];

  const isDone = status === 'translated' || status === 'reviewed';
  if (!isDone) {
    // Pending/failed/in-progress units are unfinished work, not validation
    // failures: their status badges already tell that story.
    return out;
  }
  if (translatedText === null) {
    out.push({ code: 'missing_text' });
    return out;
  }
  if (sourceText.trim() !== '' && translatedText.trim() === '') {
    out.push({ code: 'unexpected_empty' });
    return out;
  }

  const languagesDiffer = context.sourceLanguage !== context.targetLanguage;
  if (languagesDiffer && isProse(sourceText) && normalizeForMatch(sourceText) === normalizeForMatch(translatedText)) {
    out.push({ code: 'untranslated' });
  }

  const numbersChanged = missingFrom(extract(sourceText, NUMBER_RE), extract(translatedText, NUMBER_RE));
  if (numbersChanged.length > 0) {
    out.push({ code: 'numbers_changed', detail: numbersChanged.join(', ') });
  }

  const unitsChanged = missingFrom(extract(sourceText, MEASURE_RE), extract(translatedText, MEASURE_RE));
  if (unitsChanged.length > 0) {
    out.push({ code: 'units_changed', detail: unitsChanged.join(', ') });
  }

  const urlsChanged = missingFrom(extractUrls(sourceText), extractUrls(translatedText));
  if (urlsChanged.length > 0) {
    out.push({ code: 'urls_changed', detail: urlsChanged.join(', ') });
  }

  const codeTokens = [
    ...extract(sourceText, CODE_SPAN_RE),
    ...extract(sourceText, SNAKE_CASE_RE),
    ...extract(sourceText, CAMEL_CASE_RE),
  ];
  const codeInTranslation = [
    ...extract(translatedText, CODE_SPAN_RE),
    ...extract(translatedText, SNAKE_CASE_RE),
    ...extract(translatedText, CAMEL_CASE_RE),
  ];
  const codeChanged = missingFrom(codeTokens, codeInTranslation);
  if (codeChanged.length > 0) {
    out.push({ code: 'code_changed', detail: codeChanged.join(', ') });
  }

  const structure = structureDetail(structureOf(sourceText), structureOf(translatedText));
  if (structure) {
    out.push({ code: 'structure_mismatch', detail: structure });
  }

  out.push(...glossaryWarnings(sourceText, translatedText, context.glossary ?? []));
  return out;
}

/** Minimal shape the document-level duplicate check needs. */
export interface DuplicationUnit {
  readonly id: string;
  readonly sourceText: string;
  readonly translatedText: string | null;
  readonly status: UnitStatus;
}

/**
 * `duplicated_text`: the same translation was written for units whose
 * sources DIFFER - almost always a copy/paste or a model looping. Only
 * translated/reviewed units with real translations take part; identical
 * sources legitimately share identical translations.
 */
export function duplicateWarnings(
  units: readonly DuplicationUnit[],
): ReadonlyMap<string, ValidationWarning> {
  const byTranslation = new Map<string, DuplicationUnit[]>();
  for (const unit of units) {
    if (unit.status !== 'translated' && unit.status !== 'reviewed') continue;
    if (!unit.translatedText || unit.translatedText.trim() === '') continue;
    const key = normalizeForMatch(unit.translatedText);
    const bucket = byTranslation.get(key);
    if (bucket) bucket.push(unit);
    else byTranslation.set(key, [unit]);
  }

  const flagged = new Map<string, ValidationWarning>();
  for (const bucket of byTranslation.values()) {
    if (bucket.length < 2) continue;
    const sources = new Set(bucket.map((unit) => normalizeForMatch(unit.sourceText)));
    if (sources.size < 2) continue; // same source -> same translation is correct
    for (const unit of bucket) flagged.set(unit.id, { code: 'duplicated_text' });
  }
  return flagged;
}
