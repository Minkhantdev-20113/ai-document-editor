import { AppError } from '../core/errors/appError';
import { createGeminiAdapter } from './adapters/gemini';
import { createOpenAiCompatibleAdapter } from './adapters/openaiCompatible';
import { PROVIDER_CATALOG, PROVIDER_LIST, defaultBaseUrl } from './catalog';
import type { ProviderAdapter, ProviderDescriptor, ProviderId } from './types';

export function listProviderDescriptors(): readonly ProviderDescriptor[] {
  return PROVIDER_LIST;
}

export function getProviderDescriptor(providerId: ProviderId): ProviderDescriptor {
  const descriptor = PROVIDER_CATALOG[providerId];
  if (!descriptor) {
    throw new AppError(`Unknown provider: ${providerId}`, { code: 'validation', retryable: false });
  }
  return descriptor;
}

/**
 * Returns the adapter for a provider, bound to an optional custom base URL
 * (required for self-hosted OpenAI-compatible endpoints).
 */
export function getAdapter(providerId: ProviderId, baseUrl?: string | null): ProviderAdapter {
  const effectiveBase = baseUrl && baseUrl.trim() ? baseUrl.trim() : defaultBaseUrl(providerId);
  if (providerId === 'gemini') {
    return createGeminiAdapter({ baseUrl: effectiveBase });
  }
  const descriptor = getProviderDescriptor(providerId);
  if (descriptor.requiresBaseUrl && !effectiveBase) {
    throw new AppError('This provider requires a base URL', { code: 'validation', retryable: false });
  }
  return createOpenAiCompatibleAdapter(descriptor, { baseUrl: effectiveBase });
}

/** Cheap client-side format check; never sends the key anywhere. */
export function looksLikeKey(providerId: ProviderId, key: string): boolean {
  const descriptor = getProviderDescriptor(providerId);
  if (!descriptor.keyPattern) return key.trim().length >= 16;
  return descriptor.keyPattern.test(key.trim());
}
