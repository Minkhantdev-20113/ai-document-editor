import { appEvents } from '../core/events/eventBus';
import { AppError, toAppError } from '../core/errors/appError';
import { logger } from '../core/logging/logger';
import { translationUnitsRepo } from '../db/repositories';
import type { DocumentRecord, TranslationUnit } from '../db/entities';
import { backoffDelayMs } from '../domain/provider/backoff';
import { planBatches, type BatchQuality, type BatchingPolicy } from '../domain/provider/batching';
import { estimateTokens } from '../domain/provider/tokens';
import type { GlossaryRule } from '../domain/glossary';
import type { DocumentTypeHint } from '../domain/provider/translationPrompt';
import type { AIProvider } from '../providers/aiProvider';
import { getProviderDescriptor } from '../providers/registry';
import { PROVIDER_IDS, type ProviderId } from '../providers/types';
import { getAIProvider } from './aiProviderService';
import { documentService } from './documentService';
import { glossaryService } from './glossaryService';
import { keyPoolService } from './keyPoolService';
import { projectService } from './projectService';
import { providerConfigService } from './providerConfigService';
import { settingsService } from './settingsService';
import { usageService } from './usageService';
import { translationMemoryService } from './translationMemoryService';
import { validationService } from './validationService';
import { MEMORY_THRESHOLDS } from '../domain/translationMemory';

/**
 * Translation engine (Phase 3).
 *
 * Guarantees:
 * - Units are persisted individually (`in_progress` -> `translated`/`failed`),
 *   so a crash, refresh or pause NEVER loses completed work; the next run
 *   resumes from exactly the pending/failed units.
 * - A failed key is retried on another healthy key (weighted pool), then on
 *   another provider, with exponential backoff + jitter - never a tight loop.
 * - Provider quota is checked per provider: other providers are tried first,
 *   and only when EVERY candidate is quota-blocked does the run stop with
 *   `paused_quota` so the job can pause ("Provider quota exhausted").
 * - No provider-specific logic lives here: everything goes through AIProvider.
 */

const MAX_ATTEMPTS_PER_PROVIDER = 5;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 90_000;
/** Conservative sizing for models missing from the registry (never assume). */
const FALLBACK_CONTEXT = 8_192;
const FALLBACK_MAX_OUTPUT = 2_048;

/**
 * Fail-fast codes: errors that describe the run's CONFIGURATION rather than
 * the batch's content. The next batch would hit exactly the same wall (a
 * retired model id, keys the endpoint rejects), so the run stops on the first
 * batch instead of issuing one doomed request per batch until the document is
 * exhausted - which is how a retired model used to turn 0 of N units into
 * hundreds of identical provider errors. Content-dependent failures
 * (policy blocks, over-long batches) are deliberately NOT in this set: they
 * can succeed on the next batch.
 */
const CONFIG_ERROR_CODES: ReadonlySet<string> = new Set([
  'provider_invalid_model',
  'provider_invalid_key',
]);

/**
 * Translation strategy (Phase 4 workflow): how carefully the engine batches
 * and samples. `draft` favours throughput, `precise` favours focus (smaller
 * batches, lower temperature), `standard` is the default balance.
 */
export type TranslationStrategy = BatchQuality;
export const DEFAULT_STRATEGY: TranslationStrategy = 'standard';

const STRATEGY_TEMPERATURE: Record<TranslationStrategy, number> = {
  draft: 0.4,
  standard: 0.2,
  precise: 0.1,
};

/** Unknown payload values fall back to the default instead of failing a job. */
export function isTranslationStrategy(value: unknown): value is TranslationStrategy {
  return value === 'draft' || value === 'standard' || value === 'precise';
}

export interface TranslationProgress {
  readonly documentId: string;
  readonly processed: number;
  readonly total: number;
  readonly batchIndex: number;
  readonly batchCount: number;
  /** Null until a provider request has actually run (e.g. memory pre-fill). */
  readonly providerId: ProviderId | null;
  readonly model: string | null;
  /** Vault key id used for the last batch - never the key itself. */
  readonly keyId: string | null;
  readonly completedPages: number;
  readonly totalPages: number;
}

export type TranslationStatus =
  | 'completed'
  | 'nothing_to_do'
  | 'paused_quota'
  | 'aborted'
  | 'failed';

export interface TranslationOutcome {
  readonly status: TranslationStatus;
  /** Units translated in this run. */
  readonly translated: number;
  /** Units already translated before this run (resume). */
  readonly skipped: number;
  /** Units marked failed in this run (saved with their error, retried later). */
  readonly failed: number;
  /** Units completed from translation memory (opt-in, no provider request). */
  readonly memoryFilled: number;
  readonly providerId: ProviderId | null;
  readonly model: string | null;
  /** Units too large for one request; attempted alone, flagged for the UI. */
  readonly oversizedUnitIds: readonly string[];
  /** Last error when `status === 'failed'`. */
  readonly error?: AppError;
}

export interface TranslateDocumentInput {
  readonly documentId: string;
  readonly signal?: AbortSignal;
  readonly strategy?: TranslationStrategy;
  readonly onProgress?: (progress: TranslationProgress) => void;
}

export interface TranslationServiceDeps {
  readonly createProvider?: (providerId: ProviderId) => Promise<AIProvider>;
  readonly random?: () => number;
  readonly now?: () => number;
  /** Injectable wait keeps tests free of real timers. */
  readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable "wait for connectivity" keeps offline tests deterministic. */
  readonly waitForOnline?: (signal?: AbortSignal) => Promise<void>;
}

interface ProviderCandidate {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly rpm: number | null;
}

interface BatchSuccess {
  readonly kind: 'done';
  readonly providerIndex: number;
  readonly providerId: ProviderId;
  readonly model: string;
  readonly keyId: string;
  readonly translations: ReadonlyMap<string, string>;
  readonly usage: { readonly input: number; readonly output: number; readonly cached: number };
}

type BatchOutcome =
  | BatchSuccess
  | { readonly kind: 'quota'; readonly providerIndex: number }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'error'; readonly error: AppError; readonly providerIndex: number };

/** Per-batch context: shared terminology, sampling temperature, cancellation. */
interface BatchRunOptions {
  readonly signal?: AbortSignal;
  readonly glossary?: readonly GlossaryRule[];
  /** Strategy-derived sampling temperature (lower = stricter preservation). */
  readonly temperature?: number;
}

function defaultWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Resolves when the browser regains connectivity (Phase 4 network rule:
 * pause AI requests while offline, retry once `online` fires - no reload, no
 * lost work). Already online (or no window): resolves immediately.
 */
function defaultWaitForOnline(signal?: AbortSignal): Promise<void> {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || navigator.onLine !== false) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    function done() {
      window.removeEventListener('online', done);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    window.addEventListener('online', done, { once: true });
    signal?.addEventListener('abort', done, { once: true });
  });
}

function documentTypeHint(document: DocumentRecord): DocumentTypeHint {
  if (document.kind === 'pdf') return 'pdf';
  const name = document.fileName.toLowerCase();
  if (name.endsWith('.docx')) return 'docx';
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown';
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'html';
  if (name.endsWith('.csv')) return 'csv';
  if (name.endsWith('.json')) return 'json';
  return 'text';
}

class TranslationService {
  private readonly createProvider: (providerId: ProviderId) => Promise<AIProvider>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly waitForOnline: (signal?: AbortSignal) => Promise<void>;

  constructor(deps: TranslationServiceDeps = {}) {
    this.createProvider = deps.createProvider ?? ((providerId) => getAIProvider(providerId));
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.wait = deps.wait ?? defaultWait;
    this.waitForOnline = deps.waitForOnline ?? defaultWaitForOnline;
  }

  /**
   * Providers eligible right now, in preference order (Gemini first per the
   * spec). Quota-cooled, key-less, disabled or invalid-key providers are
   * excluded up front - which is what makes resume-after-pause work: the next
   * run simply never asks them.
   */
  async resolveCandidates(): Promise<ProviderCandidate[]> {
    const candidates: ProviderCandidate[] = [];
    for (const providerId of PROVIDER_IDS) {
      try {
        const config = await providerConfigService.ensure(providerId);
        if (!config.enabled || !config.defaultModel) continue;
        const state = await keyPoolService.rateLimitState(providerId);
        if (
          state.exhaustion === 'no_keys' ||
          state.exhaustion === 'quota' ||
          state.exhaustion === 'invalid'
        ) {
          logger.info('Provider excluded from translation run', {
            providerId,
            exhaustion: state.exhaustion,
          });
          continue;
        }
        const descriptor = getProviderDescriptor(providerId);
        const known = descriptor.models.find((model) => model.id === config.defaultModel);
        const rpm =
          config.rateLimitOverride?.requestsPerMinute ?? descriptor.rateLimit.requestsPerMinute ?? null;
        candidates.push({
          providerId,
          model: config.defaultModel,
          // Unknown models get the smallest honest budget: undersizing a batch
          // is safe, oversizing one breaks the request.
          contextWindow: known?.contextWindow ?? FALLBACK_CONTEXT,
          maxOutputTokens: known?.maxOutputTokens ?? FALLBACK_MAX_OUTPUT,
          rpm,
        });
      } catch (error) {
        logger.debug('Skipping provider candidate', {
          providerId,
          code: toAppError(error).code,
        });
      }
    }
    return candidates;
  }

  /** True when an enabled provider's whole key pool is cooling on quota. */
  private async hasQuotaBlockedProvider(): Promise<boolean> {
    for (const providerId of PROVIDER_IDS) {
      try {
        const config = await providerConfigService.ensure(providerId);
        if (!config.enabled) continue;
        if (await keyPoolService.isQuotaExhausted(providerId)) return true;
      } catch {
        // Unreadable config/provider: treat as unusable, keep checking others.
      }
    }
    return false;
  }

  async translateDocument(input: TranslateDocumentInput): Promise<TranslationOutcome> {
    const document = await documentService.require(input.documentId);
    const allUnits = (await translationUnitsRepo.queryByIndex('by_document', document.id)) ?? [];
    allUnits.sort((a, b) => a.orderIndex - b.orderIndex);

    const isDone = (unit: TranslationUnit): boolean =>
      unit.status === 'translated' || unit.status === 'reviewed';

    // Page-level progress (Phase 4): the UI shows page x/y alongside unit
    // x/y, so track per-page completion as units finish.
    const pageState = new Map<string, { done: number; total: number }>();
    const unitPage = new Map<string, string>();
    for (const unit of allUnits) {
      unitPage.set(unit.id, unit.pageId);
      const page = pageState.get(unit.pageId) ?? { done: 0, total: 0 };
      page.total += 1;
      if (isDone(unit)) page.done += 1;
      pageState.set(unit.pageId, page);
    }
    const markPagesDone = (unitIds: Iterable<string>): void => {
      for (const id of unitIds) {
        const pageId = unitPage.get(id);
        const page = pageId ? pageState.get(pageId) : undefined;
        if (page && page.done < page.total) page.done += 1;
      }
    };
    const pageProgress = (): { completedPages: number; totalPages: number } => {
      let completedPages = 0;
      for (const page of pageState.values()) if (page.done >= page.total) completedPages += 1;
      return { completedPages, totalPages: pageState.size };
    };

    const skipped = allUnits.filter(isDone).length;
    let pending = allUnits.filter((unit) => !isDone(unit));

    const base = { translated: 0, skipped, failed: 0, memoryFilled: 0, providerId: null, model: null, oversizedUnitIds: [] as readonly string[] };
    if (pending.length === 0) {
      return { status: 'nothing_to_do', ...base };
    }

    // Opt-in translation memory pre-fill (Phase 4): when the user enabled
    // `memoryAutoApply`, units whose source matches a previous translation at
    // auto-apply confidence are completed locally - no provider request, no
    // usage record, and `provider`/`model` stay null because no AI produced
    // the text.
    let memoryFilled = 0;
    if (settingsService.value('memoryAutoApply')) {
      const filledIds = await this.applyTranslationMemory(pending, document, input.signal);
      memoryFilled = filledIds.size;
      if (memoryFilled > 0) {
        pending = pending.filter((unit) => !filledIds.has(unit.id));
        markPagesDone(filledIds);
        appEvents.emit('units:changed', { documentId: document.id });
      }
    }

    if (pending.length === 0) {
      // Everything was completed from memory: no provider is needed at all.
      input.onProgress?.({
        documentId: document.id,
        processed: skipped + memoryFilled,
        total: allUnits.length,
        batchIndex: 0,
        batchCount: 0,
        providerId: null,
        model: null,
        keyId: null,
        ...pageProgress(),
      });
      const outcome: TranslationOutcome = {
        status: 'completed',
        ...base,
        memoryFilled,
      };
      await this.validateIfCompleted(document, outcome.status);
      return outcome;
    }

    const candidates = await this.resolveCandidates();
    if (candidates.length === 0) {
      // Distinguish "still quota-blocked everywhere" (keep the job paused with
      // a clear reason) from "nothing usable is configured" (fail loudly).
      const quotaBlocked = await this.hasQuotaBlockedProvider();
      if (quotaBlocked) {
        logger.warn('Provider quota still exhausted on resume', { documentId: document.id });
        return { status: 'paused_quota', ...base, memoryFilled };
      }
      return {
        status: 'failed',
        ...base,
        memoryFilled,
        error: new AppError('No enabled provider with usable API keys is configured', {
          code: 'provider_unavailable',
          retryable: false,
        }),
      };
    }

    // Size batches against the SMALLEST model budget so any candidate can
    // serve any batch, whatever failover picks mid-run. The workflow's
    // strategy becomes the batching quality (draft favours throughput,
    // precise favours smaller, more focused batches).
    const strategy = isTranslationStrategy(input.strategy) ? input.strategy : DEFAULT_STRATEGY;
    const rpms = candidates
      .map((candidate) => candidate.rpm)
      .filter((value): value is number => value !== null);
    const policy: BatchingPolicy = {
      contextWindow: Math.min(...candidates.map((candidate) => candidate.contextWindow)),
      maxOutputTokens: Math.min(...candidates.map((candidate) => candidate.maxOutputTokens)),
      sourceLanguage: document.sourceLanguage,
      targetLanguage: document.targetLanguage,
      documentType: documentTypeHint(document),
      quality: strategy,
      rpm: rpms.length > 0 ? Math.min(...rpms) : null,
    };
    const plan = planBatches(
      pending.map((unit) => ({ id: unit.id, text: unit.sourceText })),
      policy,
    );

    // Terminology rules apply to every batch of this run (Phase 4): loaded
    // once so mid-run glossary edits never produce mixed conventions.
    const glossary = await glossaryService.rulesFor(document.projectId);

    let translated = 0;
    let failed = 0;
    let primaryIndex = 0;
    let lastError: AppError | undefined;
    let lastProvider: ProviderId | null = null;
    let lastModel: string | null = null;
    let lastKeyId: string | null = null;

    const summary = (status: TranslationStatus): TranslationOutcome => ({
      status,
      translated,
      skipped,
      failed,
      memoryFilled,
      providerId: lastProvider,
      model: lastModel,
      oversizedUnitIds: plan.oversizedUnitIds,
      ...(lastError ? { error: lastError } : {}),
    });

    for (let batchIndex = 0; batchIndex < plan.batches.length; batchIndex += 1) {
      const batch = plan.batches[batchIndex];
      if (!batch) continue;
      if (input.signal?.aborted) return summary('aborted');

      // Persist intent before the network call: a refresh mid-request leaves
      // `in_progress` units, which the next run treats as pending (resume).
      await this.markInProgress(batch.units.map((unit) => unit.id));

      const outcome = await this.runBatch(batch.units, candidates, primaryIndex, document, {
        ...(input.signal ? { signal: input.signal } : {}),
        ...(glossary.length > 0 ? { glossary } : {}),
        temperature: STRATEGY_TEMPERATURE[strategy],
      });
      if (outcome.kind === 'aborted') return summary('aborted');

      if (outcome.kind === 'quota') {
        logger.warn('Provider quota exhausted; translation paused', {
          documentId: document.id,
          providerIndex: outcome.providerIndex,
        });
        return summary('paused_quota');
      }

      if (outcome.kind === 'error') {
        lastError = outcome.error;
        failed += await this.markBatchFailed(batch.units.map((unit) => unit.id), outcome.error);

        if (CONFIG_ERROR_CODES.has(outcome.error.code)) {
          // Configuration problem, not content: every remaining batch would
          // fail identically, so stop now and tell the user what to change.
          const candidate = candidates[outcome.providerIndex] ?? candidates[0];
          const providerLabel = candidate ? getProviderDescriptor(candidate.providerId).label : 'the provider';
          const hint =
            outcome.error.code === 'provider_invalid_model'
              ? `The model "${candidate?.model ?? ''}" is not available on ${providerLabel}. Open Providers, pick a current model, then run the translation again.`
              : `Every ${providerLabel} API key was rejected. Re-verify the key on the API keys page, then run the translation again.`;
          lastError = new AppError(hint, {
            code: outcome.error.code,
            retryable: false,
            details: outcome.error.details,
          });
          logger.error('Aborting translation: configuration error would repeat for every batch', {
            documentId: document.id,
            providerId: candidate?.providerId ?? null,
            model: candidate?.model ?? null,
            code: outcome.error.code,
            batchIndex: batchIndex + 1,
            batchCount: plan.batches.length,
          });
          return summary('failed');
        }

        // Next batch prefers a different provider than the one that failed.
        const nextPrimary = outcome.providerIndex + 1;
        primaryIndex = nextPrimary < candidates.length ? nextPrimary : primaryIndex;
      } else {
        primaryIndex = outcome.providerIndex;
        lastProvider = outcome.providerId;
        lastModel = outcome.model;
        lastKeyId = outcome.keyId;
        translated += await this.markBatchTranslated(batch.units, outcome, document);
        markPagesDone(batch.units.map((unit) => unit.id));
        await usageService.record({
          providerId: outcome.providerId,
          model: outcome.model,
          inputTokens: outcome.usage.input,
          outputTokens: outcome.usage.output,
          cachedTokens: outcome.usage.cached,
          // Token counts come from the provider's own response usage; cost is
          // always a local estimate (see usageService).
          basis: 'provider_reported',
        });
      }

      input.onProgress?.({
        documentId: document.id,
        processed: skipped + translated + failed + memoryFilled,
        total: allUnits.length,
        batchIndex: batchIndex + 1,
        batchCount: plan.batches.length,
        providerId: lastProvider ?? candidates[0]?.providerId ?? null,
        model: lastModel ?? candidates[0]?.model ?? null,
        keyId: lastKeyId,
        ...pageProgress(),
      });
      appEvents.emit('units:changed', { documentId: document.id });
    }

    const finalStatus: TranslationStatus =
      failed > 0 && translated === 0 && skipped === 0 ? 'failed' : 'completed';
    const finalOutcome = summary(finalStatus);
    await this.validateIfCompleted(document, finalOutcome.status);
    return finalOutcome;
  }

  /**
   * Post-run validation (Phase 4): after a completed run, findings (missing
   * text, changed numbers/units/URLs/code, duplicates, structure, glossary
   * violations) are computed and persisted onto the units for the editor to
   * surface. Never throws - a validation problem must not fail an otherwise
   * successful translation.
   */
  private async validateIfCompleted(
    document: DocumentRecord,
    status: TranslationStatus,
  ): Promise<void> {
    if (status !== 'completed') return;
    try {
      const summary = await validationService.validateDocument(document.id);
      if (summary.totalWarnings > 0) {
        logger.info('Translation validation found warnings', {
          documentId: document.id,
          unitsWithWarnings: summary.unitsWithWarnings,
          totalWarnings: summary.totalWarnings,
        });
      }
    } catch (error) {
      logger.warn('Post-translation validation failed', {
        documentId: document.id,
        error: toAppError(error).message,
      });
    }
  }

  /**
   * Serves one batch: healthy-key rotation inside a provider (the pool does
   * that), provider failover across candidates, and backoff + jitter between
   * attempts. Returns the structured result so the caller can persist units
   * one by one. Offline (`network_offline`) first waits for connectivity
   * instead of burning retry attempts against a dead link.
   */
  private async runBatch(
    units: readonly { readonly id: string; readonly text: string }[],
    candidates: readonly ProviderCandidate[],
    startIndex: number,
    document: DocumentRecord,
    options: BatchRunOptions = {},
  ): Promise<BatchOutcome> {
    const { signal, glossary, temperature } = options;
    let lastError: AppError | undefined;
    let lastProviderIndex = startIndex;
    let quotaCount = 0;
    let nonQuotaFailure: AppError | undefined;

    for (let offset = 0; offset < candidates.length; offset += 1) {
      const providerIndex = (startIndex + offset) % candidates.length;
      const candidate = candidates[providerIndex];
      if (!candidate) continue;
      let quotaBlocked = false;

      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_PROVIDER; attempt += 1) {
        if (signal?.aborted) return { kind: 'aborted' };
        try {
          const provider = await this.createProvider(candidate.providerId);
          const result = await provider.translate(
            {
              units,
              sourceLanguage: document.sourceLanguage,
              targetLanguage: document.targetLanguage,
              documentType: documentTypeHint(document),
              model: candidate.model,
              ...(glossary && glossary.length > 0 ? { glossary } : {}),
            },
            {
              ...(signal ? { signal } : {}),
              ...(temperature !== undefined ? { temperature } : {}),
            },
          );
          return {
            kind: 'done',
            providerIndex,
            providerId: candidate.providerId,
            model: result.model,
            keyId: result.keyId,
            translations: result.translations,
            usage: {
              input: result.usage.inputTokens,
              output: result.usage.outputTokens,
              cached: result.usage.cachedTokens ?? 0,
            },
          };
        } catch (error) {
          const appError = toAppError(error);
          if (signal?.aborted || appError.code === 'job_cancelled') return { kind: 'aborted' };
          lastError = appError;
          lastProviderIndex = providerIndex;
          logger.warn('Translation attempt failed', {
            documentId: document.id,
            providerId: candidate.providerId,
            model: candidate.model,
            attempt: attempt + 1,
            code: appError.code,
            retryable: appError.retryable,
          });

          if (appError.code === 'provider_quota_exceeded') {
            // Shared upstream quota: cool this provider's keys (the pool did),
            // try the next provider, and pause only if none are left.
            quotaBlocked = true;
            break;
          }
          if (
            appError.code === 'provider_invalid_key' ||
            appError.code === 'provider_invalid_model' ||
            (appError.code === 'provider_unavailable' && !appError.retryable)
          ) {
            // Pool/configuration problem for THIS provider only: fail over.
            break;
          }
          // Infrastructure problems must surface loudly, not be swallowed.
          if (appError.code === 'vault_locked' || appError.code === 'validation') throw appError;
          if (!appError.retryable) {
            // Content policy / malformed responses: fail this batch's units.
            nonQuotaFailure = appError;
            return { kind: 'error', error: appError, providerIndex };
          }

          // Offline (Phase 4 network rule): pause AI requests until
          // connectivity returns, then still back off normally before the
          // retry. Local work stays untouched and no attempt is wasted on a
          // dead link.
          if (appError.code === 'network_offline') {
            logger.info('Offline: waiting for connectivity before retry', {
              documentId: document.id,
              providerId: candidate.providerId,
              attempt: attempt + 1,
            });
            await this.waitForOnline(signal);
            if (signal?.aborted) return { kind: 'aborted' };
          }

          const waitMs = this.retryDelayMs(appError, attempt);
          logger.info('Waiting before translation retry', {
            providerId: candidate.providerId,
            attempt: attempt + 1,
            waitMs,
          });
          await this.wait(waitMs, signal);
          if (signal?.aborted) return { kind: 'aborted' };
        }
      }

      if (quotaBlocked) {
        quotaCount += 1;
      } else if (lastError && lastProviderIndex === providerIndex && !nonQuotaFailure) {
        // This provider failed for a non-quota reason (attempts exhausted or a
        // fail-over break above) - keep its error as the representative one.
        nonQuotaFailure = lastError;
      }
    }

    if (quotaCount > 0 && quotaCount === candidates.length && !nonQuotaFailure) {
      return { kind: 'quota', providerIndex: lastProviderIndex };
    }
    const finalError = nonQuotaFailure ?? lastError ?? new AppError('No provider could serve this batch', {
      code: 'provider_unavailable',
      retryable: false,
    });
    return { kind: 'error', error: finalError, providerIndex: lastProviderIndex };
  }

  private retryDelayMs(error: AppError, attempt: number): number {
    const backoff = backoffDelayMs({
      attempt,
      baseMs: RETRY_BASE_MS,
      maxMs: RETRY_MAX_MS,
      random: this.random,
    });
    const hint = (error.details as { nextAvailableAt?: number } | undefined)?.nextAvailableAt;
    if (typeof hint === 'number') {
      const untilHint = Math.max(0, hint - this.now());
      return Math.min(Math.max(backoff, untilHint), RETRY_MAX_MS);
    }
    return backoff;
  }

  private async markInProgress(unitIds: readonly string[]): Promise<void> {
    const timestamp = this.now();
    const records: TranslationUnit[] = [];
    for (const id of unitIds) {
      const unit = await translationUnitsRepo.get(id);
      if (!unit || unit.status === 'translated' || unit.status === 'reviewed') continue;
      records.push({ ...unit, status: 'in_progress', updatedAt: timestamp });
    }
    if (records.length > 0) await translationUnitsRepo.putMany(records);
  }

  private async markBatchTranslated(
    units: readonly { readonly id: string; readonly text: string }[],
    outcome: BatchSuccess,
    document: DocumentRecord,
  ): Promise<number> {
    const timestamp = this.now();
    const tokensPerUnit = Math.round(
      (outcome.usage.input + outcome.usage.output) / Math.max(units.length, 1),
    );
    const records: TranslationUnit[] = [];

    for (const planned of units) {
      const unit = await translationUnitsRepo.get(planned.id);
      if (!unit) continue;
      const translatedText = outcome.translations.get(planned.id);
      const produced = translatedText ?? unit.translatedText ?? '';
      records.push({
        ...unit,
        status: 'translated',
        translatedText: produced,
        // Remember the provider's own wording as the "AI suggestion" even if
        // a later manual edit replaces `translatedText`. Only reachable for
        // edited units via an explicit retranslate, which discards the old
        // human text on purpose (the engine never touches translated/reviewed
        // units on its own).
        aiText: produced,
        editedAt: null,
        provider: outcome.providerId,
        model: outcome.model,
        // Vault key id, never the key itself.
        keyId: outcome.keyId,
        estimatedTokens: unit.estimatedTokens ?? estimateTokens(unit.sourceText),
        actualTokens: outcome.usage.input + outcome.usage.output > 0 ? tokensPerUnit : null,
        error: null,
        updatedAt: timestamp,
      });
    }
    if (records.length === 0) return 0;
    await translationUnitsRepo.putMany(records);

    // Resume cursor: document-wide order index of the furthest completed unit.
    const lastRecord = records[records.length - 1];
    if (lastRecord) {
      await projectService
        .setLastProcessedUnit(document.projectId, lastRecord.orderIndex)
        .catch(() => undefined);
    }
    return records.length;
  }

  private async markBatchFailed(unitIds: readonly string[], error: AppError): Promise<number> {
    const timestamp = this.now();
    const records: TranslationUnit[] = [];
    for (const id of unitIds) {
      const unit = await translationUnitsRepo.get(id);
      if (!unit || unit.status === 'translated' || unit.status === 'reviewed') continue;
      records.push({
        ...unit,
        status: 'failed',
        retryCount: unit.retryCount + 1,
        estimatedTokens: unit.estimatedTokens ?? estimateTokens(unit.sourceText),
        error: {
          code: error.code,
          message: error.message,
          at: timestamp,
          retryable: error.retryable,
        },
        updatedAt: timestamp,
      });
    }
    if (records.length > 0) await translationUnitsRepo.putMany(records);
    return records.length;
  }

  /**
   * Opt-in translation-memory pre-fill (Phase 4): completes units from a
   * previous translation of the same source at auto-apply confidence and
   * returns their ids. Local-only work - no provider request, no usage
   * record - so it checks the abort signal between units (a pause stops it)
   * and re-reads each unit before writing (never clobbers a concurrently
   * completed unit).
   */
  private async applyTranslationMemory(
    pending: readonly TranslationUnit[],
    document: DocumentRecord,
    signal?: AbortSignal,
  ): Promise<Set<string>> {
    const filled = new Set<string>();
    const timestamp = this.now();

    for (const unit of pending) {
      if (signal?.aborted) break;
      const match = await translationMemoryService.best({
        projectId: unit.projectId,
        sourceText: unit.sourceText,
        targetLanguage: unit.targetLanguage,
        excludeUnitId: unit.id,
        minScore: MEMORY_THRESHOLDS.autoApply,
      });
      if (!match) continue;

      const current = await translationUnitsRepo.get(unit.id);
      if (!current || current.status === 'translated' || current.status === 'reviewed') continue;
      await translationUnitsRepo.put({
        ...current,
        status: 'translated',
        translatedText: match.translation,
        // No AI produced this text: provenance stays honestly null.
        provider: null,
        model: null,
        estimatedTokens: current.estimatedTokens ?? estimateTokens(current.sourceText),
        actualTokens: null,
        error: null,
        updatedAt: timestamp,
      });
      filled.add(unit.id);
    }

    if (filled.size > 0) {
      const lastOrder = pending
        .filter((unit) => filled.has(unit.id))
        .reduce((max, unit) => Math.max(max, unit.orderIndex), Number.NEGATIVE_INFINITY);
      if (Number.isFinite(lastOrder)) {
        await projectService
          .setLastProcessedUnit(document.projectId, lastOrder)
          .catch(() => undefined);
      }
      logger.info('Translation memory filled units', {
        documentId: document.id,
        count: filled.size,
      });
    }
    return filled;
  }
}

export { TranslationService };
export const translationService = new TranslationService();
