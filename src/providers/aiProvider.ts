import { AppError, toAppError } from '../core/errors/appError';
import {
  estimateMessagesTokens,
  estimateTokens,
} from '../domain/provider/tokens';
import {
  buildTranslationMessages,
  parseTranslationResponse,
  type DocumentTypeHint,
  type PromptUnit,
} from '../domain/provider/translationPrompt';
import type { GlossaryRule } from '../domain/glossary';
import type {
  CooldownReason,
  KeyHealth,
  SelectionRejection,
} from '../domain/provider/keySelection';
import { classifyProviderError, errorClassForCode, type ClassifiedProviderError, type ErrorClass } from './classify';
import { modelSupportsJsonMode } from './modelRegistry';
import { getAdapter } from './registry';
import { providerFetchJson } from './transport';
import { verifyKey, type KeyVerification } from './verify';
import type {
  CompletionRequest,
  CompletionUsage,
  ProviderDescriptor,
  ProviderId,
} from './types';

/**
 * The common provider interface every adapter exposes (Phase 3 spec):
 *
 *   validateKey · listModels · getCapabilities · estimateTokens ·
 *   generate · translate · getUsage · getRateLimitState · classifyError
 *
 * The factory keeps ALL provider-specific behaviour behind this interface -
 * UI code and the translation engine only ever talk to `AIProvider`. Key
 * selection, secret retrieval and outcome recording are delegated to the
 * injected runtime (implemented by `keyPoolService`), which keeps this module
 * free of storage/vault imports and trivially testable with fakes.
 */

export interface ProviderCapabilities {
  readonly chat: boolean;
  readonly vision: boolean;
  readonly jsonMode: boolean;
  readonly streaming: boolean;
  /** PDF support is only true when the model registry declares it (never assumed). */
  readonly pdf: boolean;
}

export interface GenerateOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly responseFormat?: 'json';
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface GenerateResult {
  readonly text: string;
  readonly model: string;
  readonly usage: CompletionUsage;
  readonly finishReason: string | null;
  /** Vault key id used for the call - never the key itself. */
  readonly keyId: string;
  readonly providerId: ProviderId;
  readonly structured: boolean;
}

export interface TranslationCall {
  readonly units: readonly PromptUnit[];
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly documentType: DocumentTypeHint;
  readonly model: string;
  /** Project glossary; the prompt marks these rules mandatory. */
  readonly glossary?: readonly GlossaryRule[];
}

export interface TranslationCallResult {
  readonly translations: ReadonlyMap<string, string>;
  readonly model: string;
  readonly keyId: string;
  readonly usage: CompletionUsage;
  readonly structured: boolean;
}

/** Why a provider currently has no usable key (drives engine + UI copy). */
export type PoolExhaustion = 'none' | 'rate_limited' | 'quota' | 'invalid' | 'no_keys';

export interface RateLimitState {
  readonly providerId: ProviderId;
  readonly keyId: string | null;
  readonly health: KeyHealth | null;
  readonly cooldownUntil: number;
  readonly cooldownReason: CooldownReason | null;
  readonly keys: {
    readonly total: number;
    readonly enabled: number;
    readonly eligible: number;
    readonly cooling: number;
    readonly invalid: number;
  };
  readonly exhaustion: PoolExhaustion;
  readonly nextAvailableAt: number | null;
  readonly checkedAt: number;
}

export interface ProviderUsageReport {
  /** `false` means the figures are locally recorded/estimated, not quota data. */
  readonly providerReported: boolean;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly asOf: number;
}

export interface KeySelectionRequest {
  readonly providerId: ProviderId;
  readonly model: string;
  readonly estimatedTokens: number;
}

export interface PoolSelection {
  readonly keyId: string | null;
  readonly reason: 'selected' | 'no_candidates' | 'all_rejected';
  readonly rejections: readonly { readonly keyId: string; readonly reason: SelectionRejection }[];
  readonly nextAvailableAt: number | null;
  readonly exhaustion: PoolExhaustion;
}

export interface KeyFailure {
  readonly error: AppError;
  readonly errorClass: ErrorClass;
  readonly retryAfterMs?: number;
  readonly tokens: number;
}

/** Storage-side runtime the factory needs. Implemented by `keyPoolService`. */
export interface KeyPoolRuntime {
  select(request: KeySelectionRequest): Promise<PoolSelection>;
  recordSuccess(keyId: string, outcome: { readonly tokens: number }): Promise<void>;
  recordFailure(keyId: string, failure: KeyFailure): Promise<void>;
  retrieveSecret(keyId: string): Promise<string | null>;
  rateLimitState(providerId: ProviderId, keyId?: string): Promise<RateLimitState>;
}

/** Usage-side reader. Implemented by `usageService`. */
export interface UsageAccess {
  totalsFor(providerId: ProviderId): Promise<ProviderUsageReport>;
}

export interface AIProvider {
  readonly id: ProviderId;
  readonly descriptor: ProviderDescriptor;
  /** Model used when no explicit choice was made (provider default). */
  readonly defaultModel: string | null;

  validateKey(apiKey: string, options?: { baseUrl?: string | null; signal?: AbortSignal }): Promise<KeyVerification>;
  listModels(options?: { signal?: AbortSignal }): Promise<readonly string[]>;
  getCapabilities(): ProviderCapabilities;
  estimateTokens(text: string): number;
  generate(request: CompletionRequest, options?: GenerateOptions): Promise<GenerateResult>;
  translate(call: TranslationCall, options?: GenerateOptions): Promise<TranslationCallResult>;
  getUsage(): Promise<ProviderUsageReport>;
  getRateLimitState(keyId?: string): Promise<RateLimitState>;
  classifyError(status: number, payload: unknown, headers?: Record<string, string>): ClassifiedProviderError;
}

export interface AIProviderOptions {
  readonly baseUrl?: string | null;
  readonly defaultModel?: string | null;
  readonly pool: KeyPoolRuntime;
  readonly usage: UsageAccess;
}

/** Maps a failed selection onto the typed error the engine acts on. */
function exhaustionError(selection: PoolSelection, providerLabel: string): AppError {
  const common = { provider: providerLabel, nextAvailableAt: selection.nextAvailableAt };
  if (selection.reason === 'no_candidates' || selection.exhaustion === 'no_keys') {
    return new AppError(`No API keys are configured for ${providerLabel}`, {
      code: 'provider_unavailable',
      retryable: false,
      details: common,
    });
  }
  switch (selection.exhaustion) {
    case 'quota':
      return new AppError('Provider quota exhausted', {
        code: 'provider_quota_exceeded',
        retryable: false,
        details: common,
      });
    case 'invalid':
      return new AppError(`Every ${providerLabel} key was rejected - re-verify the keys`, {
        code: 'provider_invalid_key',
        retryable: false,
        details: common,
      });
    case 'rate_limited':
      return new AppError(`${providerLabel} rate limits are active on every key`, {
        code: 'provider_rate_limited',
        retryable: true,
        details: common,
      });
    default:
      break;
  }

  const rejections = selection.rejections.map((entry) => entry.reason);
  if (rejections.length > 0 && rejections.every((reason) => reason === 'unsupported_model')) {
    return new AppError(`The model is not available on ${providerLabel}`, {
      code: 'provider_invalid_model',
      retryable: false,
      details: common,
    });
  }
  if (rejections.length > 0 && rejections.every((reason) => reason === 'verification_failed')) {
    return new AppError(`Every ${providerLabel} key was rejected - re-verify the keys`, {
      code: 'provider_invalid_key',
      retryable: false,
      details: common,
    });
  }
  // rpm/tpm windows or mixed rejections: waiting briefly is legitimate.
  return new AppError(`${providerLabel} has no eligible key right now`, {
    code: 'provider_rate_limited',
    retryable: true,
    details: common,
  });
}

/**
 * Creates the provider object for one provider id (Gemini first: its adapter
 * carries the richest error metadata, and every other provider is routed
 * through the same generic code paths).
 */
export function createAIProvider(providerId: ProviderId, options: AIProviderOptions): AIProvider {
  const descriptor = getAdapter(providerId, options.baseUrl).descriptor;
  const baseUrl = options.baseUrl ?? null;

  function adapter() {
    return getAdapter(providerId, baseUrl);
  }

  const provider: AIProvider = {
    id: providerId,
    descriptor,
    defaultModel: options.defaultModel ?? null,

    async validateKey(apiKey, validateOptions = {}) {
      return verifyKey(adapter(), apiKey, {
        baseUrl: validateOptions.baseUrl ?? baseUrl,
        ...(validateOptions.signal ? { signal: validateOptions.signal } : {}),
      });
    },

    async listModels(listOptions = {}) {
      const current = adapter();
      const response = await providerFetchJson(current.probeEndpoint(baseUrl ?? undefined), {
        headers: current.buildHeaders(''),
        method: 'GET',
        timeoutMs: 15_000,
        ...(listOptions.signal ? { signal: listOptions.signal } : {}),
      });
      if (!response.ok) {
        throw current.mapError(response.status, response.body, response.headers).error;
      }
      return current.parseProbeResponse(response.body).models;
    },

    getCapabilities() {
      const current = adapter();
      return {
        chat: current.descriptor.capabilities.chat,
        vision: current.descriptor.capabilities.vision,
        jsonMode: current.descriptor.capabilities.jsonMode,
        streaming: current.descriptor.capabilities.streaming,
        pdf: false, // per-model; resolved via the model registry by callers
      };
    },

    estimateTokens(text) {
      return estimateTokens(text);
    },

    async generate(request, generateOptions = {}) {
      const estimatedTokens = estimateMessagesTokens(request.messages);
      const selection = await options.pool.select({
        providerId: providerId,
        model: request.model,
        estimatedTokens,
      });
      if (!selection.keyId) throw exhaustionError(selection, descriptor.label);

      const keyId = selection.keyId;
      const secret = await options.pool.retrieveSecret(keyId);
      if (!secret) {
        throw new AppError('The vault is locked or the selected key is unavailable', {
          code: 'vault_locked',
          retryable: false,
        });
      }

      const current = adapter();
      const completionRequest: CompletionRequest = {
        ...request,
        ...(generateOptions.temperature !== undefined ? { temperature: generateOptions.temperature } : {}),
        ...(generateOptions.maxOutputTokens !== undefined
          ? { maxOutputTokens: generateOptions.maxOutputTokens }
          : {}),
        ...(generateOptions.responseFormat ? { responseFormat: generateOptions.responseFormat } : {}),
      };
      const url = current.completionEndpoint(completionRequest.model);
      const body = current.buildRequestBody(completionRequest);

      let response;
      try {
        response = await providerFetchJson(url, {
          headers: current.buildHeaders(secret),
          method: 'POST',
          body,
          ...(generateOptions.timeoutMs !== undefined ? { timeoutMs: generateOptions.timeoutMs } : {}),
          ...(generateOptions.signal ? { signal: generateOptions.signal } : {}),
        });
      } catch (error) {
        const appError = toAppError(error);
        if (appError.code === 'job_cancelled') throw appError; // user abort: no pool update
        await options.pool.recordFailure(keyId, {
          error: appError,
          errorClass: errorClassForCode(appError.code),
          tokens: estimatedTokens,
        });
        throw appError;
      }

      if (!response.ok) {
        const classified = current.mapError(response.status, response.body, response.headers);
        await options.pool.recordFailure(keyId, {
          error: classified.error,
          errorClass: classified.class,
          ...(classified.hints.retryAfterMs !== undefined ? { retryAfterMs: classified.hints.retryAfterMs } : {}),
          tokens: estimatedTokens,
        });
        throw classified.error;
      }

      const parsed = current.parseResponseBody(response.body, completionRequest.model);
      await options.pool.recordSuccess(keyId, {
        tokens: parsed.usage.inputTokens + parsed.usage.outputTokens,
      });

      return {
        text: parsed.text,
        model: parsed.model,
        usage: parsed.usage,
        finishReason: parsed.finishReason,
        keyId,
        providerId,
        structured:
          (generateOptions.responseFormat ?? completionRequest.responseFormat) === 'json',
      };
    },

    async translate(call, translateOptions = {}) {
      const messages = buildTranslationMessages(call.units, {
        sourceLanguage: call.sourceLanguage,
        targetLanguage: call.targetLanguage,
        documentType: call.documentType,
        ...(call.glossary && call.glossary.length > 0 ? { glossary: call.glossary } : {}),
      });
      // Structured output whenever *this model* supports it; the prompt itself
      // always requests JSON, so unsupported endpoints degrade gracefully.
      // Provider-level capability is no longer the right gate: OpenRouter as a
      // whole does not advertise JSON mode, but individual routes do - and the
      // ones that do not must keep `response_format` off.
      const wantsStructured = translateOptions.responseFormat
        ? true
        : modelSupportsJsonMode(providerId, call.model);

      const result = await provider.generate(
        {
          model: call.model,
          messages: [
            { role: 'system', content: messages.system },
            { role: 'user', content: messages.user },
          ],
          ...(translateOptions.maxOutputTokens !== undefined
            ? { maxOutputTokens: translateOptions.maxOutputTokens }
            : {}),
          ...(wantsStructured ? { responseFormat: 'json' as const } : {}),
        },
        {
          temperature: translateOptions.temperature ?? 0.2,
          ...(translateOptions.signal ? { signal: translateOptions.signal } : {}),
          ...(translateOptions.timeoutMs !== undefined ? { timeoutMs: translateOptions.timeoutMs } : {}),
        },
      );

      try {
        const translations = parseTranslationResponse(
          result.text,
          call.units.map((unit) => unit.id),
        );
        return {
          translations,
          model: result.model,
          keyId: result.keyId,
          usage: result.usage,
          structured: wantsStructured,
        };
      } catch (error) {
        // The HTTP call succeeded but the body violated the JSON contract.
        // Record it as a non-punitive failure (counters only, no cooldown) so a
        // chatty model response never wrongly cools a healthy key.
        const appError = describeContractFailure(toAppError(error), result);
        await options.pool.recordFailure(result.keyId, {
          error: appError,
          errorClass: 'rejected',
          tokens: result.usage.outputTokens,
        });
        throw appError;
      }
    },

    async getUsage() {
      return options.usage.totalsFor(providerId);
    },

    async getRateLimitState(keyId) {
      return options.pool.rateLimitState(providerId, keyId);
    },

    classifyError(status, payload, headers) {
      return classifyProviderError({ status, ...(headers ? { headers } : {}), ...describePayload(payload) });
    },
  };

  return provider;
}

/** Best-effort message/status extraction shared by classifyError callers. */
function describePayload(payload: unknown): { message?: string; providerStatus?: string } {
  if (typeof payload !== 'object' || payload === null) return {};
  const record = payload as Record<string, unknown>;
  const error = record['error'];
  if (typeof error === 'object' && error !== null) {
    const errorRecord = error as Record<string, unknown>;
    const message = errorRecord['message'];
    const status = errorRecord['status'];
    return {
      ...(typeof message === 'string' ? { message } : {}),
      ...(typeof status === 'string' ? { providerStatus: status } : {}),
    };
  }
  if (typeof error === 'string') return { message: error };
  if (typeof record['message'] === 'string') return { message: record['message'] as string };
  return {};
}

/**
 * Attaches *what the model actually answered* to a JSON-contract failure.
 *
 * `Translation response was not valid JSON` alone is undiagnosable: it hides
 * the model, the stop reason and the first line of the reply, which is exactly
 * what separates a refusal from a truncated answer from a prose summary. The
 * snippet is whitespace-collapsed and capped so an HTML error page can never
 * flood a toast or a job record.
 */
function describeContractFailure(error: AppError, result: GenerateResult): AppError {
  if (error.code !== 'provider_rejected') return error;
  const snippet = result.text.replace(/\s+/g, ' ').trim().slice(0, 240);
  const stop = result.finishReason ?? 'unknown';
  const reply = snippet ? `reply="${snippet}"` : 'reply=(empty)';
  return new AppError(`${error.message} [model=${result.model}; finish_reason=${stop}; ${reply}]`, {
    code: error.code,
    retryable: error.retryable,
    details: { ...(error.details ?? {}), finishReason: stop, responseSnippet: snippet },
    cause: error,
  });
}
