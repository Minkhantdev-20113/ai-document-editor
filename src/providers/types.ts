import type { ClassifiedProviderError } from './classify';

export const PROVIDER_IDS = ['gemini', 'groq', 'openrouter', 'deepseek', 'openai_compatible'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export interface ModelDescriptor {
  readonly id: string;
  readonly label: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  /** USD per 1M tokens. Kept as metadata only; costs are estimates. */
  readonly inputPricePerMillion?: number;
  readonly outputPricePerMillion?: number;
  readonly recommended?: boolean;
}

/**
 * Provider rate limits are provider/account/model dependent.
 * The `basis` field makes the assumption explicit: adding a second API key
 * does NOT multiply a per-account quota, so the app never reports a doubled
 * limit just because two keys are configured.
 */
export interface RateLimitPolicy {
  readonly basis: 'per-key' | 'per-account' | 'per-model';
  readonly requestsPerMinute?: number;
  readonly tokensPerMinute?: number;
  readonly requestsPerDay?: number;
  /** Human-readable, non-binding summary shown in the UI. */
  readonly notes: string;
}

export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly label: string;
  readonly docsUrl: string;
  readonly keyUrl: string;
  /** First characters of a valid key, used for non-sensitive format hints. */
  readonly keyPrefix?: string;
  readonly keyPattern?: RegExp;
  readonly requiresBaseUrl: boolean;
  readonly baseUrlRequiredNote?: string;
  readonly models: readonly ModelDescriptor[];
  readonly rateLimit: RateLimitPolicy;
  readonly capabilities: {
    readonly chat: boolean;
    readonly vision: boolean;
    readonly jsonMode: boolean;
    readonly streaming: boolean;
  };
}

export interface CompletionRequest {
  readonly model: string;
  readonly messages: readonly { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Ask the provider to enforce a JSON response body (when it supports it). */
  readonly responseFormat?: 'json';
}

export interface CompletionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens?: number;
}

export interface CompletionResult {
  readonly text: string;
  readonly model: string;
  readonly usage: CompletionUsage;
  readonly finishReason: string | null;
}

/**
 * Provider transport contract.
 *
 * Phase 1 implements request shaping, response parsing, error mapping and a
 * model-list probe (used to verify a stored key). The translation engine that
 * drives `complete()` is introduced in Phase 2.
 */
export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  buildHeaders(apiKey: string): Record<string, string>;
  buildRequestBody(request: CompletionRequest): unknown;
  parseResponseBody(payload: unknown, model?: string): CompletionResult;
  /** Classifies a non-2xx response: error class, typed AppError and rate-limit hints. */
  mapError(status: number, payload: unknown, headers?: Record<string, string>): ClassifiedProviderError;
  /** Endpoint used to verify that a stored key is accepted. */
  probeEndpoint(baseUrl?: string): string;
  /** Endpoint that performs a completion for the given model. */
  completionEndpoint(model: string): string;
  parseProbeResponse(payload: unknown): { models: string[] };
}
