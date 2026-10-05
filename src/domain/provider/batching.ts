import { estimateTokens } from './tokens';
import {
  instructionTokens,
  type DocumentTypeHint,
  type PromptUnit,
} from './translationPrompt';

/**
 * Controlled translation batching.
 *
 * A whole document is never one request. Batches are sized so that the prompt,
 * the expected output and the response framing all fit inside a single model
 * invocation with margin, using every input the spec calls out:
 *
 * - model context + max output tokens (hard constraints),
 * - estimated tokens of the actual payload (script-aware),
 * - provider RPM (low RPM favours fewer, larger requests),
 * - document type (noisy layouts and structured data get smaller batches),
 * - target language (Burmese output expands far beyond the source length),
 * - quality (precise = smaller batches for better focus).
 *
 * Units are never split across batches and never reordered: a batch boundary
 * can only fall between units, so reading order survives translation.
 */

export type BatchQuality = 'draft' | 'standard' | 'precise';

export interface BatchingPolicy {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly documentType: DocumentTypeHint;
  readonly quality?: BatchQuality;
  /** Provider requests-per-minute, if known. `null` = unknown (never assumed). */
  readonly rpm?: number | null;
  readonly maxUnitsPerBatch?: number;
}

export interface PlannedBatch {
  readonly units: readonly PromptUnit[];
  readonly promptTokens: number;
  readonly estimatedOutputTokens: number;
}

export interface BatchPlan {
  readonly batches: readonly PlannedBatch[];
  /** Units too large for any single request - attempted alone, flagged for the UI. */
  readonly oversizedUnitIds: readonly string[];
}

const DEFAULT_MAX_UNITS = 32;
const RESPONSE_FRAMING_TOKENS = 16;
const PER_UNIT_FRAMING_TOKENS = 8;
const CONTEXT_RESERVE_TOKENS = 512;

const QUALITY_FACTOR: Record<BatchQuality, number> = { draft: 1.6, standard: 1, precise: 0.55 };
const DOCUMENT_TYPE_FACTOR: Record<DocumentTypeHint, number> = {
  pdf: 0.75,
  docx: 0.9,
  text: 1,
  markdown: 0.9,
  html: 0.75,
  csv: 0.5,
  json: 0.5,
};

/** Output tokens per source character, by target script (conservative). */
function outputTokensPerChar(targetLanguage: string): number {
  // Burmese renders ~1.15x the source length and tokenises densely (>=1 token
  // per character in most tokenizers) - under-estimating here truncates output.
  return targetLanguage === 'my' ? 1.6 : 0.5;
}

/**
 * Output tokens per input token of unit payload (conservative upper bound).
 * Only the payload is re-emitted by the model - instructions are not echoed -
 * so this ratio sizes the payload against `maxOutputTokens`.
 */
function outputExpansion(targetLanguage: string): number {
  return targetLanguage === 'my' ? 6 : 2;
}

export function planBatches(units: readonly PromptUnit[], policy: BatchingPolicy): BatchPlan {
  const quality = policy.quality ?? 'standard';
  const maxUnits = Math.max(1, policy.maxUnitsPerBatch ?? DEFAULT_MAX_UNITS);
  const instructionOpts = {
    sourceLanguage: policy.sourceLanguage,
    targetLanguage: policy.targetLanguage,
    documentType: policy.documentType,
  };
  const overhead = instructionTokens(instructionOpts);
  const outputPerChar = outputTokensPerChar(policy.targetLanguage);
  const expansion = outputExpansion(policy.targetLanguage);

  // Two hard payload ceilings, both excluding the instruction overhead:
  // - context: prompt must fit the window with the full output allowance free,
  // - output: payload re-emitted as target text must fit max output tokens.
  const contextBudget = Math.max(
    128,
    policy.contextWindow - policy.maxOutputTokens - CONTEXT_RESERVE_TOKENS,
  );
  const contextPayloadBudget = Math.max(32, contextBudget - overhead);
  const outputPayloadBudget = Math.floor(
    (policy.maxOutputTokens * 0.95 - RESPONSE_FRAMING_TOKENS) / expansion,
  );

  let budget = Math.min(contextPayloadBudget, outputPayloadBudget);
  budget *= QUALITY_FACTOR[quality] * DOCUMENT_TYPE_FACTOR[policy.documentType];
  if (policy.rpm !== null && policy.rpm !== undefined && policy.rpm > 0 && policy.rpm < 10) {
    budget *= 1.5; // Low RPM: fewer, larger requests matter more than small prompts.
  }
  budget = Math.min(budget, contextPayloadBudget);
  const payloadBudget = Math.max(32, Math.floor(budget));

  const batches: PlannedBatch[] = [];
  const oversizedUnitIds: string[] = [];
  let current: PromptUnit[] = [];
  let currentSourceChars = 0;
  let currentPayloadTokens = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push({
      units: current,
      promptTokens: overhead + currentPayloadTokens,
      estimatedOutputTokens: Math.ceil(currentSourceChars * outputPerChar) + RESPONSE_FRAMING_TOKENS,
    });
    current = [];
    currentSourceChars = 0;
    currentPayloadTokens = 0;
  };

  for (const unit of units) {
    const payloadTokens = estimateTokens(unit.text) + PER_UNIT_FRAMING_TOKENS;
    const projectedOutput =
      (currentSourceChars + unit.text.length) * outputPerChar + RESPONSE_FRAMING_TOKENS;

    const aloneTooBig =
      payloadTokens > payloadBudget ||
      unit.text.length * outputPerChar + RESPONSE_FRAMING_TOKENS > policy.maxOutputTokens;
    if (aloneTooBig) {
      // Keep the unit intact: send it alone so the provider still gets a chance
      // (the engine reports a clear per-unit error if the model refuses).
      flush();
      oversizedUnitIds.push(unit.id);
      batches.push({
        units: [unit],
        promptTokens: overhead + payloadTokens,
        estimatedOutputTokens: Math.ceil(unit.text.length * outputPerChar) + RESPONSE_FRAMING_TOKENS,
      });
      continue;
    }

    const exceedsBatch =
      current.length > 0 &&
      (currentPayloadTokens + payloadTokens > payloadBudget ||
        current.length >= maxUnits ||
        projectedOutput > policy.maxOutputTokens);
    if (exceedsBatch) flush();

    current.push(unit);
    currentSourceChars += unit.text.length;
    currentPayloadTokens += payloadTokens;
  }
  flush();

  return { batches, oversizedUnitIds };
}
