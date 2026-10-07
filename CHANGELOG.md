# Changelog

All notable changes to the AI Document Translator are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.8.1] — Requests the output budget it plans with (2026-10-07)

A run could end `Completed` while almost every unit was `Failed` (the worst
report: 14 of 237 units translated, the rest failed, no reason shown
anywhere). The engine sized batches against the model's output allowance and
then never asked the endpoint for it.

### Fixed

- **Every batch now sends the output allowance it was sized against
  (`max_tokens`).** `planBatches` guarantees the expected answer fits
  `maxOutputTokens`, but the request never carried that number, so each
  endpoint fell back to its own default - routinely a fraction of the model's
  documented maximum. A Burmese answer longer than that default is cut off
  mid-JSON, fails the contract check, is classified `provider_rejected` and is
  halved twice at most: exactly the observed pattern where only the shortest
  batches survived. Each request now sends the allowance the batches were
  planned with - the model's documented maximum minus the prompt - so the
  answer can use the full budget the planner promised (target text, the JSON
  framing around it, any reasoning a thinking model spends) instead of a
  default nobody chose. Split halves inherit a proportional share of their
  parent's budget.
- **A 4xx about an optional parameter no longer fails the batch.** `max_tokens`
  and `response_format` are extras a route may decline (a real output cap
  below the catalog entry, an upstream that never learned `json_object`) while
  the payload itself is fine. The provider now asks again with only the
  offending parameter adjusted - budget halved, JSON mode off - instead of
  rejecting good units. Quota, rate-limit, auth, model and transport errors
  never enter this path.
- **The failure reason is visible at last.** `unit.error.message`, which since
  0.8.0 carries the model id, stop reason and reply snippet, now shows on the
  unit row in the workspace and in the context panel under `Failure reason` -
  the 0.8.0 messages were written but nowhere rendered.
- **A finished run no longer looks successful when it was not.** The workflow
  shows the failed count next to `Completed` and next to
  `Review in editor 14 of 237`, and the progress panel reads persisted counts,
  so a reload no longer replaces the outcome with
  `Waiting for the translation job to start…`.

## [0.8.0] — Parallel batches, honest failure messages (2026-10-06)

Translation runs no longer queue every request behind the previous one, no
longer burn minutes on a reply that will never turn into JSON, and no longer
hide what the model actually said when the contract breaks.

### Added — parallel batches

- **Parallel batches** setting (Settings → Behavior, default 3, range 1–6).
  Batch 1 still runs alone as a canary - it proves keys, model and endpoint
  before anything fans out - so a configuration error still costs exactly one
  request; the remaining batches are then pulled off a work queue by up to
  `batchConcurrency` workers. Ordering, persistence and progress keep their
  previous semantics, and an abort/pause stops the fan-out immediately.
- The run counters now read-then-add instead of `x += await …`: a compound
  assignment takes its left operand *before* the `await`, which under
  concurrency silently drops another batch's units.

### Added — contract-failure handling

- **JSON mode is decided per model, not per provider.** The request builder
  used to gate `response_format` on the whole provider, so OpenRouter (which
  does not advertise JSON mode) never received it - not even from the routes
  that accept it. Verified against OpenRouter's live `/api/v1/models` payload
  on 2026-10-06: `openai/gpt-4o-mini`, `anthropic/claude-sonnet-5.5`,
  `google/gemini-3.5-flash`, `google/gemma-4-31b-it:free` and
  `nvidia/nemotron-3-super-120b-a12b:free` list `response_format` and now get
  it; `thinkingmachines/inkling:free`,
  `thinkingmachines/inkling-small:free`, `nvidia/nemotron-3.5-lightning:free`
  and `nvidia/nemotron-3-ultra-550b-a55b:free` do not and never will. An id the
  registry does not know falls back to the provider-wide flag, so an unknown
  model never receives a parameter it may reject.
- **A rejected batch is halved and retried** (at most twice) before any unit is
  marked failed: a short payload is what a weak model can hold in the required
  shape, and that costs less than failing good units.
- **Contract failures skip the backoff ladder.** One immediate re-ask replaces
  the 5s/10s/20s/40s jitter sequence, so a chatty reply costs seconds instead
  of a minute per provider. Rate limits and offline still back off normally.
- **Failure messages now carry the evidence**: the message reads
  `Translation response was not valid JSON [model=…; finish_reason=…;
  reply="…"]`, with the same facts under `details.finishReason` and
  `details.responseSnippet` (whitespace-collapsed and capped, so a returned
  HTML page cannot flood a toast or a job record).

### Changed

- Behavior section of Settings gained **Parallel batches** next to
  **Parallel jobs**.

## [0.7.0] — More free-tier models (2026-10-06)

The catalog now ships every model a non-paying user can actually run on each
provider, together with the caps those providers publish — re-checked against
each provider's own documentation and live model API on 2026-10-06.

### Added — models

- **Gemini**: `gemini-3.7-flash`, `gemini-3.6-flash` and `gemini-3.1-flash-lite`
  join the existing Flash trio — the six stable chat models on
  ai.google.dev/gemini-api/docs/models, each 1,048,576 input / 65,536 output
  with text, image, video, audio and PDF input (the source of the registry's
  PDF badges). Previews stay out because Google renumbers them, and the 2.5
  line stays out because Google only serves it to accounts that used it.
- **Groq**: `qwen/qwen3.8-27b`, the third chat model on Groq's free plan
  (131,072 context / 16,384 output). No Llama chat model is left after the
  2026-08-16 shutdown, and `gpt-oss-safeguard-20b` stays out on purpose — its
  3 RPM ceiling cannot translate a document.
- **OpenRouter**: six zero-priced routes verified against the live
  `/api/v1/model/<id>` payload — `thinkingmachines/inkling:free`,
  `thinkingmachines/inkling-small:free`,
  `nvidia/nemotron-3-ultra-550b-a55b:free`, `nvidia/nemotron-3.5-lightning:free`,
  `nvidia/nemotron-3-super-120b-a12b:free` and `google/gemma-4-31b-it:free` —
  so the registry now has something to show **FREE** (zero-priced with
  published caps) besides **FREE TIER** and **PAID**.
- **OpenAI-compatible**: `mistral-small-latest` (Mistral Small 4, 256K) for
  Mistral's free Experiment tier, plus a note that a self-hosted Ollama/vLLM
  server is the unlimited free option and that ids must match what the
  endpoint serves.
- The Providers card prints the daily cap (`RPD`) next to `RPM` whenever the
  catalog publishes one.

### Added — recommendation

- Every provider now marks exactly one **Recommended** model
  (`openai_compatible` had none), surfaced as a badge in the model registry and
  as a "· Recommended" suffix on the default-model dropdown, in English and
  Burmese. Both read the catalog, so the badge always names the model
  `defaultConfig` picks for a fresh install.

### Changed — rate limits

- `basis` is now `per-account` for all three hosted providers, matching what
  they document: Google limits per **project**, Groq per **organisation** (and
  per model), OpenRouter per account. A second key never multiplies any of
  them, so the key pool now measures them as one window; the card's notes say
  so in words.
- Groq's free-plan policy gains `requestsPerDay: 1_000` (with 30 RPM, 8K TPM
  and 200K TPD per model) — the first daily cap the catalog records.
- Gemini's notes now carry the reported free-tier figures (≈20 requests/day on
  Flash, ≈500/day on Flash-Lite, ~5–15 RPM, reset at midnight Pacific) while
  stating plainly that Google publishes none of them.

### Fixed — stale state

- `apiKeyService.remove` now deletes the `keyRuntime` failover row along with
  the key. It used to survive, so the pool kept health/cooldown/counter state
  for a key no UI could list any more; the bootstrap and post-import sweep now
  drops any runtime row whose key metadata is gone, which also clears orphans
  left behind by older builds.

### Fixed — facts

- `anthropic/claude-sonnet-5.5` max output corrected 64,000 → 128,000 and its
  image/vision badges added, both read from OpenRouter's live model payload;
  the same payload re-confirmed the GPT-4o mini and Gemini 3.5 Flash entries.

### Docs

- `API_PROVIDERS.md`: provider table carries the real per-day/per-minute caps
  and a new "Free models in the built-in catalog (checked 2026-10-06)" section
  listing each free model, its cap, the rotation caveat (a `:free` id expired
  between two checks a day apart) and which OpenAI-compatible endpoints are
  still free in Oct 2026 (Cerebras and SambaNova now want a card).

### Tests

- The PDF-badge list follows the six Gemini models, and two new cases pin
  "every provider ships a free-capable model with a documented rate-limit
  policy" and "`:free` is the only FREE label on OpenRouter".

## [0.6.0] — On-device OCR (2026-10-06)

Image-only pages are read instead of staying empty: a built-in Tesseract engine
runs on this device — no third-party service, no upload. The analysis worker
rasterizes each image-only page and recognized lines re-enter the ordinary
pipeline as blocks and translation units; anything the engine cannot read for a
definitive reason keeps its honest `needs_ocr` status.

### Added — OCR

- `services/ocr/tesseractOcr.ts`: `OcrProvider` registered at boot from
  `main.tsx` (lazy chunk, ~19 KB; tesseract.js is bundled from
  `dependencies`). One live worker per session, `eng`/`mya` models, line boxes
  converted from image pixels to IR page points with the render scale.
- `services/ocr/ocrService.ts` + `ocrSupport.ts`: language selection (detected
  language first, declared source language as fallback, and only while some
  engine ships a model for it) plus the single place that turns recognized
  lines into `analyzePage` input. Every failure path resolves to `null`, so the
  page is persisted unchanged as `needs_ocr`.
- `AnalysisSource.renderPage()` and an `{ index, render }` session RPC: the
  worker rasterizes a page to PNG at ~160 DPI with `rotation: 0`, so dividing
  pixel coordinates by the returned scale lands directly in IR page points.
  `pdfExtract.openPdf` installs an OffscreenCanvas-backed pdf.js
  `CanvasFactory` — the worker has no `document`, and transparency groups /
  image rescaling allocate helper canvases during `page.render`.
- `scripts/copy-ocr-assets.mjs` wired as `predev`/`prebuild`: worker, core
  (single-file build, wasm embedded) and `4.0.0_best_int` traineddata are
  copied from `node_modules` into git-ignored `public/tess` and
  `public/tessdata`, so no CDN is contacted at runtime.
- Analysis driver: `requiresOcr` pages go through OCR inside
  `analyzeDocument`, and `needs_ocr` pages are retried on re-run **while an
  engine is registered** (they are finished work when none is).
- `OcrPanel` now distinguishes "engine installed — re-run to read these pages"
  from "no model for {language}", in English and Burmese.

### Fixed

- Retired Gemini model ids (`google/gemini-2.0-flash-001` → 404 →
  `invalid_model`) failed every translation: the model catalog self-heals from
  the provider and configuration errors now fail fast instead of looping.
- AI Studio `AQ.` API keys were rejected by the key pattern; `keyPattern` now
  accepts `AIza` and `AQ.` keys.
- Language confidence *fell* as evidence grew (distinct stopword types were
  divided by the whole sample): detection now scores stopword token share over
  a fixed window with calibration and Latin script share.
- Opening a modal stole focus from the field being edited (the focus effect
  depended on inline callbacks); it now keys on `open`.
- Re-applying a page double-counted `processedPages`/`blocks` during a run
  (the OCR retry path made this reachable); `applyPageAnalysis` now replaces
  the previous page's contribution instead of adding it again.

### Removed

- **DeepSeek provider support** — it has no free tier, so it cannot be tried
  without paying, which is not what this app offers. Dropped from
  `PROVIDER_IDS`, the catalog, the model registry, the Providers/API Keys
  pages and the docs. Stored state of any provider this build no longer
  supports (config row, key metadata, encrypted secret, key runtime) is now
  deleted by `services/providerCleanup.ts` at bootstrap and after a data
  import, and an API-key row whose provider is gone renders its raw id instead
  of throwing. Usage history and `translationUnits.provider` are kept: they
  record what was spent, not support for a provider.

## [0.5.0] — Phase 5 (2026-10-06)

Production document export: a worker-rendered, structure-preserving PDF plus
secondary formats, every file gated by pre-download validation, with
page-by-page checkpoints so a crash resumes instead of restarting. The main
thread never renders a page.

### Added - export domain (DB v5)

- `exportArtifacts` store (`by_project`/`by_document` indexes): one row per
  export job holding `rendering | ready | failed` state, produced bytes,
  page counts, plan signature and validation findings. Excluded from JSON
  data-portability bundles (bytes are re-created by exporting again).
- `domain/export/fonts`: role-based font selection with real Myanmar glyph
  coverage (`isMyanmarText`, `coversBurmese`, `missingGlyphs`), bundled
  OFL fonts — Padauk and Noto Sans Myanmar (Regular/Bold) — and the Latin
  catalog (Times/Helvetica/Courier) via the standard PDF fonts.
- `domain/export/textLayout`: font-metric wrapping (measure → word wrap →
  hard-break long tokens) used by both layout modes.
- `domain/export/layoutPlan`: keep-layout reflow vs natural flow, page
  order/size/margins, headings, lists, tables, links, alignment and
  spacing — with the overflow policy *wrap → expand block → rebalance →
  continuation page*, never clipping (`text_overflow`, `block_continued`
  warnings).
- `domain/export/validateExport`: blocking-vs-warning findings for page
  count, blank/empty pages, missing/untranslated blocks, target language,
  title and structure (`pdf_structure` / `container_corrupt`).
- `core/utils/zip`: `writeZipEntries` + `crc32` alongside the existing
  reader (STORE vs DEFLATE picked by size), no new dependency.

### Added - export worker and orchestration

- `workers/export.worker.ts` + `exportProtocol` + `exportClient`: typed RPC
  sessions (`prepare` → `paint(i)` → `checkpoint` → `finish` → `validate`,
  plus a stateless `format`), 5-minute call timeout, idle auto-terminate
  and explicit teardown on `close()`.
- `workers/exportPdfRenderer.ExportPdfSession` (Architecture 2): one shared
  `PDFDocument` per export, the Burmese font embedded **once**
  (`subset: false`), HarfBuzz shaping for Myanmar runs, `doc.save()`
  checkpoint every 10 pages, out-of-order painting rejected and a
  half-painted page dropped if it throws. A corrupted fontkit subset from an
  earlier attempt (missing `name`/`cmap`) is why resume requires a matching
  plan signature.
- `workers/exportPdfValidator`: `%PDF-` header, load, per-page `Tj/TJ`
  content probe mapped back to plan indexes, plus `validateExport` — all in
  the worker, so the plan and the bytes never round-trip to the main thread
  as strings.
- `exportDocumentHandler` registered in `bootstrapJobs()`; `startExport`
  action pre-flights (document analyzed, duplicate active export
  deduplicated), sets `exportState`, and rolls back to `not_started` if the
  enqueue fails. Failure persists a `failed` checkpoint, cancel persists a
  `rendering` one — both resume from the saved page.
- `ExportRunOptions.session` test seam so the whole run can be exercised
  against a scripted session and fake IndexedDB.

### Added - secondary formats

- One worker `format` RPC renders DOCX/HTML/TXT/MD/JSON off the main thread
  with no layout plan; artifacts store `signature: ''` and are probed by
  `validateSecondaryArtifact`.
- `domain/export/secondaryFormats`: HTML (semantic tags, `lang`/`title`,
  page separators), plain text (underlined headings, numbered lists,
  delimited tables, form-feed page breaks), Markdown (ATX headings, GFM
  tables, real links), and a restorable JSON envelope
  (`adt-export-document` v1) with a strict `parseDocumentExportJson`.
- `domain/export/docx`: a real minimal OOXML package — `Heading1..6`
  styles, tables, hyperlinks, `docProps/core.xml` title + language, and one
  section per source page (landscape when the source page is rotated) so
  page size and orientation survive.
- `SUPPORTED_EXPORT_FORMATS` is now `pdf, docx, html, txt, md, json`;
  `requireExportFormat(undefined)` resolves to `pdf`.

### Added - Export Center UI and settings

- Two-column Export Center: export queue (generic job cards with
  pause/retry/cancel), projects table with per-project export state, start
  form (project → format → keep layout), result list with validation
  findings, per-page links and gated download, and supported-format chips.
- Download gating: **error findings block** the download with a visible
  warning listing every finding (page included) and an explicit *Download
  anyway* acknowledgment; warnings never block; nothing is ever auto-fixed.
- Settings → Export fonts: Latin (Times New Roman / Helvetica / Courier
  New) and Burmese (Padauk / Noto Sans Myanmar) selects backed by the new
  `exportLatinFont` / `exportBurmeseFont` settings.
- `downloadBytes`/`mimeTypeForFormat` helpers, and a new `export_failed`
  error code with en/my strings.

### Changed

- `FEATURES.pdfExport` is now `true`; `APP_PHASE = 5`, `APP_VERSION = 0.5.0`.
- The `includeSource` export option was dropped: the planner cannot honor it
  for PDF, so the UI never offers an option the engine would ignore.
- Docs: README status/layout/docs index, ARCHITECTURE (17 stores, the
  `export_document` pipeline, export worker, Phase 5 tests) and six new
  guides — API_PROVIDERS, PDF_PIPELINE, TRANSLATION_PIPELINE,
  EXPORT_PIPELINE, OFFLINE_FIRST, TROUBLESHOOTING.

### Fixed

- `syncService.queueChange` queried the `by_entity` index with an *entity id*
  while the index is keyed by the entity *type*, so the dedupe never matched
  and every change appended a new row. It now fetches candidates per entity
  type and narrows by id/op, keeping one reusable row per entity.

### Security and privacy

- Export artifacts are local-only and excluded from sync payloads; sync
  still carries metadata/settings for `projects | documents | settings`
  only, redacted before enqueue, and never raw API keys or document text.
- No new dependencies for ZIP/DOCX; fonts ship under their OFL licenses in
  `src/assets/fonts/`.

### Testing

- 374 tests across 43 files: export domain (fonts/segmentation, wrapping,
  layout plan and overflow, validation blocking rules, secondary renderers
  incl. a DOCX round-trip through `readZipEntries` and restorable JSON),
  zip writer ↔ reader, real PDF rendering (Burmese + Latin, checkpoint
  resume, single font embed), validator probes (healthy/corrupt/language
  mismatch) and the full export service flow (happy path, crash → resume
  from the failed page, cancel, periodic checkpoint, secondary format).

## [0.4.0] — Phase 4 (2026-10-05)

Translation workflow and the professional real-time editing workspace:
a guided project → analyze → languages → provider → strategy → start flow
with live progress, a per-project terminology glossary woven into every
prompt, opt-in translation memory, post-translation validation that shows
warnings without ever auto-fixing them, and a three-column editor with
search/replace, undo/redo, autosave and unconditional manual-edit
protection.

### Added - terminology glossary (DB v4)

- `glossaryEntries` store (`by_project` index) with `GlossaryEntry`
  (`sourceTerm` → `preferredTranslation`, optional `forbiddenTranslation`
  and `notes`) and a `glossary:changed` event.
- `glossaryService` CRUD: required-field validation, case-insensitive
  duplicate rejection, deterministic listing, `rulesFor()` for the engine.
- Glossary section in the translation prompt: mandatory wording, appended
  after the fixed rules, omitted entirely when there are no rules, and
  counted in the instruction-token cost the batch planner sees. Rules are
  loaded once per run so mid-run edits never mix conventions.
- Glossary CRUD card on the project detail page (en/my strings included).

### Added - translation memory

- `translationMemory` domain: Burmese-safe normalization and a similarity
  score that averages word-token and char-bigram Dice (unspaced scripts
  included), with `suggest`/`autoApply` thresholds.
- `translationMemoryService.suggest/best` filters by project, status,
  target language and self-exclusion, with deterministic ordering.
- Engine pre-fill: when the new `memoryAutoApply` setting is on (default
  off), units matching at auto-apply confidence are completed locally with
  honest null provenance and no usage record; otherwise every pending unit
  goes to the provider. The right editor panel offers suggestions for
  explicit one-click use.

### Added - post-translation validation

- `validation` domain: per-unit checks (missing text, unexpected empty,
  untranslated, numbers/units/URLs/code changed, structure mismatch,
  glossary violations) plus document-level duplicate detection; findings
  carry a code and a readable detail (e.g. the exact token that vanished).
- `validationService` persists only changed findings onto units after a
  completed run (and revalidates a single unit right after a manual edit);
  warnings are display-only — nothing is ever auto-fixed, and a validation
  problem never fails an otherwise successful translation.
- `validation.*` dictionary section (en/my) for the warning chips shown in
  the editor and workflow.

### Added - workflow engine, strategy and progress

- Translation strategy (`draft`/`standard`/`precise`) travels with the job
  payload, drives batch sizing (`BatchingPolicy.quality`) and sampling
  temperature (0.4/0.2/0.1); unknown payload values are rejected by type
  guard rather than passed on.
- Enriched progress: page x/y and unit x/y counters, batch x/y, provider,
  model and the vault key id (masked by the UI, never the key), bridged to
  the app event bus as `translation:progress`.
- Offline rule: `network_offline` pauses AI requests until connectivity
  returns (injectable, abortable) before the normal backoff — local state
  is preserved, the app stays usable, and no attempt is wasted on a dead
  link.
- `documentService.setTargetLanguage` applies the workflow's target choice
  to the document and every unit so validation, memory and the workspace
  all see the same language.
- `availableTargetLanguages()` honors the new `targetLanguages` setting,
  always lists Burmese first and drops unknown codes.

### Added - real-time editing workspace

- New route `workspaceEditor` (`/workspace/:projectId/editor`) with a
  three-column `TranslationEditorPage`: left page navigation with
  per-page progress and warning counts; center inline editing with
  source/translation/side-by-side views, document-wide search, confirmed
  replace, undo/redo history and debounced autosave with a visible save
  status (plus a beforeunload guard while dirty); right context panel with
  original text, unresolved warnings, matching glossary rules, the
  preserved AI suggestion and a translation-memory match — suggestions
  apply only on explicit click.
- `TranslationUnit.aiText` keeps the provider's own wording when a manual
  edit replaces `translatedText`, so original / translation / AI
  suggestion / manual edit are all inspectable; the engine refreshes it on
  every provider run and never touches translated/reviewed units.
- Guided workflow card on the project detail page: ordered steps
  (project → analyze → source → target → provider/model → strategy →
  start → progress → validation → editor) reflecting real persisted state,
  target-language select, strategy segmented control and start button.

### Changed

- `TranslationUnit` gains optional `editedAt`, `aiText` and `warnings`
  fields — all optional, so existing rows load unchanged; DB version
  moves to 4 for the new `glossaryEntries` store only.
- `startTranslation`/`startTranslationById` accept a strategy option;
  `TranslationProgress` carries key id and page counters (provider/model
  now nullable for memory-only runs).
- App version 0.4.0, `APP_PHASE = 4`.

## [0.3.0] — Phase 3 (2026-10-05)

Production BYOK provider system with intelligent multi-key failover:
health-aware weighted key selection (never naive sequential rotation), a
complete provider error taxonomy, resumable batched translation through the
job queue, an updatable model registry with honest FREE/FREE TIER/PAID
labels, and usage accounting that separates provider-reported from
locally-estimated figures. Multiple keys are never treated as multiplied
quota.

### Added — error taxonomy and the common `AIProvider` contract

- Four new `AppErrorCode`s — `provider_quota_exceeded`, `provider_timeout`,
  `provider_invalid_model`, `provider_content_policy` — with en/my messages
  and transport-level remapping (timeout → typed timeout, not "network").
- `providers/classify.ts`: shared `classifyProviderError()` implementing the
  Phase 3 taxonomy (429, quota exceeded, insufficient quota, auth, invalid
  key, invalid model, network, timeout, server, content policy). Quota vs
  rate-limit is decided by the text itself: quota/billing/per-day wording
  wins unless a per-minute window is named. Every adapter maps errors
  through it.
- All adapters expose the spec interface: `validateKey · listModels ·
  getCapabilities · estimateTokens · generate · translate · getUsage ·
  getRateLimitState · classifyError`. Completion endpoints added: Gemini
  `models/{model}:generateContent` (with `responseMimeType` for JSON),
  OpenAI-compatible `/chat/completions` (`response_format` only when the
  capability declares JSON mode), plus `CompletionRequest.responseFormat`.

### Added — failover domain (`src/domain/provider/`)

- `backoff.ts` — exponential backoff with jitter; a retry can never become a
  tight loop, and a `Retry-After` hint from the provider always wins.
- `tokens.ts` — script-aware token estimation (Burmese-aware per-character
  rates), shared by batching, prompts and usage estimates.
- `keySelection.ts` — pure, deterministic-when-seeded weighted selection with
  hard gates: disabled, verification_failed, cooling, unsupported_model,
  rpm_exhausted, tpm_exhausted. Weighted by health, recency, success rate,
  recent 429s and rolling-window pressure — not round-robin.
- `batching.ts` — batch planner using context window, output budget,
  estimated payload, RPM, document type, target language (Burmese output
  expansion) and quality. Units are never split or reordered; oversized units
  are flagged and attempted alone instead of being dropped.
- `translationPrompt.ts` — build/parse of translation prompts with Burmese
  preservation rules (terminology, numbers, units, formulas, code, citations,
  URLs, proper nouns, markdown structure) and structured JSON responses when
  the model supports them.

### Added — key pool and supporting services (DB v3)

- `keyRuntime` store with a `by_provider` index (`DB_VERSION = 3`): per-key
  health, cooldown (until + reason), last-used, request/token/success/
  failure/429 counters, redacted `lastError`. `dataPortabilityService`
  handles the new store.
- `keyPoolService` implements `KeyPoolRuntime`: weighted select with
  rejection reasons, success/failure recording, and a deliberate cooldown
  policy — rate limit → `Retry-After` or jittered backoff (max 5 min), quota
  → ≥15 min doubling per repeat (cap 6 h), server errors → backoff from
  consecutive failures, auth → `invalid` with no cooldown; `deriveExhaustion`
  reports `no_keys / verification / quota / rate_limited / none`, and
  `isQuotaExhausted()` drives the engine's safe pause. `setEnabled`/`reset`
  work before a key's first request (metadata fallback).
- `usageService` snapshots now carry `basis`
  (`provider_reported | locally_estimated`), never lose provider-reported
  data to local estimates, and expose `totalsFor(provider)` feeding
  `AIProvider.getUsage()`; cost is always labelled estimated.
- `aiProviderService.createAIProvider()` assembles adapter + provider config
  + key pool + usage into one instance, so provider-specific logic stays out
  of the UI.

### Added — translation engine and job

- `services/translationService.ts`: batched, resumable document translation.
  Per-unit persistence (`in_progress → translated/failed`), already-translated
  units skipped, ordered cross-provider failover (Gemini first), typed retry
  with jittered backoff for 429/timeout/network, and a legal
  `translating → paused` path when every candidate is quota-blocked
  (`paused_quota`, "Provider quota exhausted") — a refresh mid-run never
  loses completed units; the next run resumes at the first unfinished unit.
- `jobs/handlers/translateDocument.ts` maps outcomes to the queue: quota →
  `jobQueue.pause(id, reason)` with a user-visible reason, abort → graceful
  return (state already persisted), failure → typed error.
- `jobQueue.pause(id, reason?)` stores the pause reason as `lastError` (shown
  by the job list); `actions.startTranslation`/`startTranslationById` perform
  pre-flight checks (document exists, at least one usable provider candidate,
  no duplicate job) and enqueue with `translationJobTimeoutMs` (30 min).

### Added — model registry and catalog

- `providers/modelRegistry.ts`: one data source for `provider, modelId,
  displayName, pricingType, freeTier, paid, contextLength, supportsText /
  PDF / Image / StructuredOutput / Vision, qualityLevel, speedLevel, source`.
  PDF is never assumed — only explicitly declared models get the badge.
  `validateOverlay`/`serializeOverlay` handle catalog imports, rejecting
  unknown providers, unknown models, unknown fields and invalid enums with
  `import_invalid` and the exact entry index.
- `modelCatalogService`: persisted overlay in settings (re-validated on every
  load, so corrupted storage self-heals to the built-in catalog) with
  import/export/reset.
- `providerConfigService.save()` keeps `defaultModel ∈ enabledModels`, so a
  model chosen as default can never be rejected by the key pool.

### Added — Phase 3 UI

- `components/providers/` — `KeyPoolCard` (per-key health, cooldowns with
  reasons, requests/success/failures/429s/tokens, last error, enable/reset,
  quota and rate-limit notices), `ModelRegistryTable` (all catalog models:
  pricing badges, capability chips, default/updated markers, per-model enable
  toggles that cannot disable the default or the last enabled model),
  `PricingBadge` (FREE / FREE TIER / PAID, every badge carrying the "pricing
  changes, nothing is free forever" disclaimer), `CatalogCard` (catalog JSON
  export/import/reset with validation errors surfaced verbatim).
- `components/usage/` — `UsageBreakdown` (totals, provider-reported vs
  locally-estimated token split, per-provider and per-model tables) and
  `KeyUsageTable` (requests, errors, 429s, cooldowns per stored key, token
  figures labelled as local estimates).
- API Keys page: BYOK browser-side caveat (keys are controlled by the user
  and usable from this client) plus the failover pool card per provider;
  Providers page: registry table + catalog card; Project detail: **Translate**
  button (enabled once analysis produced units).
- Full Burmese + English entries for the new surface (`registry.*`,
  `keyPool.*`, `translation.*`, usage/apiKeys additions); stale Phase 2 copy
  in `providers.phaseNote`/`usage.emptyHint` updated.

### Changed

- Providers ship **disabled by default** and `enabledModels` defaults to the
  provider's `recommended` model only — the app never calls a provider the
  user has not explicitly turned on.
- `translating → paused` is a legal transition (quota-safe pause, resume via
  the normal job resume path).

### Fixed

- **Data export/wipe skipped block rows (latent Phase 2 bug):**
  `dataPortabilityService.repoFor` had no `documentBlocks` case — block rows
  were silently omitted from export/wipe. Added (plus `keyRuntime`).
- `keyPoolService.setEnabled`/`reset` no-op'd when the runtime row did not
  exist yet; both now fall back to key metadata and create the row.

### Tests (208 tests / 21 files, +103)

- `providers/classify.test.ts` — the full taxonomy: 429 vs quota vs
  insufficient quota vs auth vs invalid model vs timeout vs server vs
  content policy, header-based Retry-After parsing.
- `domain/provider/*` — backoff curve and jitter bounds, token estimation
  (Latin/Burmese/structured), weighted selection gates and seeding,
  batching budgets (never exceeding context/output, Burmese expansion,
  oversized flagging, unit order), prompt building/parsing with all Burmese
  preservation rules.
- `services/keyPoolService.test.ts` (14) — cooldown policy per error class,
  Retry-After honoring, quota doubling, exhaustion derivation, weighted
  selection across multiple keys, enable/reset lifecycle, and **no raw key
  material in logs** across the whole lifecycle.
- `services/translationService.test.ts` (11) — happy path with usage
  recording, resume/skip, 429 retry with bounded backoff, timeout + network
  recovery, provider failover on a rejected key, unit failure then recovery,
  refresh mid-translation (completed units kept, remainder re-run exactly
  once), quota pause (fresh and while keys stay cooled), unconfigured
  provider failing loudly, oversized units attempted alone.
- `providers/modelRegistry.test.ts` (9) — every registry field, PDF never
  assumed, overlay validation (unknown provider/model/field/enum/type),
  coherent pricing flags, round-trip serialization, source labelling.
- **Queue** — `jobs/jobQueue.test.ts` grew two Phase 3 cases: pausing a
  non-running job with a reason persists it as `lastError`, and a running
  handler that pauses itself with a reason ends up `paused` with that reason
  stored (the handler's return value is discarded — an aborted run never
  "completes").
- `services/providerConfigService.test.ts` (4) — default-model invariant,
  no empty enabled-model list, verbatim patches, https enforcement.

### Documentation

- `README.md` — Phase 3 status and feature list, layout, phase table.
- `ARCHITECTURE.md` — key-pool/failover design, `translate_document`
  pipeline, 15-store data model, testing section.
- `CHANGELOG.md` — this entry.

### Verification

- `npx tsc --noEmit -p tsconfig.json` — 0 errors
- `npx eslint .` — 0 errors, 0 warnings
- `npm test` — 208/208 passing (21 files)
- `npm run build` — succeeds

## [0.2.0] — Phase 2 (2026-10-05)

Document analysis pipeline: a real structure-extraction pass over every
supported format, persisted page by page so interrupted runs resume — no
extract-all-text → translate → put-back shortcuts, no mock data.

### Added — analysis domain (`src/domain/analysis/`)

- Stable intermediate representation (`ir.ts`): `PageIR` / `BlockIR` /
  `LineIR`, deterministic ids, unrotated content-space bboxes, font
  (size/family/weight/style), alignment, links, flags, `AnalysisProgress`,
  `LanguageDetection`, `DocumentMetadata`.
- Pipeline stages as pure functions: line grouping → layout/columns →
  reading order (banded, full-width separators, multi-column aware) →
  structure classification (headings, lists, tables, captions, quotes, code,
  page furniture) → per-page analysis.
- Input formats: PDF (via PDF.js), DOCX (unzip + XML through
  `core/utils/zip.ts`), and text formats (plain text, Markdown, HTML, CSV,
  JSON) — all converge on the same IR.
- Multi-heuristic language detection with confidence + per-candidate scores
  and a `LANGUAGE_CONFIRM_THRESHOLD` below which the UI demands confirmation.

### Added — source and worker stack

- `AnalysisSource` session protocol (`open` → `page(i)` × n → `close`) with
  two identical-code implementations: `analysis.worker.ts` (Web Worker,
  browser) and `analysisSession.ts` (in-process, tests).
- `analysisProtocol.ts` isolates message types so the client never imports
  the worker entry; `analysisClient.ts` spawns/disposes the worker session.
- `pdfExtract.ts` extracts pages, images (CTM stack) and text runs from
  PDF.js — composed as `base × op` so the newest transform applies first.

### Added — persistence (DB v2)

- `documentBlocks` store (reading order, bbox, font, lines, kind, flags,
  `documentId+orderIndex` / `by_page` indexes); `translationUnits` reshaped
  to the spec fields (`translatedText`, `retryCount`, provider/model/keyId,
  token estimates, `sourceChecksum`, `by_page` index for resume).
- `documents` gains optional `analysis`, `languageDetection`, `metadata`
  (legacy Phase 1 rows load unchanged — no data migration needed);
  `documentPages` gains `needs_ocr` status, `blockCount`, `error`,
  `analyzedAt`.
- Per-page commit order: stale rows → blocks → units → page record last, so
  a crash mid-page only costs a re-analysis of that page. Units with an
  unchanged `sourceChecksum` are preserved verbatim (translations survive
  re-analysis).

### Added — services and job pipeline

- `documentService`: file validation (type → size → empty, before any row is
  written), `beginAnalysis`, `applyPageAnalysis`, `markPageFailed`,
  `setLanguageDetection`, `confirmSourceLanguage`, `finishAnalysis`,
  `failAnalysis`, block/unit readers, cascade delete.
- `documentAnalysisService.analyzeDocument()`: parse → seed → per-page loop
  with resume-skip, one retry and per-page failure isolation → language
  detection over persisted text → authoritative counter recount; aborts stop
  between pages and resume from the first unanalyzed page.
- `inspectDocument` handler upgraded to drive that pipeline with real
  progress (`context.progress(page, total)` per page, periodic logs, signal
  checks) and `failAnalysis` on catastrophic errors; analysis jobs enqueue
  with a `jobTimeoutMs` payload override (600s vs. 120s default).
- `ocrRegistry`: a real `OcrProvider` seam (`register/available/recognize`).
  Nothing registers in Phase 2 — recognition with no provider fails with
  `unsupported` instead of inventing text; image-only pages stay `needs_ocr`.
- `analysis:progress` event (stage, task, page x/y, blocks, failed) feeding
  both the job record and the UI.

### Added — analysis UI

- New route `/workspace/:projectId/analysis` (14 routes total) with
  `AnalysisPage` and `components/analysis/`:
  `AnalysisStageList` (pipeline stage checklist), `PageStatusGrid` (page
  matrix colored by persisted status), `BlockTable` (order/kind/text/size for
  the selected page), `LanguageDetectionCard` (confidence, score chips,
  confirm flow), `AnalysisMetadataCard`, `OcrPanel` (honest “no OCR engine”
  notice).
- Workspace: link to the analysis view, `needs_ocr` page badge, live
  subscription to `analysis:progress`.
- Full Burmese + English dictionary entries for the new surface
  (`analysis.*`, `status.needsOcr`).

### Added — fixtures and tests (105 tests / 11 files, +66)

- `test-fixtures/pdfFixtures.ts` generates real PDFs in memory (normal,
  paragraphs, headings, lists, tables, mixed fonts, Burmese, scanned,
  rotated) — no recorded snapshots.
- `workers/analysisSession.test.ts` (11) drives the pipeline over those
  fixtures; pipeline tests (43 across `languageDetect.test.ts`,
  `pipeline.test.ts`, `textFormats.test.ts`) cover line grouping,
  layout/columns, reading order, structure classification, the end-to-end
  pipeline, every text-format parser, and language detection.
- `services/documentAnalysisService.test.ts` (11) runs the whole driver
  against `fake-indexeddb`: happy path, detection + unit sync, resume-skip,
  failure isolation and retry, abort → resume, checksum-based unit
  preservation, and validation rejections.

### Changed

- `maxSourceFileBytes` is now an acceptance cap (analysis needs the local
  payload); text files are additionally limited by the new
  `LIMITS.maxTextFileBytes` (64 MB).
- `projectService.create` validates the file **before** creating the project
  row, so a rejected file leaves nothing behind.
- Analysis counters: `beginAnalysis` seeds `processedPages` from already
  persisted pages and resets `failedPages` (failed pages are retried each
  run); `finishAnalysis` recomputes everything from the page records.
- Detection prefers `languageDetection` over the project default for unit
  `sourceLanguage`, then syncs all units to the detected code (`unknown`
  never overwrites a known language).

### Removed (superseded, docs updated)

- `src/workers/pdfInspect.worker.ts`, `src/workers/pdfInspectClient.ts`,
  `src/domain/pdfInspection.ts` — replaced by the analysis worker/client/
  protocol stack.
- `documentService.applyInspection` — replaced by the per-page analysis
  persistence methods.
- The “Inspection page limit” setting (`inspectMaxPages`,
  `LIMITS.maxInspectionPages`) — analysis now processes every page; per-page
  persistence and resume are the safety valve.
- Dead `LIMITS.maxCharsPerPage` (Phase 1 sampling cap).

### Fixed

- **Image placement in extracted PDFs:** the transformation order was
  inverted (`op × base`), rendering images at e.g. 20600 pt instead of 40 pt.
  Composition is now `concatenate(base, op) = base × op`, matching PDF.js’s
  column-vector convention (the newest `cm` applies to the point first).

### Documentation

- `README.md` — Phase 2 status, feature list, updated routes/stores/layout,
  phase table (1 → 5).
- `ARCHITECTURE.md` — data model (14 stores, per-page/block rows), the
  `inspect_document` pipeline and its resume/commit rules, worker stack,
  updated testing section.
- `CHANGELOG.md` — this entry.

### Verification

- `npx tsc --noEmit -p tsconfig.json` — 0 errors
- `npx eslint .` — 0 errors, 0 warnings
- `npm test` — 105/105 passing (11 files)
- `npm run build` — succeeds (app ~249 kB, analysis worker emitted lazily
  at ~3.3 MB of PDF.js)

## [0.1.0] — Phase 1 (2026-10-05)

First complete, runnable foundation of the application. No AI translation is
implemented yet, and nothing is faked with mock data.

### Added — tooling and scaffold

- Vite 8 + React 19 + TypeScript (~5.9, strict) project with `dev`, `build`
  (type-check then bundle), `preview`, `typecheck`, `lint` and `test` scripts.
- ESLint 9 flat config with the strict React hooks rules (no setState in
  effects, no ref writes during render), React Refresh and TypeScript rules.
- Vitest 5 setup with a Node environment for unit tests and a jsdom
  environment for render tests.

### Added — design system and shell

- Design tokens (`styles/tokens.css`) and flat, modern, desktop-first CSS:
  minimal, no gradients or decorative clutter.
- Light / dark / system themes resolved by an inline pre-paint script
  (`index.html`) so the first paint already has the correct theme;
  `useTheme()` follows the OS preference while `system` is selected.
- App shell: collapsible sidebar (state persisted through settings), top
  header, routed content area, offline banner, per-route error boundaries.
- Responsive behavior: desktop-first with breakpoints down to 640px; below
  1024px the sidebar becomes a drawer closed by navigation, scrim or browser
  back.

### Added — routing

- 13 routes: `/`, `/projects`, `/projects/:id`, `/workspace`,
  `/workspace/:id`, `/editor`, `/export`, `/providers`, `/api-keys`,
  `/usage`, `/settings`, `/help` plus a catch-all not-found view.
- Every page renders inside `AppShell`, so a failing view never takes the
  navigation down.

### Added — data layer (offline-first)

- 13 IndexedDB stores: `projects`, `documents`, `documentPages`,
  `translationUnits`, `editorDocuments`, `settings`, `providerConfigs`,
  `apiKeyMetadata`, `jobQueue`, `usageSnapshots`, `syncQueue`, `errorLogs`,
  `secretVault`.
- Declared store/index contract in `db/schema.ts`, full entity types in
  `db/entities.ts`, single connection with upgrade handling in
  `db/database.ts`, and a generic, error-normalizing `Repository<K>`.
- Services for projects, documents, editor documents, settings, provider
  configs, API-key metadata, usage, sync, error logs, and data
  export/import/wipe.

### Added — job-state system

- Explicit state machine for all nine states (`queued`, `analyzing`,
  `translating`, `paused`, `retrying`, `exporting`, `completed`, `failed`,
  `cancelled`) with every transition validated (`invalid_transition`).
- Persistent queue: transitions are written to IndexedDB before being
  announced, active jobs are recovered to `queued` after a refresh
  (`interruptions` counter), retryable failures use exponential backoff
  (1.5s → 60s cap) against `maxAttempts`, pause/cancel/timeout travel through
  an `AbortSignal`, and job types without a handler fail loudly with
  `handler_missing`.
- Job list/status components with clear per-state badges and progress bars.

### Added — worker infrastructure

- Typed `postMessage` RPC (correlation ids, timeouts, error propagation) and
  a real PDF.js inspection worker with a lazy client and explicit disposal,
  so PDF work never blocks the main thread.

### Added — provider layer (BYOK)

- Catalog + registry for Gemini (primary), Groq, OpenRouter, DeepSeek and a
  generic OpenAI-compatible provider, with models, capabilities and rate-limit
  policies expressed as data.
- Header-only API-key transport (the key is never appended to a URL), key
  verification, and `gemini` / `openaiCompatible` adapters.
- `RateLimitPolicy.basis` (`per-key` / `per-account` / `per-model`) so the UI
  never claims a second key multiplies a per-account quota.
- Providers, API Keys, and Usage pages (verification, masked hints, revoke,
  per-provider/model usage aggregates).

### Added — security

- Local `KeyVault` (AES-GCM via WebCrypto) with two modes: device key by
  default, or passphrase mode using PBKDF2 with 310k iterations and a
  per-vault salt; auto-lock and typed `vault_locked` /
  `vault_wrong_passphrase` failures behind one interface.
- Raw keys are never logged, never included in error messages, never placed
  in URLs, and never sent to Google Sheets; sync payloads are deep-redacted.

### Added — i18n, settings, errors

- Burmese-first UI (default locale) with an English dictionary;
  `Dictionary = WidenLiteral<typeof en>` keeps both locales key-for-key at
  compile time.
- Settings page: appearance, language, behavior, data (export/import/clear),
  sync, and diagnostics (recent redacted errors, version, reset).
- `AppError` with a closed error-code set, centralized redacting logger,
  persisted `errorLogs` for diagnostics, and global `error` /
  `unhandledrejection` handlers.

### Added — tests (39 tests / 6 files)

- `domain/jobStates.test.ts` — full transition table, terminal/active/
  recovery classification, job-type → state mapping.
- `db/repository.test.ts` — CRUD, bulk ops, index queries (including
  `projectId: null` not being indexed) and error normalization against
  `fake-indexeddb`.
- `jobs/jobQueue.test.ts` — refresh recovery, run to completion,
  pause/resume/cancel, missing-handler failure, manual retry.
- `services/settingsService.test.ts` — theme/language changes reach both
  IndexedDB and the localStorage cache that `index.html` reads before first
  paint, and survive a simulated reload; subscribers are notified.
- `routes/AppRoutes.test.tsx` — mounts every route in jsdom and asserts the
  shell, localized page titles and the 404 view.
- `i18n/dict.test.ts` — dictionary parity, no blank strings, coverage of every
  `t('…')` call site and every `AppErrorCode`.

### Fixed

- **Analysis-only jobs could never finish:** `analyzing → completed` was
  missing from the transition table, so `inspect_document`/`extract_text`/
  `sync_push` jobs would have failed with `invalid_transition` on completion.
  Found by the queue tests and fixed in `domain/jobStates.ts`.
- Reworked data-loading and page state to satisfy the strict React hooks
  rules: `useAsyncData` now *derives* loading from the key of the last settled
  load instead of setting state inside an effect; title/notes/provider-draft
  edits are keyed to their entity and merged at render time; the sidebar
  collapse derives from settings; `useMediaQuery` uses
  `useSyncExternalStore`. Net effect: no state writes in effects, no ref
  writes during render, zero lint errors.

### Removed

- Leftover files from an abandoned alternate scaffold (`src/core/types/*`,
  self-referential only) and a stale comment in `vitest.config.ts`.

### Documentation

- `README.md` — setup, scripts, scope, privacy notes, deployment note.
- `ARCHITECTURE.md` — layering, data model, job state machine, workers,
  provider adapters, security, i18n, theming, testing, Phase 2 extension
  points.

### Verification

- `npm run typecheck` — 0 errors
- `npm run lint` — 0 errors, 0 warnings
- `npm run build` — succeeds (app shell ~217 kB, PDF worker emitted lazily)
- `npm test` — 39/39 passing
- Dev-server smoke test: `/`, `/projects`, `/settings`, `/api-keys` all serve
  the SPA shell correctly.
