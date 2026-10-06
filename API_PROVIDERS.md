# API providers, BYOK and pricing labels

The application has **no paid-service dependency**: everything runs locally
and every AI request goes to a provider *you* configure, with a key *you*
own (BYOK). Nothing in this app is billed by us, and nothing here claims a
third-party tier is free forever.

## Providers

| Provider | Key page | Key format | Base URL | Rate-limit basis | Default guidance |
| --- | --- | --- | --- | --- | --- |
| Google Gemini (primary) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `AIza…` | `https://generativelanguage.googleapis.com/v1beta` | per-key | 15 RPM |
| Groq | [console.groq.com/keys](https://console.groq.com/keys) | `gsk_…` | `https://api.groq.com/openai/v1` | per-key | 30 RPM |
| OpenRouter | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) | `sk-or-v1-…` | `https://openrouter.ai/api/v1` | per-key | 20 RPM |
| OpenAI-compatible | your endpoint | your format | **required** | set by endpoint | none assumed |

**Why DeepSeek is not on this list:** it has no free tier, so there is no way
to try it without paying. It was removed in v0.6.0; a stored DeepSeek config or
key is deleted at the next load (usage history and the provider recorded on
already-translated units are kept - they record what happened).

Policies in `providers/catalog.ts` are **guidance, not guarantees**: limits
are provider-, account- and model-dependent and change without notice.
Confirm the current numbers on the provider's own page before you plan a big
run. The OpenAI-compatible adapter assumes *no* default limit, because the
app cannot know your endpoint's policy.

## API key management (BYOK)

1. **Add a key** — API Keys page: pick the provider, paste the key, optionally
   name it. The key is validated first (`validateKey`) and stored **only** in
   the encrypted `secretVault` store.
2. **Metadata is separate** — `apiKeyMetadata` keeps a masked hint
   (`AIza…4f2a`), verification status and timestamps. The raw key never
   appears in the UI, logs, error messages, URLs or sync payloads.
3. **Encryption** — AES-GCM via WebCrypto. By default a *device key*
   (non-extractable) is used; enabling a passphrase derives the key with
   PBKDF2 (310k iterations). The vault auto-locks after the configured idle
   timeout and can be locked manually.
4. **Use** — keys are sent only as request headers directly to the provider
   base URL you configured (never appended to a URL, never proxied by us).
   This is a browser-side client: only use keys you are comfortable running
   from a client app, and restrict their quota/scope at the provider.
5. **Rotate** — replace a key by saving a new value for the same row (or add
   a new row and disable the old one); per-key failover state resets cleanly
   when a key is enabled/disabled or reset. Rotation never requires a restart.
6. **Remove** — deleting a key removes the ciphertext and its metadata; usage
   history keeps only the masked id.

Providers ship **disabled**; enabling one and picking `enabledModels` gates
what the key pool may use, and the default model must stay inside that list.

## Free vs paid models — labels, not promises

The model registry (`providers/modelRegistry.ts`) carries per-model facts:
pricing, quality, speed, context window, max output and declared capabilities
(PDF/image/vision are never assumed — a missed capability is a missing badge,
an invented one would be a broken feature).

Labels are shown as badges and mean exactly this:

| Badge | Meaning |
| --- | --- |
| **FREE** | the provider documents no cost for this model (e.g. some `:free` routes) |
| **FREE TIER** | the provider offers a free quota, *with paid usage above it* — rate/volume limits apply |
| **PAID** | paid usage is the normal path (e.g. OpenRouter, OpenAI-compatible) |

Honesty rules baked into the app:

- we never claim "100% free" for a third-party API;
- every free-tier badge carries a "pricing can change, nothing is free
  forever" note;
- pricing facts are editable and importable/exportable as validated JSON, so
  you can correct them when a provider changes terms;
- if a model is not in the registry, it falls back to **PAID** (conservative).

Built-in examples: Gemini and Groq models are labelled **FREE TIER**;
OpenRouter and OpenAI-compatible models are labelled **PAID**.

## Quotas and rate limits

- **What we can and cannot see** — browsers cannot query provider quota. The
  app therefore combines: declared policy (RPM/TPM guidance), observed 429s,
  and usage the provider itself reports.
- **Per-key vs per-account vs per-model** — the policy `basis` is part of the
  catalog, so the UI can say plainly that a second key does not multiply an
  account-level quota.
- **Overrides** — per-provider rate-limit overrides (RPM/TPM) are settings
  rows on the Providers page; lower them if your plan is stricter than the
  catalog default.
- **Behavior on limits** — 429 → key cooldown honoring `Retry-After` →
  weighted failover to another healthy candidate → job pauses with
  "Provider quota exhausted" when nothing is available (never a silent retry
  storm).
- **Usage page** — per provider/key/model requests, tokens, errors, 429s and
  cooldowns, with token counts labelled *provider-reported* or
  *locally estimated*.

## VPN / network behavior

- The app itself needs no network; a VPN does not affect local work, analysis
  or export.
- A VPN, proxy or DNS filter that blocks a provider endpoint produces a typed
  `network`/`timeout` error: the run pauses or fails with a visible reason and
  continues normally once the endpoint is reachable again.
- If key validation fails while the provider itself is reachable, you get an
  `auth`/`invalid_key` error — that is a key problem, not a network one.

## Documentation

- Setup and general usage: [README.md](./README.md)
- Translation behavior: [TRANSLATION_PIPELINE.md](./TRANSLATION_PIPELINE.md)
- Offline mode and optional sync: [OFFLINE_FIRST.md](./OFFLINE_FIRST.md)
- Fixes and limitations: [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
