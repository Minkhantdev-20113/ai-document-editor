import { AppError } from '../../core/errors/appError';
import type { GlossaryRule } from '../glossary';
import { estimateTokens } from './tokens';

/**
 * Translation prompt construction and response parsing.
 *
 * Everything here is pure: the engine feeds units in and gets a strict result
 * out. The JSON contract is fixed - every provider speaks it, structured
 * response modes (Gemini `responseMimeType`, OpenAI `response_format`) merely
 * make the model comply more reliably.
 */

export type DocumentTypeHint = 'pdf' | 'docx' | 'text' | 'markdown' | 'html' | 'csv' | 'json';

export interface PromptUnit {
  readonly id: string;
  readonly text: string;
}

export interface TranslationPromptOptions {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly documentType: DocumentTypeHint;
  /** Output temperature: lower is stricter about preservation rules. */
  readonly temperature?: number;
  /** Project glossary rules; mandatory, override any instinct to translate differently. */
  readonly glossary?: readonly GlossaryRule[];
}

function contextNote(documentType: DocumentTypeHint, targetLanguage: string): string {
  const notes: Record<DocumentTypeHint, string> = {
    pdf: 'Units were extracted from a laid-out PDF page. Preserve heading, list and table semantics; never merge or split units.',
    docx: 'Units come from a word-processing document. Preserve paragraph structure and inline emphasis markers.',
    text: 'Units are plain-text paragraphs.',
    markdown: 'Preserve every Markdown marker exactly (#, -, *, |, >, backticks, links); translate link labels, never link targets.',
    html: 'Units may contain inline HTML/markup fragments; keep tags intact and translate only the human-readable text.',
    csv: 'Units are table cells. Do not introduce newlines unless the source cell contained them.',
    json: 'Units are values from a structured document. Keep placeholders and keys untranslated where they are machine-readable.',
  };
  const base = notes[documentType];
  if (targetLanguage === 'my') {
    return `${base} Output language: Burmese (my).`;
  }
  return `${base} Output language: ${targetLanguage}.`;
}

/** Terminology rules from the project glossary (appended last: they win). */
function glossarySection(rules: readonly GlossaryRule[]): string {
  if (rules.length === 0) return '';
  const lines = rules.map((rule) => {
    let line = `- "${rule.source}" must be translated as "${rule.preferred}".`;
    if (rule.forbidden) line += ` Never use "${rule.forbidden}" for this term.`;
    if (rule.notes) line += ` (${rule.notes})`;
    return line;
  });
  return `
Project glossary (mandatory for every unit - consistency across units matters):
${lines.join('\n')}
`;
}

/** The always-present preservation rules (all target languages). */
function systemPrompt(options: TranslationPromptOptions): string {
  const { sourceLanguage, targetLanguage } = options;
  const burmeseRules =
    targetLanguage === 'my'
      ? `
Additional rules for Burmese output:
- Use standard modern Burmese orthography; keep the formal register of the source.
- Keep English technical loanwords in parentheses after the Burmese term on first use, e.g. "ဆာဗာ (server)".
- Never convert numbers to Burmese numerals unless the source already used them.
- Keep acronyms (API, PDF, HTTPS, URL) unchanged.
`
      : '';

  return `You are a professional document translator inside a file-translation application.
Translate every unit you receive from ${sourceLanguage} to ${targetLanguage}. Follow all rules.

Translation rules:
1. Translate faithfully and completely. Never summarise, add or omit content.
2. Preserve exactly: numbers and numeric formats, units of measurement, formulas and mathematical notation, code snippets and identifiers, URLs, file paths, citation markers (e.g. [12], (Smith, 2021)), and Markdown/structure markers (#, -, *, |, >, backticks, links).
3. Keep technical terminology consistent across all units. If a term has no established ${targetLanguage} equivalent, keep it in its original script; a short parenthetical gloss is allowed on first use.
4. Keep proper nouns (people, organisations, products, places) in their original script unless a widely accepted ${targetLanguage} form exists.
5. Match the source tone and register, and preserve paragraph breaks and punctuation style.
6. Never translate the inside of code spans, identifiers, or URL targets - only their surrounding label text.
7. Respond with ONLY one valid JSON object in the exact requested shape: no commentary, no markdown fences, no trailing text.
${burmeseRules}${glossarySection(options.glossary ?? [])}`;
}

function userPrompt(units: readonly PromptUnit[], options: TranslationPromptOptions): string {
  const payload = JSON.stringify({ units: units.map((unit) => ({ id: unit.id, text: unit.text })) });
  return `Translate these ${units.length} units.

Context: ${contextNote(options.documentType, options.targetLanguage)}

Respond with exactly this JSON shape:
{"translations":[{"id":"<unit id>","text":"<translated text>"}]}
Every id must appear exactly once, in the same order as the input.

Input units:
${payload}`;
}

export interface TranslationMessages {
  readonly system: string;
  readonly user: string;
}

export function buildTranslationMessages(
  units: readonly PromptUnit[],
  options: TranslationPromptOptions,
): TranslationMessages {
  return { system: systemPrompt(options), user: userPrompt(units, options) };
}

/** Prompt-side token cost of the instructions (not the unit payloads). */
export function instructionTokens(options: TranslationPromptOptions): number {
  return estimateTokens(systemPrompt(options)) + estimateTokens(userPrompt([], options));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractJson(text: string): unknown {
  const withoutFences = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(withoutFences);
  } catch {
    // Last resort: pull the outermost object out of surrounding prose.
    const start = withoutFences.indexOf('{');
    const end = withoutFences.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(withoutFences.slice(start, end + 1));
    }
    throw new AppError('Translation response was not valid JSON', {
      code: 'provider_rejected',
      retryable: true,
    });
  }
}

/**
 * Validates a model response against the requested unit ids.
 *
 * Throws (retryable `provider_rejected`) when the model returned prose, dropped
 * units, or produced empty translations - the engine then retries with a fresh
 * key instead of silently accepting uncontrolled prose.
 */
export function parseTranslationResponse(
  text: string,
  expectedIds: readonly string[],
): ReadonlyMap<string, string> {
  const parsed = extractJson(text);
  const result = new Map<string, string>();

  if (isRecord(parsed)) {
    const entries = Array.isArray(parsed['translations']) ? (parsed['translations'] as unknown[]) : null;
    if (entries) {
      for (const entry of entries) {
        if (!isRecord(entry)) continue;
        const id = entry['id'];
        const value = entry['text'];
        if (typeof id === 'string' && typeof value === 'string') result.set(id, value);
      }
    } else {
      // Tolerated fallback shape: {"<id>": "<translation>", ...}
      for (const [id, value] of Object.entries(parsed)) {
        if (typeof value === 'string') result.set(id, value);
      }
    }
  } else {
    throw new AppError('Translation response had an unexpected shape', {
      code: 'provider_rejected',
      retryable: true,
    });
  }

  const missing = expectedIds.filter((id) => {
    const value = result.get(id);
    return value === undefined || value.trim() === '';
  });
  if (missing.length > 0) {
    throw new AppError(`Translation response is missing ${missing.length} of ${expectedIds.length} units`, {
      code: 'provider_rejected',
      retryable: true,
      details: { missing: missing.slice(0, 10) },
    });
  }

  // Return only what was asked for, in the requested order.
  const ordered = new Map<string, string>();
  for (const id of expectedIds) {
    ordered.set(id, result.get(id) as string);
  }
  return ordered;
}
