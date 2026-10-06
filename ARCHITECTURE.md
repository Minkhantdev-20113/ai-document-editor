# Architecture — AI Document Translator

This document explains how the application is put together and, more
importantly, *why* it is shaped this way. The three historical failures this
codebase is designed to prevent:

1. **Multiple API keys exhausting too quickly** → Phase 3 models limits as
   key/account/model/RPM/TPM dependent, selects keys by health-aware weighted
   scoring (never sequential rotation), cools keys down on 429 with
   `Retry-After`, and pauses jobs with a visible reason when a provider's
   shared quota is gone — the app never pretends a second key multiplies a
   quota.
2. **Exported PDFs losing language/layout** → export never patches text
   inside the original file: pages are rebuilt from the analysed block/bbox
   model (layout plan → per-page painting → validation) inside the export
   worker, with Burmese shaped by HarfBuzz and the font embedded once
   (Phase 5).
3. **UI freezing during export** → all heavy work runs in workers behind an
   RPC layer, driven by a persistent job queue; the main thread only renders.

## 1. Design principles

| Rule | How it is enforced |
| --- | --- |
| Local-first | Every read/write path goes through a repository over IndexedDB. Nothing requires the network. |
| Cloud sync is secondary | `syncService` only *queues* changes locally; pushing to the Apps Script endpoint is optional and configured by the user. |
| Resumable | Settings, jobs and documents are persisted before anything is announced; `jobQueue.init()` recovers interrupted jobs to `queued` on every load. |
| No heavy work on the main thread | Document analysis (PDF.js, text/DOCX parsing, layout) runs in `src/workers/analysis.worker.ts`; layout, shaping, page painting, PDF generation and container builds run in `src/workers/export.worker.ts`. The queue's handlers orchestrate, they don't compute. |
| BYOK, keys stay local | Keys are stored only in the encrypted `secretVault` store, sent only as request headers to the provider the user configured. |
| Never log secrets | `core/utils/redact.ts` scrubs anything key-like from logs and sync payloads; the logger is the single output path. |
| No fake functionality | Empty states are real (no data → no data). Job types without a handler fail loudly with `handler_missing`. |

## 2. Layering

```
pages/  components/            React UI (one file per route, shared widgets)
   │      hooks/               useAsyncData, useCollection, useJobs, useSettings
   ▼                            ▼  (loading/error state, events, derived state)
services/                      business logic: project, document, analysis
   │                            pipeline, OCR registry, editor, settings,
   │                            provider config, api keys, key pool, usage,
   │                            translation engine, model catalog, sync,
   │                            error log, data export/import
   ▼
db/repository.ts  ── schema.ts (store/index contract) ── entities.ts (types)
   ▼
db/database.ts  (single IndexedDB connection, upgrade path, error normalization)
```

Cross-cutting concerns live in `core/`:

- `core/errors/appError.ts` — `AppError` + the closed set of `AppErrorCode`
  values (every code has a localized message in both dictionaries).
- `core/logging/logger.ts` — centralized logging; `errorLogService` persists a
  redacted, capped tail of it into the `errorLogs` store for Settings →
  Diagnostics.
- `core/events/eventBus.ts` — `appEvents` with `*:changed` notifications.
  Views re-read through `useCollection(loader, deps, events)`, so services stay
  the single writer and components never reach into the database.
- `core/utils/redact.ts` — deep redaction used by both the logger and the
  sync queue.

**Rule of thumb:** components render, hooks observe, services decide,
repositories persist. A page never imports `db/database.ts`.

## 3. Data model (IndexedDB, 17 stores)

| Store | Holds |
| --- | --- |
| `projects` | project name, languages, status, progress, resume cursor (`lastProcessedUnit`), error/export state, notes |
| `documents` | source file metadata, optional local payload, inspection state, Phase 2 analysis progress, detected language, file metadata |
| `documentPages` | per-page geometry/rotation/counts, `status` (`pending/ready/failed/needs_ocr`), block count, error, `analyzedAt` (unique `documentId+pageIndex`) |
| `documentBlocks` | one row per extracted text block: reading order, bbox, font (size/family/weight/style), alignment, lines, heading/list/table/link, flags (unique `documentId+orderIndex`) |
| `translationUnits` | spec-shaped units (`translatedText`, `status`, `retryCount`, provider/model/key id, token estimates, `sourceChecksum`, Phase 4: `editedAt` human-edit stamp, `aiText` kept suggestion, `warnings` findings) (unique `documentId+orderIndex`, `pageId` index for resume) |
| `glossaryEntries` | per-project terminology rules: source term → preferred translation, optional forbidden wording/notes (`by_project` index) |
| `editorDocuments` | Tiptap HTML for the built-in editor |
| `settings` | one row per settings key (also mirrored to a tiny localStorage cache for pre-paint) |
| `providerConfigs` | endpoint, default model, enablement, rate-limit overrides |
| `apiKeyMetadata` | masked hint + verification status — never the raw key |
| `keyRuntime` | per-key failover state: health, cooldown (until + reason), request/token/success/failure/429 counters, last redacted error (`by_provider` index) |
| `jobQueue` | the persistent job records (state, progress, attempts, error) |
| `exportArtifacts` | one row per export job: `rendering/ready/failed` state, produced bytes, page counts, plan signature and the validation findings (`jobId` key, `by_project`/`by_document` indexes; excluded from JSON data bundles) |
| `usageSnapshots` | request/token/cost aggregates per provider+model+window |
| `syncQueue` | redacted change records waiting for the cloud endpoint |
| `errorLogs` | recent redacted warnings/errors for diagnostics |
| `secretVault` | AES-GCM ciphertext of secrets (local only, never synced) |

Indexes are declared once in `db/schema.ts` (`STORE_DEFINITIONS`) and mirrored
into the typed `AppDBSchema`, so the upgrade path and TypeScript agree.
`Repository<K>` is generic over the store name; `StoreValue<K>` derives the
value type from the schema.

## 4. Jobs

`src/domain/jobStates.ts` is a pure, exhaustively-checked state machine:

```
queued ──► analyzing ──► translating ──► exporting ──► completed
  │            │             │              │
  │            └──────► completed (analysis-only jobs)
  │                         │
  ▼                         ▼
paused ◄──────────────── retrying ◄──────── failed
  │                        ▲                 │
  └──► queued ─────────────┘                 │
  └──► cancelled ◄───────────────────────────┘
completed / cancelled are terminal.
```

- `canTransition(from, to)` validates **every** transition; an illegal jump
  throws `invalid_transition` instead of corrupting a record.
- `jobQueue` writes the transition to IndexedDB **before** emitting
  `jobs:changed`, so what the UI shows is what is persisted.
- On start, a job moves to its active state (`activeStateFor(type)`), bumps
  `attempts`, and runs its handler with an `AbortSignal` (pause/cancel/
  timeout) plus `progress()` and `transition()` helpers.
- Failures are classified: retryable → `retrying` with exponential backoff
  (1.5s base, capped at 60s, up to `maxAttempts`), otherwise → `failed` with a
  structured `lastError`.
- **Refresh recovery:** `bootstrapJobs()` → `jobQueue.init()` scans for jobs in
  active states, resets them to `queued`, increments `interruptions`, and
  reschedules. Nothing is ever lost.
- A job type with no registered handler fails immediately with
  `handler_missing` — silent fake success is explicitly not allowed.

`inspect_document` and `translate_document` are the two real handlers:
they drive the analysis pipeline (below) and the batched translation engine
(below). The other types exist in the enum and fail loudly until their
phases wire them.

### The `inspect_document` pipeline (Phase 2)

`jobs/handlers/inspectDocument.ts` delegates to
`services/documentAnalysisService.analyzeDocument()`, which:

1. opens the stored payload through an `AnalysisSource` (Web Worker in the
   browser, in-process in tests — identical code path),
2. seeds the run with `documentService.beginAnalysis()` (page count, metadata,
   `pending` placeholders, progress counters that *include* pages analyzed by
   earlier runs),
3. walks pages in order, **skipping** any page already persisted as
   `ready`/`needs_ocr` (so a refresh or timeout resumes instead of redoing),
   with one immediate retry per page before it is recorded as `failed`
   (`markPageFailed`) and the run moves on,
4. persists each successful page through `applyPageAnalysis()` — blocks, then
   units, then the page record last as the commit marker; units whose
   `sourceChecksum` is unchanged are kept verbatim, so re-analysis never
   discards translations,
5. runs language detection over the persisted text (`sampleText` →
   `detectLanguage`) and syncs the result onto the units,
6. recounts all counters from the page records (`finishAnalysis`).

Progress is emitted per page as `analysis:progress` (stage, task, page x/y,
block count, failures) and drives both the job record and the Analysis page.
An abort stops **between** pages; nothing half-written is visible on resume
because the page record is the last row written for a page.

Timeouts: analysis jobs enqueue with a `jobTimeoutMs` payload override
(600s vs. the 120s default); the queue aborts, the handler returns
gracefully, and the next attempt resumes.

### The `translate_document` pipeline (Phases 3–4)

`jobs/handlers/translateDocument.ts` delegates to
`services/translationService.translateDocument()`, which:

1. pre-flights through `actions.startTranslation` (document exists, at
   least one enabled provider with a usable candidate — otherwise the job is
   rejected *before* it enters the queue, with a typed `provider_unavailable`),
2. loads all units for the document and plans batches that fit the selected
   model's context/output budgets (Burmese expansion ratios included; an
   oversized unit is flagged and attempted alone). The workflow's strategy
   (`draft/standard/precise`) selects the batching quality and the sampling
   temperature (0.4/0.2/0.1),
3. walks batches in order, marking each unit `in_progress` before the call
   and `translated`/`failed` immediately after — per-unit persistence means a
   crash or refresh costs at most the in-flight batch,
4. for each batch, tries candidates in order (Gemini first) with the weighted
   key pool inside each provider: retryable errors (429/timeout/network) back
   off with jitter and re-attempt, configuration errors (invalid key/model)
   fail over to the next provider immediately, content-policy failures mark
   the batch failed with a typed reason,
5. when **every** candidate is quota-blocked — fresh or still cooling — the
   engine returns `paused_quota` and the handler calls
   `jobQueue.pause(id, reason)`, persisting "Provider quota exhausted…" as
   the job's `lastError` so the UI explains the wait; resume is the normal
   `paused → queued` path and re-enters at the first unfinished unit,
6. records usage per batch with a `basis` (`provider_reported` when the
   provider returned usage, `locally_estimated` otherwise).

Phase 4 wraps the same loop with workflow concerns: the project glossary is
loaded **once** per run and sent with every batch (omitted when empty, so
mid-run glossary edits never mix conventions); opt-in translation memory
(`memoryAutoApply`, default off) fills high-confidence matches locally with
honest null provenance before any request; an offline error
(`network_offline`) waits for connectivity instead of burning retries;
every batch broadcasts `translation:progress` (page x/y, unit x/y, batch
x/y, provider, model and the vault key id — never the key) bridged onto
the app event bus; and a completed run is validated so findings are
persisted onto units (`validationService`) for the editor to display —
never auto-fixed.

An abort (pause/cancel/timeout) is checked between batches and stops the run
cleanly; the signal check happens **before** the next batch is marked, so
nothing is left half-written.

Timeouts: translation jobs enqueue with `translationJobTimeoutMs`
(30 min) because a large document is many provider round-trips.

### The `export_document` pipeline (Phase 5)

`jobs/handlers/exportDocument.ts` delegates to
`services/exportService.runExport()`, which:

1. builds the **translated document model** from the analysed pages/blocks and
   their units (`buildExportDocument`): translations joined by block id,
   source text kept as the fallback, blocks in reading order — a block with no
   translation stays in the model and is *reported*, never dropped,
2. reads the previous checkpoint (`exportArtifacts` keyed by job id) and
   prunes artifacts of jobs that already finished, so a document only keeps
   the artifact it can actually download,
3. asks the **export worker** for the layout plan (`layoutPlan`: keepLayout
   reflow vs natural flow, page size/order/margins, headings, lists, tables,
   links) and receives only counts, warnings and a plan signature — the plan
   itself never crosses the worker boundary,
4. paints pages in order (`ExportPdfSession.paintPage` rejects an
   out-of-order index and drops a half-painted page if it throws) while
   serializing a **checkpoint every 10 pages**, so a crash keeps every
   finished page,
5. finishes the PDF (title/producer metadata; the Burmese font embedded once
   with `subset: false`, Latin runs using the standard fonts) and runs
   validation *in the worker*: plan-vs-artifact page count, blank pages
   (per-page `Tj/TJ` content probe), target language, title, and every
   untranslated block,
6. persists bytes first, then the findings, and returns them — the Export
   Center refuses to download a file with an `error` finding until the user
   accepts it explicitly; warnings never block.

A retry resumes from `renderedPages` **only when the plan signature matches**
(document, page geometry and options are part of the signature, otherwise the
run restarts from page 1). Abort persists the checkpoint as `rendering` and
returns `{ aborted: true }`; a crash persists it as `failed` before the queue
sees the error. Secondary formats (docx/html/txt/md/json) skip the layout plan
and render in one worker `format` call with their own container probe.

## 5. Workers

- `workers/rpc.ts` — typed request/response protocol over `postMessage` with
  correlation ids, timeouts, and error propagation (an `AppError` thrown in
  the worker arrives as an `AppError` on the main thread).
- `workers/analysis.worker.ts` — the worker entry: one stateful
  `AnalysisSession` per connection (`open` → `page(i)` × n → `close`).
- `workers/analysisProtocol.ts` — the request/response types shared by both
  sides; the client never imports the worker entry, so bundling stays clean.
- `workers/analysisClient.ts` — `createWorkerAnalysisSession()` spawns the
  worker, exposes the `AnalysisSource` interface (stateful RPC session), and
  always disposes (`close()` → RPC teardown → worker terminate).
- `workers/analysisSession.ts` — the **same** session logic run in-process;
  tests inject it (plus the `source.ts` seam) to exercise the identical
  pipeline without a browser.
- `workers/pdfExtract.ts` — PDF.js-specific extraction (pages, images via a
  CTM stack, text runs → `BlockIR`), used only inside the worker.
- `domain/analysis/*` — pure pipeline stages: `lines` → `layout` →
  `readingOrder` → `structure` → `pipeline`, plus `textFormats` (txt/md/
  html/csv/json), `docx` (unzip + XML via `core/utils/zip.ts`),
  `languageDetect`, and the `ir` types both sides share.
- `workers/export.worker.ts` + `workers/exportProtocol.ts` +
  `workers/exportClient.ts` — the same RPC/session pattern for exports:
  `createExportWorkerSession()` spawns a worker owning one `ExportPdfSession`
  (`prepare` → `paint(i)` × n → `checkpoint` → `finish` → `validate`), plus a
  stateless `format` request for secondary formats. The client applies a
  5-minute RPC timeout, an idle auto-terminate and `close()` → terminate, so
  no worker outlives its job.
- `workers/exportPdfRenderer.ts` — `ExportPdfSession`: pdf-lib + fontkit +
  HarfBuzz shaping for Myanmar, per-page content painting, actionable-link
  filtering and checkpoint serialization (`doc.save()`), with the full
  Burmese font embedded once per export (`subset: false`).
- `workers/exportPdfValidator.ts` — the pre-download probe, run in the worker:
  `%PDF-` header, page count and per-page text detection, mapped back to
  plan page indexes; bytes are transferred, never strings.
- `domain/export/*` — the pure export domain: `fonts` (roles, Myanmar glyph
  coverage, bundled font catalog), `textLayout` (measure/wrap),
  `layoutPlan` (overflow → reflow → continuation pages), `secondaryFormats`
  (txt/md/html/json + `docx.ts`, both built on `core/utils/zip.ts`), and
  `validateExport` (findings, blocking vs warning).

The worker chunk is emitted separately (~3.3 MB of PDF.js) so the app shell
stays small; it is only downloaded when a document is actually analyzed. The
export worker chunk (pdf-lib + fontkit + HarfBuzz + the Burmese fonts) is
loaded only when an export actually runs.

## 6. Providers (BYOK adapters, key pool, model registry)

```
providers/catalog.ts       data: providers, models, capabilities, rate-limit policy
providers/registry.ts      id → descriptor lookup used by the UI
providers/types.ts         ProviderDescriptor, RateLimitPolicy, capability flags
providers/transport.ts     header-only auth (key never appended to a URL), timeouts
providers/verify.ts        "is this key valid?" check per provider
providers/classify.ts      shared error taxonomy (429/quota/auth/model/timeout/…)
providers/adapters/        gemini.ts, openaiCompatible.ts (Groq/OpenRouter/DeepSeek)
providers/aiProvider.ts    the common AIProvider contract + factory seams
providers/modelRegistry.ts per-model facts, pricing, overlay validation
```

- Gemini is primary; Groq, OpenRouter and DeepSeek reuse the OpenAI-compatible
  adapter with their own catalog entries, endpoints and policies.
- Every adapter implements the same contract: `validateKey · listModels ·
  getCapabilities · estimateTokens · generate · translate · getUsage ·
  getRateLimitState · classifyError`. All errors flow through
  `classifyProviderError()` so the engine only reasons about classes
  (`rate_limited`, `quota`, `auth`, `invalid_model`, `timeout`, `network`,
  `server`, `content_policy`), never about provider-specific payloads.
- The UI is data-driven: enablement, default model, base URL and rate-limit
  overrides are `providerConfigs` rows, not code branches. Providers ship
  disabled; `enabledModels` gates which models the pool will accept, and
  `save()` keeps the default model inside that list.
- `RateLimitPolicy.basis` (`per-key | per-account | per-model`) exists so the
  app can never claim that configuring a second key doubles a per-account
  quota.

**The key pool (`services/keyPoolService.ts` + `domain/provider/keySelection.ts`).**
Selection is weighted, never round-robin: hard gates (disabled, failed
verification, cooling, unsupported model, RPM/TPM exhausted) remove unusable
keys first, then a weighted score over health, recency, success rate and
recent 429s picks among the rest (seeded RNG in tests). Failures update
`keyRuntime` and set a cooldown whose length depends on the error class:
`Retry-After`/jittered backoff for 429 (max 5 min), doubling ≥15 min → 6 h
for quota, backoff from consecutive failures for server errors, and no
cooldown for auth failures (the key is marked `invalid` instead).
`rateLimitState()` derives pool-level exhaustion — `no_keys`, `quota`,
`rate_limited`, `verification` — which the translation engine uses to pause
safely instead of burning attempts.

**The model registry (`providers/modelRegistry.ts`).**
One data source answers "what is this model, what can it do, what does it
cost": pricing type (FREE / FREE TIER / PAID with `freeTier`/`paid` flags),
context/output windows, quality/speed levels and capability flags. PDF,
image and vision support are only ever read from an explicit declaration —
never inferred — and catalog imports are validated (`validateOverlay`)
against known providers, models, fields and enums before being persisted
(`modelCatalogService`, settings-backed, re-validated on load).

## 7. Security

- **Vault (`security/keyVault.ts`)** — secrets are encrypted with AES-GCM.
  The data-encryption key comes from either a passphrase (PBKDF2, 310k
  iterations, per-vault salt) or a random device key in localStorage
  (`device` mode default). Both are behind one `KeyVault` interface so the
  scheme can be upgraded (WebAuthn, Argon2) without touching callers. The
  vault auto-locks after the configured idle time and distinguishes
  `vault_locked` from `vault_wrong_passphrase`.
- **What leaves the browser** — only provider requests you trigger, with the
  key in a header; and, if you enable sync, deep-redacted records to your own
  Apps Script endpoint. Keys never reach Google Sheets, logs or error
  messages.
- **Metadata vs. secret** — `apiKeyMetadata` stores a masked hint
  (`AIza••••1w2e`), status and timestamps; the ciphertext lives only in
  `secretVault`.

## 8. State, rendering and events

- `useAsyncData(loader, deps, {enabled})` normalizes every read: cancellation,
  error normalization, `reload()`. Loading is **derived** from the key of the
  last settled load (version + deps), so effects never write state
  synchronously — the strict React hooks lint rules are satisfied by design.
- `useCollection(loader, deps, events)` adds event-driven invalidation; the
  analysis pipeline also broadcasts `analysis:progress` (stage, task, page
  x/y, block count) so progress views update without polling. The
  translation engine broadcasts `translation:progress` the same way
  (page/unit counters, provider/model, masked key id), and unit/glossary
  changes flow through `units:changed` / `glossary:changed`.
- Page-local edits (project notes, editor title, provider drafts) are keyed to
  the entity they belong to and merged at render time, so a background reload
  can never clobber typed input.
- Toasts, error boundaries (`app` + per-route with `resetKey`) and the offline
  banner in the shell cover the failure surfaces.

## 9. i18n

- `i18n/dict/en.ts` is the source of truth; `Dictionary = WidenLiteral<typeof
  en>` forces `my.ts` to match key-for-key at compile time.
- Burmese is the default locale, written by hand (not machine-translated).
- Missing keys render the key itself and warn in dev.
- `src/i18n/dict.test.ts` additionally scans every `t('…')` call site and every
  `AppErrorCode` so a key can never silently disappear.

## 10. Theming and responsiveness

- Design tokens in `styles/tokens.css`; dark mode is a `[data-theme='dark']`
  override, so there are exactly two palettes to keep in sync.
- A pre-paint inline script in `index.html` reads the cached settings
  (`adt.theme`) and sets `data-theme`/`color-scheme` before the first paint —
  no wrong-theme flash. `useTheme()` then follows the OS preference while
  `system` is selected.
- Desktop-first CSS with breakpoints at 1100/1080/1024/960/900/720/640px;
  below 1024px the sidebar becomes a drawer (opened by the header button,
  closed by navigation, scrim click or browser back).

## 11. Sync (secondary)

`syncService.queueChange()` records an entity change in `syncQueue` with a
deep-redacted payload and deduplicates per entity. When an Apps Script
endpoint and `syncEnabled` are configured, queued records are pushed with
attempt tracking and `failed` status for later retry. Local data is always
authoritative; sync can be off (the default) forever.

## 12. Testing

- **Unit** — `domain/jobStates.test.ts` covers the full transition table;
  `domain/analysis/*` tests cover line grouping, layout/columns, reading
  order, structure classification, and every text-format parser.
- **Fixtures** — `test-fixtures/pdfFixtures.ts` builds real PDFs in memory
  (normal, paragraphs, headings, lists, tables, mixed fonts, Burmese, rotated,
  scanned) so `workers/analysisSession.test.ts` asserts pipeline output on
  genuine documents — no recorded snapshots, no fake data.
- **Pipeline driver** — `services/documentAnalysisService.test.ts` runs the
  full persist/resume loop against `fake-indexeddb`: happy path (pages,
  blocks, units, detection, done state), per-page failure isolation with
  retry, abort → resume from the first unanalyzed page, unit preservation
  across re-analysis (checksum), and file validation rejections.
- **Persistence** — `db/repository.test.ts` runs against `fake-indexeddb`:
  CRUD, bulk ops, index queries (including the `projectId: null` not-indexed
  behavior) and error normalization.
- **Queue** — `jobs/jobQueue.test.ts` exercises refresh recovery, run to
  completion, pause/resume/cancel, missing-handler failure and manual retry.
  (It caught a real bug: `analyzing → completed` was missing from the
  transition table, which would have failed every analysis-only job.)
- **Routing** — `routes/AppRoutes.test.tsx` mounts all 15 routes in jsdom and
  asserts the localized page title, the shell, and the 404 view.
- **Settings** — `services/settingsService.test.ts` proves theme/language
  changes reach IndexedDB *and* the localStorage cache the pre-paint script
  reads, so a reload keeps the chosen theme and language.
- **i18n** — dictionary parity and call-site coverage.
- **Provider classification** — `providers/classify.test.ts` walks the whole
  Phase 3 taxonomy (429 vs quota vs insufficient quota vs auth vs invalid
  key/model vs timeout vs server vs content policy, Retry-After headers).
- **Failover domain** — `domain/provider/*` cover backoff bounds and jitter,
  script-aware token estimates, weighted key selection gates/seeded picks,
  batch budgets (context/output limits, Burmese expansion, oversized units,
  order preservation) and prompt building/parsing with the Burmese
  preservation rules.
- **Key pool** — `services/keyPoolService.test.ts` (14): cooldown policy per
  error class, `Retry-After`, quota doubling, exhaustion derivation,
  multi-key weighted selection, enable/reset lifecycle, and **no raw key
  material in logs** across the full lifecycle (the aggressive redactor even
  blanks `keyId` field names).
- **Translation engine** — `services/translationService.test.ts` (23):
  happy path + usage recording, resume/skip of translated units, bounded 429
  retry, timeout/network recovery, failover on a rejected key, failed-units →
  recovery, refresh mid-run (32 units kept, the remaining 8 re-sent exactly
  once), quota pause fresh and while keys stay cooled, unconfigured provider
  failing loudly, oversized units attempted alone — plus Phase 4: glossary
  sent/omitted, memory pre-fill opt-in, strategy temperature per request,
  post-run validation persistence, AI-suggestion capture, offline
  wait-then-retry, progress payload (pages/key id), mixed-language technical
  documents, and manual edits surviving later runs.
- **Phase 4 domains/services** — `domain/glossary` + `glossaryService`
  (validation, duplicate rejection, rules), `domain/translationMemory` +
  service (Burmese-safe similarity, thresholds, deterministic suggestions),
  `domain/validation` + `validationService` (every check code, findings
  persisted without auto-fixes, unit-level revalidation), `unitsService`
  (manual edits stamping, review gating, explicit retranslation),
  `documentService.setTargetLanguage`, `config/languages` target list, and
  prompt glossary sections with token-cost accounting.
- **Registry/catalog** — `providers/modelRegistry.test.ts` (9) and
  `services/providerConfigService.test.ts` (4): every registry field, PDF
  never assumed, overlay validation rejecting unknown providers/models/
  fields/enums, coherent pricing flags, the `defaultModel ∈ enabledModels`
  invariant, https enforcement.
- **Phase 5 export** — `domain/export/*` (font roles/glyph coverage, text
  wrapping, layout plan with overflow → continuation pages, `validateExport`
  blocking vs warning, secondary renderers incl. a DOCX round-trip through
  `readZipEntries` and restorable JSON), `core/utils/zip.test.ts` (writer ↔
  reader round-trip, CRC-32), `workers/exportPdfRenderer.test.ts` (real
  rendering: Burmese + Latin, checkpoint resume, one font embed),
  `workers/exportPdfValidator.test.ts` (healthy, corrupt, language
  mismatch) and `services/exportService.test.ts` (fake IndexedDB + a
  scripted session: happy path, crash → `failed` checkpoint → resume from
  the failed page, cancel, periodic checkpoint, secondary format).

## 13. Where the next phases plug in

- **Translation workflow/editor — delivered in Phase 4** — units carry
  statuses (`pending → in_progress → translated → reviewed`), the resume
  cursor lives on the project (`lastProcessedUnit`) and the engine pauses
  safely on quota; the workflow card and the three-column workspace now sit
  on top of that state, and glossary/memory/validation follow the same
  pattern (pure domain + service + event-driven views).
- **OCR** — `services/ocrRegistry.ts` defines the `OcrProvider` seam and
  `services/ocr/tesseractOcr.ts` registers an on-device Tesseract engine at
  boot (worker, core and the `eng`/`mya` models are copied from `node_modules`
  into `public/` by `scripts/copy-ocr-assets.mjs`, so no third party is
  contacted at runtime). For a `requiresOcr` page the driver renders it to PNG
  inside the analysis worker (`renderPdfPagePng` + an OffscreenCanvas-backed
  pdf.js `CanvasFactory`), recognizes it off the main thread and re-feeds the
  lines through `analyzePage` like any other page; `needs_ocr` pages are
  retried on re-run while an engine is registered. Without a model for the
  document's language, or when rendering/recognition fails, the page honestly
  stays `needs_ocr` (no invented text).
- **PDF export — delivered in Phase 5** — `export_document` handler,
  `exportService` (checkpoints, resume, validation gating) and the export
  worker render from the analysis block/bbox rows: layout plan → painting →
  validation → artifact, with secondary formats (DOCX/HTML/TXT/MD/JSON) on
  the same model. The Export Center offers per-format options, queue
  progress, per-page retry, findings and a validated download.
- **Cloud sync** — wire change producers to `syncService.queueChange()`
  (today only the manual flush from Settings exists) and point them at the
  Apps Script receiver documented in [OFFLINE_FIRST.md](./OFFLINE_FIRST.md);
  payloads are already redacted, metadata-only (`projects | documents |
  settings`) and never carry keys or document text.
