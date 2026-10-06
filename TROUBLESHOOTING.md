# Troubleshooting and known limitations

Quick diagnosis for the failures people actually hit, the recovery path for
each, and an honest list of what this build does not do.

## How to see what happened

1. **Job card** — the queue (Dashboard / Export Center) shows state, attempt
   count, progress and the last typed error (`APP_ERROR_CODE` + message).
2. **Settings → Error log** — redacted, bounded `warn`/`error` history with
   scope, code and context. Raw API keys are never written (an aggressive
   redactor blanks even fields *named* like a secret).
3. **Usage page** — requests, tokens (`provider-reported` vs `locally
   estimated`), errors, 429s and cooldowns per provider/key/model.
4. **Browser DevTools** — everything runs locally, so console/network are the
   full picture.

## Startup, database and storage

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| App never leaves the loading state | IndexedDB unavailable (private window, blocked storage, disk full) | the shell shows a typed "IndexedDB unavailable" error; open a normal window, free disk space, then reload |
| Data "gone" after reopening | you are in a different browser profile/incognito, or storage was cleared | restore from a data-portability bundle (Settings → Data → Import) |
| Migration warning after an update | an older DB version is open in another tab | close other tabs of the app and reload; writes are never destroyed by an upgrade |
| Import rejected | malformed or partially written bundle | re-export from the source browser; import validates before writing and refuses rather than half-writing |

## Providers, keys and quotas

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| `provider_unavailable` when starting a translation | no enabled provider with a usable candidate key/model | add a key (API Keys), enable the provider, pick at least one `enabledModels` entry |
| `auth` / `invalid_key` on test | wrong key, revoked key, or key for another provider | re-add the key from the provider's key page; the test call is the source of truth |
| `quota_exhausted`, job paused with "Provider quota exhausted" | every candidate key is cooled down (429 with `Retry-After`, or account-level limit) | wait out the cooldown shown on the key, or add/enable another account's key — a second key does **not** multiply a per-account quota |
| 429s shortly after starting | declared RPM/TPM above your plan | lower the per-provider rate-limit overrides on the Providers page; the pool then stays under the limit |
| Repeated failures of one model only | provider-side outage or model retired | switch the model (model catalog is editable) or let failover pick the next candidate |
| OpenAI-compatible endpoint unreachable | missing/incorrect base URL, CORS, or the endpoint blocks browsers | set the exact base URL, check the endpoint allows browser calls, verify with the key test |
| A stored DeepSeek key/config disappeared | DeepSeek support was removed in v0.6.0 (no free tier), so nothing can select it any more | none needed — the config, key metadata and ciphertext are deleted on load; usage history stays on the Usage page |

Rate-limit policies in the catalog are **guidance, not guarantees** — confirm
current numbers with the provider (see [API_PROVIDERS.md](./API_PROVIDERS.md)).

## Network, VPN and offline

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| `network_offline` while translating | browser went offline | reconnect; the run waits and resumes from the first unfinished unit (no reload, no restart) |
| `timeout` on every provider call | VPN/proxy/DNS filter blocking the endpoint, or a slow network | allow the provider's host through the VPN/proxy, or disconnect it; retries then succeed |
| Works in one network, not another | captive portal or corporate filtering | test the provider URL directly in that network |
| Sync run reports an error | endpoint URL wrong, Apps Script not deployed as "Anyone", or offline | re-copy the `/exec` URL, redeploy with **Who has access: Anyone**, retry later — records stay `pending` |

## Jobs: stuck, failed, cancelled

- **Retry** on the job card resumes — translation re-enters at the first
  unfinished unit, export resumes from the last checkpointed page.
- **Refresh mid-run** is safe: `jobQueue.init()` recovers interrupted jobs to
  `queued` on the next load and the resume cursor survives.
- **A job keeps failing** — read the typed error on the card; `jobMaxAttempts`
  (default 5) bounds automatic retries so nothing loops forever.
- **Export failed** — the checkpoint is kept as `failed` with its finished
  pages; pressing retry re-renders **from that page**, not from page 1. If the
  document or options changed (plan signature mismatch) the run restarts
  cleanly instead of mixing geometries.
- **Export cancelled** — same story: the stored `rendering` checkpoint holds
  the finished pages for the next attempt.

## Export-specific

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| Download button disabled with a warning | validation found **errors** (structure, page count, language, missing text) | inspect the listed pages via the page links, re-export; use **Download anyway** only if you accept the defect — it is never automatic |
| Burmese looks like boxes / missing strokes | the selected Burmese font lacks those characters | Settings → Export fonts → switch to Noto Sans Myanmar; `glyph_missing` findings name the characters |
| Text clipped at a page edge | not possible by design — overflow is reflowed; a `block_continued`/`text_overflow` **warning** tells you the block moved to a continuation page | read the warnings, or turn off **Keep layout** for natural flow |
| Page count differs from the source | planned continuation pages were added for overflowing content (warning) or the file is defective (error) | warnings are expected for dense documents; errors block the download until accepted |
| Export takes a long time | large document: painting + a checkpoint every 10 pages + validation | progress shows page x/y; you can cancel and resume later without losing pages |
| The UI stays responsive during export | by design — all rendering runs in a Web Worker | — |
| DOCX opens with different margins than the PDF | the DOCX is reflowed text with one section per source page (size/orientation kept), not a pixel copy | use PDF when exact geometry matters |

## OCR: image-only pages

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| A page stays `needs_ocr` after re-running analysis | no model for the document's language (English and Burmese ship with the app), the page could not be rasterized (no `OffscreenCanvas` in that browser), or recognition found no usable text | the Analysis page states which case applies; the page is left empty instead of being filled with invented text |
| The first recognition takes a while | the OCR core (~4 MB) and the language model are fetched **once** from this app's own origin, then cached (IndexedDB + HTTP cache) | let it finish; later runs reuse the cache |
| Output is garbled | a small on-device LSTM model reading a low-resolution scan | correct the text in the editor — the source page image and the recognized blocks stay in sync through the normal unit checksums |

## Key vault

| Symptom | Recovery |
| --- | --- |
| "Vault locked" prompts | the auto-lock idle timeout elapsed — unlock with the passphrase (or device key); nothing is lost |
| Forgot the passphrase | keys cannot be decrypted (PBKDF2 by design). Re-add the keys; document data is unaffected |
| Keys missing after a browser reset | the vault is local; if you did not set a passphrase the device key lived in the browser profile. Re-add keys and restore content from a bundle |

## Known limitations

**Documents and analysis**

- OCR coverage: image-only pages are read on-device in **English and Burmese**;
  in any other language — or whenever rasterization/recognition fails — they
  stay `needs_ocr` and are never translated with invented text.
- PDF forms, annotations, signatures and embedded JavaScript are ignored on
  read and absent from export.
- Charts/figures are not re-drawn by the exporter; text and vector structure
  are.
- Very dense multi-column layouts can reorder imperfectly (the Analysis block
  table makes it visible).

**Translation**

- No streaming UI: one batch is one request/response.
- Document images are not sent to models — only extracted text and structure.
- Token/cost numbers are local estimates unless the provider reports usage.

**Export**

- Embedded fonts are re-mapped: Latin uses the standard Times/Helvetica/
  Courier fonts, Burmese uses a bundled OFL font (Padauk / Noto Sans
  Myanmar) — the original proprietary typefaces are not redistributed.
- The exported PDF carries text, layout, links and tables; it is not a
  pixel-identical copy of the source (that would be a patched original, which
  the pipeline deliberately avoids).
- Secondary formats are reflowed, not pixel-faithful: DOCX keeps page
  size/orientation via section breaks, HTML/TXT/MD are linear documents.

**Sync**

- Optional, manual and push-only: no pull/merge, metadata-only, never keys or
  document text (see [OFFLINE_FIRST.md](./OFFLINE_FIRST.md)).

**App**

- Single-user, browser-local: no collaboration/realtime co-editing.
- No account, no telemetry, no server of ours.

## Getting more help

- Design and data flow: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Providers, BYOK, pricing labels: [API_PROVIDERS.md](./API_PROVIDERS.md)
- Translation behavior: [TRANSLATION_PIPELINE.md](./TRANSLATION_PIPELINE.md)
- PDF inspection/analysis: [PDF_PIPELINE.md](./PDF_PIPELINE.md)
- Export details: [EXPORT_PIPELINE.md](./EXPORT_PIPELINE.md)
- Offline/sync: [OFFLINE_FIRST.md](./OFFLINE_FIRST.md)
