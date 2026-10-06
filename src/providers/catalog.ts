import type { ProviderDescriptor, ProviderId } from './types';

/**
 * Static provider catalog: models, endpoints and rate-limit policies.
 *
 * Policies are intentionally written as guidance, not guarantees - limits are
 * provider, account and model dependent, and a second API key never multiplies
 * a per-account quota.
 */
export const PROVIDER_CATALOG: Readonly<Record<ProviderId, ProviderDescriptor>> = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    keyUrl: 'https://aistudio.google.com/apikey',
    // Google issues two shapes: the legacy Standard key (`AIza…`) and the
    // Auth key (`AQ.Ab…`) that AI Studio has issued exclusively since
    // mid-2026. Rejecting the new shape made every freshly created key look
    // "invalid" before a single request was sent.
    keyPrefix: 'AIza / AQ.',
    keyPattern: /^(?:AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z._-]{16,})$/,
    requiresBaseUrl: false,
    // Checked against ai.google.dev/gemini-api/docs/models (2026-10-01):
    // `gemini-2.0-flash` was shut down on 2026-06-01, and Google now only
    // serves the 2.5 line to accounts that used it before - a freshly issued
    // key would fail on it. These three are stable and current.
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', contextWindow: 1_048_576, maxOutputTokens: 65_536, recommended: true },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindow: 1_048_576, maxOutputTokens: 65_536 },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', contextWindow: 1_048_576, maxOutputTokens: 65_536 },
    ],
    rateLimit: {
      basis: 'per-key',
      requestsPerMinute: 15,
      notes:
        'Free tier limits are set per model and per project; paid tiers raise them substantially. Confirm the current numbers in Google AI Studio - they change without notice.',
    },
    capabilities: { chat: true, vision: true, jsonMode: true, streaming: true },
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    docsUrl: 'https://console.groq.com/docs',
    keyUrl: 'https://console.groq.com/keys',
    keyPattern: /^gsk_[0-9A-Za-z]{20,}$/,
    requiresBaseUrl: false,
    // Both `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` were shut
    // down on 2026-08-16 (Groq deprecation notice) and now return 404.
    // These are Groq's own recommended replacements.
    models: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', contextWindow: 131_072, maxOutputTokens: 65_536, recommended: true },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', contextWindow: 131_072, maxOutputTokens: 65_536 },
    ],
    rateLimit: {
      basis: 'per-key',
      requestsPerMinute: 30,
      notes:
        'Groq throttles per key and per model; sustained throughput depends on your plan. Raising the limit requires a plan change, not a second key.',
    },
    capabilities: { chat: true, vision: true, jsonMode: true, streaming: true },
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    docsUrl: 'https://openrouter.ai/docs',
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyPattern: /^sk-or-v1-[0-9a-f]{32,}$/,
    requiresBaseUrl: false,
    // `anthropic/claude-3.5-sonnet` and `google/gemini-2.0-flash-001` were
    // removed from OpenRouter (404 "No endpoints found for the requested
    // model"); ids below were re-checked against the live /api/v1/models list.
    models: [
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini', contextWindow: 128_000, maxOutputTokens: 16_384, recommended: true },
      { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5', contextWindow: 1_000_000, maxOutputTokens: 64_000 },
      { id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindow: 1_048_576, maxOutputTokens: 65_536 },
    ],
    rateLimit: {
      basis: 'per-key',
      requestsPerMinute: 20,
      notes:
        'OpenRouter rate limits are account based and increase after you add credit. Routing may use different upstream providers per request.',
    },
    capabilities: { chat: true, vision: true, jsonMode: false, streaming: true },
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    docsUrl: 'https://api-docs.deepseek.com/',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyPattern: /^sk-[0-9a-f]{32,}$/,
    requiresBaseUrl: false,
    models: [
      // The `deepseek-chat` / `deepseek-reasoner` aliases were retired on
      // 2026-07-24; current primary ids are `deepseek-flash` (V4.1 Flash) and
      // `deepseek-v4-pro` (both 1M context).
      { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', contextWindow: 1_048_576, maxOutputTokens: 65_536, recommended: true },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 1_048_576, maxOutputTokens: 65_536 },
    ],
    rateLimit: {
      basis: 'per-account',
      requestsPerMinute: 60,
      notes:
        'DeepSeek enforces account-level concurrency and rate limits; off-peak pricing does not change the limit.',
    },
    capabilities: { chat: true, vision: false, jsonMode: true, streaming: true },
  },
  openai_compatible: {
    id: 'openai_compatible',
    label: 'OpenAI-compatible',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    keyUrl: 'https://platform.openai.com/api-keys',
    requiresBaseUrl: true,
    baseUrlRequiredNote: 'Point this at any endpoint that speaks the OpenAI chat/completions format.',
    models: [
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', contextWindow: 128_000, maxOutputTokens: 16_384 },
      { id: 'gpt-4o', label: 'GPT-4o', contextWindow: 128_000, maxOutputTokens: 16_384 },
    ],
    rateLimit: {
      basis: 'per-key',
      notes:
        'Defined entirely by your endpoint. The app never assumes a default limit for self-hosted or third-party compatible servers.',
    },
    capabilities: { chat: true, vision: false, jsonMode: false, streaming: true },
  },
};

export const PROVIDER_LIST: readonly ProviderDescriptor[] = Object.values(PROVIDER_CATALOG);

export function defaultBaseUrl(providerId: ProviderId): string | null {
  switch (providerId) {
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta';
    case 'groq':
      return 'https://api.groq.com/openai/v1';
    case 'openrouter':
      return 'https://openrouter.ai/api/v1';
    case 'deepseek':
      return 'https://api.deepseek.com/v1';
    case 'openai_compatible':
      return null;
  }
}
