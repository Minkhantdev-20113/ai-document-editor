# TODO

Status of the AI Document Translator and the honest list of what is left.
Completion claims here match the last verified run (see [CHANGELOG.md](./CHANGELOG.md));
limitations are cross-referenced to [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Status

| Phase | Scope | State |
| --- | --- | --- |
| Phase 1 | architecture, UI shell, local DB, job states, worker infra, provider adapter interfaces, settings, error handling | **done** (v0.1.0) |
| Phase 2 | document analysis pipeline: parsing, per-page/block persistence with resume, reading order, translation units | **done** (v0.2.0) |
| Phase 3 | BYOK providers: typed errors, multi-key failover, resumable batches, model registry, usage reporting | **done** (v0.3.0) |
| Phase 4 | translation workflow: glossary, memory, validation, editing workspace with manual-edit protection | **done** (v0.4.0) |
| Phase 5 | export: worker-rendered PDF with HarfBuzz Burmese fonts, checkpoints/resume, DOCX/HTML/TXT/MD/JSON, Export Center | **done** (v0.5.0) |
| 0.6 | on-device OCR: image-only pages read locally (Tesseract, `eng`/`mya`), honest `needs_ocr` fallback | **done** (v0.6.0) |
| 0.7 | free-tier model catalog: every model each provider serves free-of-charge (Gemini ×6, Groq ×3, OpenRouter `:free` ×6, Mistral on a compatible endpoint) with published rate limits | **done** (v0.7.0) |

Last verification: `tsc --noEmit` 0 errors, `eslint .` 0 errors,
`vitest run` 49 files / 416 tests passed, `vite build` succeeded.

## Next

Ordered by what removes the most user-visible gap first.

1. **Offline PWA shell.** No service worker or manifest exist yet
   (`vite.config.ts` has no PWA plugin), so the app is offline-capable only
   while the browser keeps its HTTP cache. Add a precached app shell so a cold
   start with no network works, and keep it out of the translation/export path
   (workers and IndexedDB already hold the real state).
2. **Wire the sync producers.** `syncService.queueChange()` is only reachable
   from the manual flush in Settings. Emit change records from the project,
   document and settings write paths so sync stays optional but current, then
   point it at the Apps Script receiver described in
   [OFFLINE_FIRST.md](./OFFLINE_FIRST.md). Payloads are already redacted,
   metadata-only and key-free.
3. **Sync pull/merge.** Sync is push-only today: no conflict resolution, no
   restore-from-remote. Needs a versioned merge policy before it is enabled by
   default.
4. **More OCR languages.** Only `eng` and `mya` models ship (that is why an
   image-only page in any other language stays `needs_ocr`). Add a
   `@tesseract.js-data/<lang>` devDependency, one line in
   `scripts/copy-ocr-assets.mjs` and one entry in
   `services/ocr/tesseractOcr.ts` per language — never read a page with the
   wrong model.
5. **Streaming translation UI.** One batch is one request/response; stream
   partial completions into the workspace without breaking batch resume.

## Known limitations (by design)

These are deliberate scope decisions, not forgotten work — rationale lives in
[ARCHITECTURE.md](./ARCHITECTURE.md) and
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

- **Export is structure-faithful, not pixel-identical.** Fonts are re-mapped
  (Latin: standard base-14; Burmese: bundled OFL Padauk/Noto Sans Myanmar),
  charts are not re-drawn, and forms/annotations/signatures are dropped.
- **No document images are sent to models** — only extracted text and
  structure. Token/cost figures are local estimates unless the provider
  reports usage.
- **Sync never carries keys or document text**; it is metadata-only
  (`projects | documents | settings`) and disabled by default.
- **Single-user, browser-local, no accounts, no telemetry, no server of
  ours.** API keys stay in the encrypted client-side vault (BYOK).

## Housekeeping

- Per-phase prompts: [`prompts-phases/`](./prompts-phases/).
- Add regression tests alongside any fix (`src/**/*.test.ts`); the suite is
  the gate for `npm run build`.
- Before each release: `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run build`, then update [CHANGELOG.md](./CHANGELOG.md).
