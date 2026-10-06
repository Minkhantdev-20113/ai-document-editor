import { AppError, type AppErrorCode } from '../core/errors/appError';

/**
 * Provider error taxonomy.
 *
 * Every transport-level failure is placed in exactly one class so the key pool
 * can react correctly. The class - not the raw HTTP status - decides whether a
 * key is cooled down, marked invalid, or left untouched, and whether the
 * request may be retried on another key at all:
 *
 * - `rate_limit`      429 from a per-minute window -> short cooldown, rotate keys.
 * - `quota_exceeded`  account/plan/daily/billing quota -> long cooldown; when it
 *                     hits every key of a provider the job pauses ("Provider
 *                     quota exhausted") instead of hot-looping.
 * - `auth`            401/403 or an explicit invalid-key message -> key health
 *                     becomes `invalid` (re-verify to restore).
 * - `invalid_model`   unknown/disabled model -> fix configuration, never rotate.
 * - `content_policy`  provider blocked the input -> fail the unit, never rotate
 *                     (a different key would receive the same content).
 * - `network`/`timeout`/`server_error` transient -> retryable with backoff.
 * - `rejected`        anything else -> non-retryable.
 */
export type ErrorClass =
  | 'rate_limit'
  | 'quota_exceeded'
  | 'auth'
  | 'invalid_model'
  | 'content_policy'
  | 'network'
  | 'timeout'
  | 'server_error'
  | 'rejected';

export interface RateLimitHints {
  /** Milliseconds to wait before this key may be used again, if the provider said so. */
  readonly retryAfterMs?: number;
  readonly limitRequestsPerMinute?: number;
  readonly remainingRequests?: number;
  readonly limitTokensPerMinute?: number;
  readonly remainingTokens?: number;
}

export interface ClassifiedProviderError {
  readonly class: ErrorClass;
  readonly error: AppError;
  readonly hints: RateLimitHints;
}

export interface ClassifyInput {
  readonly status?: number;
  /** Provider error message (already extracted from the payload by the adapter). */
  readonly message?: string;
  /** Provider-specific status string, e.g. Gemini's `error.status` (`RESOURCE_EXHAUSTED`). */
  readonly providerStatus?: string;
  readonly headers?: Record<string, string>;
}

const QUOTA_PATTERN =
  /insufficient[_ ]quota|exceeded your (current )?quota|quota[^.\n]{0,40}(exhaust|exceed)|billing|no credit|insufficient[_ ]credit|credit balance|insufficient balance|payment|plan and billing|per[- ]day|daily (limit|quota)|requests per day|tokens per day|resource has been exhausted/i;

const RATE_WINDOW_PATTERN = /per[- ]minute|per[- ]hour|\brpm\b|\btpm\b|too many requests|rate limit|first then wait/i;

const AUTH_PATTERN =
  /api[ _-]?key[^.\n]{0,40}(invalid|not valid|revoked|wrong|missing|incorrect)|invalid[ _-]?api[ _-]?key|unauthenticated|unauthorized|permission denied|incorrect api key|x-goog-api-key/i;

const INVALID_MODEL_PATTERN =
  /model (not found|does not exist|is not available|unavailable|not supported)|invalid model|unknown model|no such model|unsupported (model|value)|model.*(?:not found|does not exist)|does not support (model|the requested)/i;

const CONTENT_POLICY_PATTERN =
  /content polic|safety|blocklist|blocklisted|prohibited|harmful|dangerous content|responsible ai|content.*(violat|blocked)|prompt.*blocked|SAFETY|HARM_CATEGORY|PROHIBITED_CONTENT/i;

/** Parses `Retry-After` (seconds or HTTP-date) into a duration in ms. */
export function parseRetryAfter(value: string | undefined | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.round(Number(trimmed) * 1000));
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - now);
  }
  return undefined;
}

/**
 * Parses a reset value that providers express as either a duration in seconds,
 * a compact duration (`1m30s`), or an absolute unix timestamp.
 */
function parseResetValue(value: string | undefined | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();

  const compact = /^((\d+)h)?((\d+)m)?((\d+)s?)?$/.exec(trimmed);
  if (compact && compact[0] !== '' && /\d/.test(trimmed) && !/^\d+$/.test(trimmed)) {
    const ms =
      Number(compact[2] ?? 0) * 3_600_000 + Number(compact[4] ?? 0) * 60_000 + Number(compact[6] ?? 0) * 1000;
    return now + ms;
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return numeric > 1_000_000_000 ? numeric * 1000 : now + numeric * 1000;
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return date;
  return undefined;
}

function readHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lowered = name.toLowerCase();
  return headers[lowered] ?? headers[name];
}

function readNumber(headers: Record<string, string> | undefined, name: string): number | undefined {
  const raw = readHeader(headers, name);
  if (raw === undefined) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Extracts rate-limit signals from response headers.
 *
 * Recognised (lower-cased) names cover OpenAI/Groq style
 * `x-ratelimit-*`, OpenRouter, and Google's `x-ratelimit-reset-*` durations.
 * Unknown headers are ignored - hints are best-effort by design.
 */
export function parseRateLimitHeaders(headers: Record<string, string> | undefined, now: number): RateLimitHints {
  if (!headers) return {};
  const retryAfterMs = parseRetryAfter(readHeader(headers, 'retry-after'), now);
  const resetAt =
    parseResetValue(readHeader(headers, 'x-ratelimit-reset-requests'), now) ??
    parseResetValue(readHeader(headers, 'x-ratelimit-reset'), now);

  const hints: {
    retryAfterMs?: number;
    limitRequestsPerMinute?: number;
    remainingRequests?: number;
    limitTokensPerMinute?: number;
    remainingTokens?: number;
  } = {};
  if (retryAfterMs !== undefined) hints.retryAfterMs = retryAfterMs;
  else if (resetAt !== undefined) hints.retryAfterMs = Math.max(0, resetAt - now);

  const limitRequests = readNumber(headers, 'x-ratelimit-limit-requests');
  if (limitRequests !== undefined) hints.limitRequestsPerMinute = limitRequests;
  const remainingRequests = readNumber(headers, 'x-ratelimit-remaining-requests');
  if (remainingRequests !== undefined) hints.remainingRequests = remainingRequests;
  const limitTokens = readNumber(headers, 'x-ratelimit-limit-tokens');
  if (limitTokens !== undefined) hints.limitTokensPerMinute = limitTokens;
  const remainingTokens = readNumber(headers, 'x-ratelimit-remaining-tokens');
  if (remainingTokens !== undefined) hints.remainingTokens = remainingTokens;

  return hints;
}

function errorCodeFor(errorClass: ErrorClass): AppErrorCode {
  switch (errorClass) {
    case 'rate_limit':
      return 'provider_rate_limited';
    case 'quota_exceeded':
      return 'provider_quota_exceeded';
    case 'auth':
      return 'provider_invalid_key';
    case 'invalid_model':
      return 'provider_invalid_model';
    case 'content_policy':
      return 'provider_content_policy';
    case 'timeout':
      return 'provider_timeout';
    case 'network':
    case 'server_error':
      return 'provider_unavailable';
    case 'rejected':
      return 'provider_rejected';
  }
}

/**
 * Inverse mapping for errors that never reached HTTP classification
 * (transport-level timeout/offline/network failures). Used by the key pool so
 * a fetch failure updates counters the same way a classified response does.
 */
export function errorClassForCode(code: string): ErrorClass {
  switch (code) {
    case 'provider_rate_limited':
      return 'rate_limit';
    case 'provider_quota_exceeded':
      return 'quota_exceeded';
    case 'provider_invalid_key':
      return 'auth';
    case 'provider_invalid_model':
      return 'invalid_model';
    case 'provider_content_policy':
      return 'content_policy';
    case 'provider_timeout':
      return 'timeout';
    case 'network_offline':
      return 'network';
    case 'provider_unavailable':
      return 'server_error';
    default:
      return 'rejected';
  }
}

/**
 * Classifies a provider failure. Pure: same inputs always produce the same
 * class, which makes every branch unit-testable without a network.
 */
export function classifyProviderError(input: ClassifyInput): ClassifiedProviderError {
  const { status, providerStatus } = input;
  const message = input.message ?? '';
  const combined = `${message} ${providerStatus ?? ''}`;
  const hints = parseRateLimitHeaders(input.headers, Date.now());

  let errorClass: ErrorClass;

  if (status === 401 || status === 403 || /UNAUTHENTICATED|PERMISSION_DENIED/.test(providerStatus ?? '')) {
    errorClass = 'auth';
  } else if (status === 402) {
    // 402 Payment Required (OpenRouter's `insufficient_credit`, and the
    // equivalent "add credits" walls elsewhere) is a billing state, not a
    // rejection: treat it as quota so the run fails over to the next
    // provider - or pauses with a billing message - instead of marking the
    // batch non-retryable and failing the job.
    errorClass = 'quota_exceeded';
  } else if (status === 404 && INVALID_MODEL_PATTERN.test(combined) === false) {
    // A bare 404 from a chat endpoint normally means the model route is unknown.
    errorClass = 'invalid_model';
  } else if (INVALID_MODEL_PATTERN.test(combined)) {
    errorClass = 'invalid_model';
  } else if (CONTENT_POLICY_PATTERN.test(combined)) {
    errorClass = 'content_policy';
  } else if (status === 429 || /RESOURCE_EXHAUSTED|RATE_LIMIT_EXCEEDED/.test(providerStatus ?? '')) {
    errorClass = QUOTA_PATTERN.test(combined) && !RATE_WINDOW_PATTERN.test(combined) ? 'quota_exceeded' : 'rate_limit';
  } else if (status !== undefined && status >= 500) {
    errorClass = 'server_error';
  } else if (AUTH_PATTERN.test(combined)) {
    errorClass = 'auth';
  } else {
    errorClass = 'rejected';
  }

  const code = errorCodeFor(errorClass);
  const retryable = (['rate_limit', 'server_error', 'timeout', 'network'] as const).some(
    (candidate) => candidate === errorClass,
  );

  const fallbackMessage: Record<ErrorClass, string> = {
    rate_limit: 'The provider rate-limited the request',
    quota_exceeded: 'The provider quota is exhausted for this account',
    auth: 'The provider rejected the API key',
    invalid_model: 'The selected model is not available on this endpoint',
    content_policy: 'The provider blocked this content under its usage policy',
    network: 'The provider could not be reached',
    timeout: 'The provider did not respond in time',
    server_error: 'The provider had a temporary server error',
    rejected: 'The provider rejected the request',
  };

  const error = new AppError(message.trim() || fallbackMessage[errorClass], {
    code,
    retryable,
    details: {
      errorClass,
      ...(status !== undefined ? { status } : {}),
      ...(providerStatus ? { providerStatus } : {}),
      ...(hints.retryAfterMs !== undefined ? { retryAfterMs: hints.retryAfterMs } : {}),
    },
  });

  return { class: errorClass, error, hints };
}
