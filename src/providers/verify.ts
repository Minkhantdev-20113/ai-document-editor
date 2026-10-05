import { AppError } from '../core/errors/appError';
import { logger } from '../core/logging/logger';
import { providerFetchJson } from './transport';
import type { ProviderAdapter } from './types';

export type KeyVerification =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly error: AppError };

/**
 * Verifies a stored key against the provider's model-list endpoint.
 *
 * This is the only network call the app makes with a key in Phase 1. The key
 * is sent as a header, the URL never contains it, and neither the request nor
 * the response is ever logged with the secret included.
 */
export async function verifyKey(
  adapter: ProviderAdapter,
  apiKey: string,
  options: { baseUrl?: string | null; signal?: AbortSignal } = {},
): Promise<KeyVerification> {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: new AppError('No API key provided', { code: 'validation', retryable: false }),
    };
  }

  try {
    const url = adapter.probeEndpoint(options.baseUrl ?? undefined);
    const response = await providerFetchJson(url, {
      headers: adapter.buildHeaders(trimmed),
      method: 'GET',
      timeoutMs: 15_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      return { ok: false, error: adapter.mapError(response.status, response.body, response.headers).error };
    }

    const { models } = adapter.parseProbeResponse(response.body);
    logger.info('API key verified', {
      provider: adapter.descriptor.id,
      modelCount: models.length,
    });
    return { ok: true, models };
  } catch (error) {
    const appError =
      error instanceof AppError ? error : new AppError('Key verification failed', { cause: error, retryable: true });
    logger.warn('API key verification failed', { provider: adapter.descriptor.id, code: appError.code });
    return { ok: false, error: appError };
  }
}
