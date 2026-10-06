# AI Document Translator

အော့ဖ်လိုင်းဦးစားပေး (offline-first) စာရွက်စာတမ်း ဘာသာပြန် အလုပ်ပြင်ဆင်ခန်း — အထူးသဖြင့် သဘာဝကျသော မြန်မာဘာသာ ထွက်ရှိမှုအတွက် ရည်ရွယ်ထားသည်။ သင့် API key များကို သင်ပိုင် (BYOK) ပြီး ဤဘရောက်ဇာထဲတွင်သာ စာဝှက်သိမ်းဆည်းသည်။

An offline-first document translation studio focused on high-quality, natural
Burmese output. You bring your own AI provider keys (BYOK); they are encrypted
locally and never leave the browser except as requests to the provider you
chose.

> **Status: Phase 5 (v0.6.0 — on-device OCR).** The application shell, routing, local
> database, project management, job-state machine, provider adapter layer,
> key vault, settings, error handling, document analysis, the production BYOK
> provider system and the full translation workflow are complete — and
> Phase 5 adds structure-preserving export: a worker-rendered PDF
> (HarfBuzz-shaped Burmese, layout plan, page-by-page checkpoints, resume
> after a crash) plus DOCX, HTML, plain text, Markdown and JSON, every file
> gated by pre-download validation. v0.6.0 adds on-device OCR so image-only
> pages are read rather than left empty. Nothing here is faked with mock data.

## Requirements

- Node.js 20.19+ (22 LTS recommended)
- npm 10+
- A modern Chromium/Firefox/Safari build (WebCrypto, IndexedDB, Web Workers)

## Quick start

```bash
npm install        # install dependencies
npm run dev        # start the dev server on http://localhost:5173
```

Then open the printed URL. Everything is stored locally on first use — no
account, no server, no network required for ordinary work.

## Scripts

| Command              | What it does                                            |
| -------------------- | ------------------------------------------------------- |
| `npm run dev`        | Start the Vite dev server with HMR                      |
| `npm run build`      | Type-check (`tsc --noEmit`) and build `dist/`            |
| `npm run preview`    | Serve the production build locally                       |
| `npm run typecheck`  | TypeScript only, no emit                                 |
| `npm run lint`       | ESLint (React 19 hooks rules, strict)                    |
| `npm test`           | Vitest unit/integration tests (fake-indexeddb + jsdom)   |

All commands are expected to be clean: **0 type errors, 0 lint errors,
0 test failures.**

## What Phase 1 provides

- **App shell** — sidebar + header + routed content, desktop-first and
  responsive (sidebar becomes a drawer below 1024px).
- **14 routes** — Dashboard, Projects, Project detail, Workspace, Document
  Analysis, Editor, Export Center, AI Providers, API Keys, Usage, Settings,
  Help, and a not-found view. Every view sits inside a per-route error
  boundary.
- **Offline-first data** — 17 IndexedDB stores (projects, documents,
  documentPages, documentBlocks, translationUnits, glossaryEntries,
  editorDocuments, settings, providerConfigs, apiKeyMetadata, keyRuntime,
  jobQueue, exportArtifacts, usageSnapshots, syncQueue, errorLogs,
  secretVault) behind one typed repository layer.
- **Job-state system** — `queued → analyzing → translating/exporting →
  completed`, plus `paused`, `retrying`, `failed`, `cancelled`. Every
  transition is validated and persisted before it is announced; jobs
  interrupted by a refresh are recovered to the queue automatically.
- **Web Worker infrastructure** — a request/response RPC client plus real
  worker sessions, so heavy document work never blocks the UI.
- **Provider adapters** — Gemini (primary), Groq, OpenRouter, and a generic
  OpenAI-compatible adapter, described by data (catalog + registry), not by
  `if` statements spread through the UI. DeepSeek is deliberately not offered:
  it has no free tier, and this app only lists providers you can start with
  without paying.
- **Local key vault** — AES-GCM via WebCrypto; PBKDF2 (310k iterations) in
  passphrase mode or a device key by default. Raw keys are never logged,
  never written into error messages, and never sent to Google Sheets.
- **Settings & themes** — light / dark / system themes resolved before first
  paint, Burmese-first UI with an English toggle, appearance/behavior/data/
  sync/diagnostics sections.
- **Cloud sync (secondary)** — a local `syncQueue` that can push redacted
  payloads to a Google Apps Script endpoint when you configure one. Local
  writes are always authoritative.

## What Phase 2 provides

- **One pipeline for every format** — PDF, DOCX, Markdown, plain text, HTML,
  CSV and JSON all flow through the same analysis source → line grouping →
  layout → reading order → structure classification → translation units.
- **Per-page persistence and resume** — pages and blocks are committed page by
  page; a refresh, abort or timeout resumes from the first unanalyzed page
  instead of redoing work. Already-finished pages are skipped, failed pages
  are retried.
- **Real progress** — the Analysis view shows stage, task, page x/y, block
  counts and failures as they happen (driven by an `analysis:progress`
  event), plus a clickable page matrix and a per-block inspection table
  (reading order, kind, text, font size/style, flags).
- **Structure awareness** — headings, lists, tables, captions, quotes, links,
  page furniture (page numbers / headers / footers are flagged and never
  become translation units).
- **Language detection with confirmation** — multi-heuristic detection with
  visible confidence and per-candidate scores; below the confidence threshold
  the UI asks you to confirm the source language explicitly.
- **Honest OCR handling** — image-only pages are read by a built-in on-device
  Tesseract engine: the analysis worker rasterizes the page, recognizes it
  locally (English and Burmese models served from this app's own origin) and
  re-feeds the text through the normal pipeline. When the document's language
  has no model, or rasterization/recognition fails, the page keeps its
  `needs_ocr` status and the panel says so; text is never invented.
- **Verified translation units** — spec-shaped units with `translatedText`,
  status, retry counts and a `sourceChecksum`, so re-analysis preserves any
  translation already attached to unchanged text.

## What Phase 3 provides

- **One provider contract** — every adapter (Gemini, Groq, OpenRouter,
  OpenAI-compatible) exposes the same interface: `validateKey`,
  `listModels`, `getCapabilities`, `estimateTokens`, `generate`,
  `translate`, `getUsage`, `getRateLimitState`, `classifyError`.
- **Typed provider errors** — 429, quota exceeded, insufficient quota, auth,
  invalid key, invalid model, network, timeout, server and content-policy
  failures are classified in one place, so the app always knows whether to
  retry, fail over, or stop.
- **Intelligent multi-key failover** — keys are selected by a health-aware
  weighted score (cooldowns, recent 429s, success rate, RPM/TPM pressure),
  never by naive sequential rotation: multiple keys on one account do not
  multiply quota, and the pool says so. On 429 the failing key cools down
  (honoring `Retry-After`) and a different healthy candidate is used; when
  every provider is quota-blocked the job pauses safely with a visible
  "Provider quota exhausted" reason instead of failing.
- **Resumable batched translation** — units are planned into batches that fit
  the model's context and output budgets (Burmese output expansion included),
  persisted unit by unit, and resumed from the first unfinished unit after a
  failure, a pause or a page refresh. Completed work is never redone.
- **Model registry** — per-model pricing (FREE / FREE TIER / PAID, always
  with a "pricing can change, nothing is free forever" note), context window,
  and explicitly declared capabilities (PDF support is never assumed). The
  catalog is importable/exportable as validated JSON.
- **Honest usage reporting** — provider, key and model breakdowns with
  requests, tokens, errors, 429s and cooldowns; token figures are labelled
  *provider-reported* or *locally estimated*, because browser-side quota
  cannot be queried.

## What Phase 4 provides

- **Guided translation workflow** — project → analyze → confirm source
  language → select target language (Burmese first-class) → pick
  provider/model → choose a strategy (draft/standard/precise, which drives
  both batch sizing and sampling temperature) → start, with live page x/y
  and unit x/y progress, the current provider/model and a masked key hint
  (the key itself is never displayed).
- **Terminology glossary** — per-project English → preferred Burmese rules
  (plus optional forbidden wording and notes) that are incorporated into
  every translation prompt and drive the glossary-violation validation
  check; rules survive reprocessing.
- **Translation memory** — similar source text surfaces the previous
  translation as a suggestion; automatic replacement happens only when
  confidence is high AND the user enabled the option (off by default).
- **Post-translation validation** — missing text, untranslated segments,
  changed numbers/units/URLs/code, duplicated text, unexpected empties,
  structure mismatches and glossary violations are computed after every
  completed run and shown as warnings on the units. Findings are never
  auto-fixed.
- **Professional editing workspace** — left: page navigation with
  per-page progress and warning counts; center: editable translation with
  source/translation/side-by-side views, inline editing, document-wide
  search, replace with confirmation, undo/redo and visible autosave
  status; right: context with original text, unresolved warnings,
  terminology, the preserved AI suggestion and translation-memory matches.
- **Manual edits always win** — every human edit is stamped (`editedAt`)
  and survives later reprocessing, while the provider's own wording stays
  inspectable as the AI suggestion.
- **Network resilience** — going offline pauses AI requests without losing
  local state or reloading the app, and the run retries when connectivity
  returns. Opening an existing project never requires network access or a
  configured AI provider.

## What Phase 5 provides

- **Structure-preserving PDF export** — pages are rebuilt from the analysed
  block/bbox model in a background worker (the original file is never patched
  in place): page size, orientation, margins, page order, headings,
  paragraphs, lists, tables, links, alignment and spacing are preserved, and
  overflowing text is reflowed (wrap → expand block → rebalance →
  continuation page) instead of being clipped.
- **Real Burmese rendering** — a bundled, Myanmar-capable Unicode font
  (Padauk by default, Noto Sans Myanmar optional; both OFL-licensed and
  configurable under **Settings → Export fonts**) shaped with HarfBuzz and
  embedded once per export. Latin runs use the standard Times/Helvetica/
  Courier fonts; missing glyphs are reported as findings, never silently
  substituted.
- **Crash recovery** — exports checkpoint every 10 pages into the local
  `exportArtifacts` store. A failed, cancelled or interrupted run keeps its
  finished pages, and the retry resumes from the last saved page (only when
  the layout-plan signature still matches; otherwise it restarts cleanly).
- **Pre-download validation** — page count, non-empty pages, text presence,
  missing/untranslated blocks, target language, title and file structure are
  checked in the worker *before* a file is offered. Error findings block the
  download until you explicitly accept them, warnings never block, and
  nothing is ever auto-fixed or silently downloaded.
- **Secondary formats** — DOCX (a real OOXML package with headings, lists,
  tables, hyperlinks and one section per source page so size/orientation
  survive), HTML, plain text, Markdown and a restorable JSON envelope of the
  document model. They render in the worker from the same model the PDF
  uses, and never at the cost of PDF quality.
- **Export Center** — format and layout options, queue progress with
  pause/retry/cancel (retry continues from the saved page), validation
  findings with links to the affected pages, and a gated download.

## Project layout

```
src/
  components/   layout (shell, sidebar, header), ui kit, analysis, job/project
                and translation (workflow, editor) widgets
  config/       centralized configuration, routes, navigation, languages
  core/         errors (AppError), logging, event bus, small utilities
  db/           schema, entities, database, typed repositories
  domain/       job state machine, analysis pipeline (IR, layout, structure,
                reading order, text formats, DOCX, language detection),
                provider failover (backoff, tokens, key selection, batching,
                translation prompts), glossary, translation memory, validation,
                export (fonts/segmentation, text layout, layout plan,
                secondary formats, pre-download validation)
  hooks/        reusable data/async, settings, jobs, system hooks
  i18n/         provider, dictionaries (my/en), formatting
  jobs/         persistent queue, handlers (analysis, translation, export),
                actions, bootstrap
  pages/        one file per route
  providers/    catalog, registry, transport, verification, adapters,
                error classification, model registry
  routes/       route table
  security/     key vault
  services/     business logic over the repositories (analysis driver, key
                pool, translation engine, glossary, translation memory,
                validation, unit editing, OCR (registry + on-device Tesseract),
                model catalog,
                export orchestration)
  state/        toast provider
  styles/       design tokens and flat, modern CSS
  workers/      analysis worker + session/client stack, PDF extraction,
                export worker (layout/painting/validation, secondary formats)
test-fixtures/  generated PDFs (normal, headings, lists, tables, Burmese, scanned, rotated)
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and
[CHANGELOG.md](./CHANGELOG.md) for what shipped in each phase.

## Documentation

| Document | What it covers |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | layering, data model, jobs, workers, security, testing |
| [API_PROVIDERS.md](./API_PROVIDERS.md) | provider setup, BYOK, key management, free vs paid, quotas/rate limits |
| [TRANSLATION_PIPELINE.md](./TRANSLATION_PIPELINE.md) | analysis → batches → failover → validation, resume and offline behavior |
| [PDF_PIPELINE.md](./PDF_PIPELINE.md) | PDF inspection and analysis: extraction, layout, reading order, units |
| [EXPORT_PIPELINE.md](./EXPORT_PIPELINE.md) | export worker, fonts, layout plan, checkpoints, validation, formats |
| [OFFLINE_FIRST.md](./OFFLINE_FIRST.md) | local-first data, offline mode, optional cloud sync, Google Apps Script |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | common failures, recovery paths, known limitations |
| [TODO.md](./TODO.md) | phase status, next work items, deliberate scope limits |

## Data, privacy and keys

- All project/document/job data lives in **IndexedDB** on this device.
- Provider API keys live only in the **encrypted `secretVault` store**; the
  app stores metadata (a masked hint, verification status) separately.
- BYOK means the keys are **yours and browser-side**: they are used directly
  from this client, so only use keys you are comfortable running from a
  client application, and restrict their quota/scope at the provider. The
  API Keys page says this explicitly.
- Raw keys are never logged, never placed in URLs, and never leave the
  browser except in the request header to the provider you configured.
- Sync payloads are **deep-redacted** before they are queued; Google Sheets is
  never used as a secret store and is never a PDF engine.
- Settings can export/import or wipe all local data from **Settings →
  Data**.

## Deployment

The build output is a static bundle (`dist/`). Because routing is
history-based, configure your host to serve `index.html` for unknown paths
(SPA fallback / "rewrite all to index.html"). `vite preview` already does this
locally.

## Phases

- **Phase 1** — architecture, UI, local database, job states, worker
  infrastructure, provider adapter interfaces, settings, error handling.
- **Phase 2** — document analysis pipeline: validation, parsing,
  per-page/block persistence with resume, reading order, structure
  classification, translation units, language detection, real progress UI.
- **Phase 3** — production BYOK provider system: typed provider
  errors, health-aware multi-key failover with quota-aware pausing,
  resumable batched translation, model registry with pricing labels, honest
  usage reporting.
- **Phase 4** — translation workflow: terminology glossary,
  translation memory, post-translation validation, strategy-aware runs with
  live progress, and the professional editing workspace with manual-edit
  protection.
- **Phase 5 (this build)** — structure-preserving export: worker-rendered
  PDF with HarfBuzz-shaped Burmese fonts, layout plan, per-page checkpoints
  and resume, pre-download validation, secondary formats (DOCX/HTML/TXT/
  Markdown/JSON) and the Export Center UI. Cloud sync stays optional and
  metadata-only.

The per-phase prompts live in [`prompts-phases/`](./prompts-phases/).
