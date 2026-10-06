import type { ProviderDescriptor, ProviderId } from './types';

/**
 * Static provider catalog: models, endpoints and rate-limit policies.
 *
 * Policies are intentionally written as guidance, not guarantees - limits are
 * provider, account and model dependent, and a second API key never multiplies
 * a per-account quota.
 *
 * Provider support is deliberately short: DeepSeek was removed in 0.6.0
 * because it has no free tier, and this app only offers providers a user can
 * start with without paying. Re-adding one means updating `PROVIDER_IDS`
 * (types.ts), this catalog, `defaultBaseUrl`, `MODEL_META` (modelRegistry.ts)
 * and the docs - `providerCleanup` deletes stored state of anything else.
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
    // Checked against ai.google.dev/gemini-api/docs/models (2026-10-01): these
    // six are all the stable chat models on that list, and each model's own
    // page states 1,048,576 input / 65,536 output tokens plus text, image,
    // video, audio and PDF input. `gemini-2.0-flash` was shut down on
    // 2026-06-01 and Google only serves the 2.5 line to accounts that used it
    // before, so neither is offered; previews are left out because Google
    // renumbers them.
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', contextWindow: 1_048_576, maxOutputTokens: 65_536, recommended: true },
      { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', contextWindow: 1_048_576, maxOutputTokens: 65_536 },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', contextWindow: 1_048_576, maxOutputTokens: 65_536 },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindow: 1_048_576, maxOutputTokens: 65_536 },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', contextWindow: 1_048_576, maxOutputTokens: 65_536 },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', contextWindow: 1_048_576, maxOutputTokens: 65_536 },
    ],
    rateLimit: {
      // Google's docs: limits are applied per project, not per API key - so
      // two keys in one project share one window and must be measured together.
      basis: 'per-account',
      requestsPerMinute: 15,
      notes:
        'Google publishes no free-tier numbers, so treat this as guidance: the limits are per project (a second key adds none) and AI Studio shows your own. Reported Sep-Oct 2026: about 20 requests/day on the Flash models, about 500/day on Flash-Lite, ~5-15 RPM and ~250K input tokens/minute, with the daily quota resetting at midnight Pacific. Paid tiers raise all of them.',
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
    // down on 2026-08-16 (Groq deprecation notice) and now return 404, so no
    // Llama chat model is left to offer. Checked against
    // console.groq.com/docs/models and /rate-limits (2026-10): these three are
    // the chat models the free plan actually serves. `gpt-oss-safeguard-20b`
    // is free as well but is a safety classifier with a 3 RPM ceiling - far
    // too slow to translate a document with.
    models: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', contextWindow: 131_072, maxOutputTokens: 65_536, recommended: true },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', contextWindow: 131_072, maxOutputTokens: 65_536 },
      { id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B', contextWindow: 131_072, maxOutputTokens: 16_384 },
    ],
    rateLimit: {
      // Limits apply per organisation *and* per model, so one shared window
      // per account is the honest (conservative) reading for a key pool.
      basis: 'per-account',
      requestsPerMinute: 30,
      requestsPerDay: 1_000,
      notes:
        'Free plan, checked 2026-10: 30 RPM, 1,000 requests/day, 8K tokens/minute and 200K tokens/day for each chat model above - counted per organisation and per model, so a second key adds nothing and cached tokens do not count. The Developer plan raises every ceiling. Guidance, not a guarantee.',
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
    // Every id below was re-checked against the live /api/v1/model/<id> on
    // 2026-10-06 - that payload is where the context windows and max output
    // figures come from. `anthropic/claude-3.5-sonnet` and
    // `google/gemini-2.0-flash-001` were dropped earlier (404 "No endpoints
    // found for the requested model"). A `:free` variant is its own entry, and
    // the free list rotates: `qwen/qwen3.8-27b:free` was already gone the day
    // after it was listed, so re-check before depending on one.
    models: [
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini', contextWindow: 128_000, maxOutputTokens: 16_384, recommended: true },
      { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      { id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindow: 1_048_576, maxOutputTokens: 65_536 },
      // Zero-priced variants: $0 prompt/completion, published caps, one upstream.
      { id: 'thinkingmachines/inkling:free', label: 'Inkling (free)', contextWindow: 1_048_576, maxOutputTokens: 262_144 },
      { id: 'thinkingmachines/inkling-small:free', label: 'Inkling Small (free)', contextWindow: 1_048_576, maxOutputTokens: 262_144 },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra (free)', contextWindow: 1_000_000, maxOutputTokens: 65_536 },
      { id: 'nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning (free)', contextWindow: 1_000_000, maxOutputTokens: 65_536 },
      { id: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super (free)', contextWindow: 262_144, maxOutputTokens: 235_929 },
      { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B (free)', contextWindow: 262_144, maxOutputTokens: 32_768 },
    ],
    rateLimit: {
      // Account based: the ceiling starts low and rises once the account has
      // credit, so a second key does not lift it.
      basis: 'per-account',
      requestsPerMinute: 20,
      notes:
        'Account based, and it rises after you add credit. The `:free` models above run at 20 RPM and 50 requests/day (1,000/day once the account has bought $10 of credit), always through a single upstream, and the free list rotates without notice. Routing may also use a different upstream provider per request.',
    },
    capabilities: { chat: true, vision: true, jsonMode: false, streaming: true },
  },
  openai_compatible: {
    id: 'openai_compatible',
    label: 'OpenAI-compatible',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    keyUrl: 'https://platform.openai.com/api-keys',
    requiresBaseUrl: true,
    baseUrlRequiredNote:
      'Point this at any endpoint that speaks the OpenAI chat/completions format - for example Mistral (https://api.mistral.ai/v1, whose Experiment tier is free) or a local Ollama/vLLM server.',
    // Model ids are only suggestions: they must match what *your* endpoint
    // serves. The two GPT rows fit an OpenAI-shaped API; `mistral-small-latest`
    // is Mistral's alias for Mistral Small 4 (256K context, docs.mistral.ai,
    // checked 2026-10) and is listed in the free Experiment tier. There is no
    // universal id for a self-hosted server - take it from its /v1/models.
    models: [
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', contextWindow: 128_000, maxOutputTokens: 16_384 },
      { id: 'gpt-4o', label: 'GPT-4o', contextWindow: 128_000, maxOutputTokens: 16_384 },
      { id: 'mistral-small-latest', label: 'Mistral Small 4 (Mistral free tier)', contextWindow: 256_000, maxOutputTokens: 8_192 },
    ],
    rateLimit: {
      basis: 'per-key',
      notes:
        'Defined entirely by your endpoint. The app never assumes a default limit for self-hosted or third-party compatible servers - a local Ollama/vLLM server or Mistral Experiment tier costs nothing, but the RPM/TPM are whatever that endpoint publishes. Enter them as overrides on this page if you know them.',
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
    case 'openai_compatible':
      return null;
  }
}
