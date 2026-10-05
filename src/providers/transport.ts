import { TRANSPORT_DEFAULTS } from '../config/appConfig';
import { AppError } from '../core/errors/appError';

export interface JsonResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
  /** Lower-cased response headers (rate-limit hints such as `retry-after`). */
  readonly headers: Record<string, string>;
}

export interface ProviderFetchOptions {
  readonly headers: Record<string, string>;
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Provider HTTP transport.
 *
 * Hard rules enforced here:
 * - the API key is only ever sent as a header (never appended to a URL),
 * - every request is bounded by a timeout and a caller abort signal,
 * - offline state produces a typed, retryable error before any network call.
 */
export async function providerFetchJson(url: string, options: ProviderFetchOptions): Promise<JsonResponse> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new AppError('You are offline', { code: 'network_offline', retryable: true });
  }
  if (!/^https:\/\//i.test(url)) {
    throw new AppError('Provider endpoints must use HTTPS', { code: 'validation', retryable: false });
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? TRANSPORT_DEFAULTS.requestTimeoutMs;
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onExternalAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await fetch(url, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: options.headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit',
    });

    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { raw: text.slice(0, 500) };
      }
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, ok: response.ok, body, headers };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      const timedOut = !options.signal?.aborted;
      throw new AppError(timedOut ? 'The provider did not respond in time' : 'Request cancelled', {
        code: timedOut ? 'provider_timeout' : 'job_cancelled',
        retryable: timedOut,
      });
    }
    throw new AppError('The provider could not be reached', {
      code: 'provider_unavailable',
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}
