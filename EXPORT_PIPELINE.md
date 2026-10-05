# Export pipeline

How a translated document becomes a validated file (Phase 5), what runs where,
and what happens when a run is interrupted.

## Guarantees

1. **Never on the main thread** — layout, HarfBuzz shaping, page painting, PDF
   generation and container builds all run in `src/workers/export.worker.ts`.
   The main thread fetches records, persists checkpoints and renders progress.
2. **Never a patched original** — the exported PDF is *rebuilt* from the
   analysed block/bbox model. Extracted text is never copied into the original
   file's content streams.
3. **Never silently clipped** — overflowing text is reflowed (wrap → expand the
   block → rebalance → continuation page) instead of being cut off.
4. **Never a silent download** — a file is offered only after validation.
   Error findings block it until the user explicitly accepts it; warnings never
   block; nothing is ever auto-fixed.

## Stage overview

```
Translated Document Model  →  Layout Reconstruction  →  Page Rendering
   exportDocumentBuilder          domain/export/layoutPlan      ExportPdfSession (worker)
        │                                  │                            │
        ▼                                  ▼                            ▼
 TranslationUnit rows              plan + warnings + signature     checkpoint every 10 pages
                                                                          │
                                                                          ▼
                         Validation (worker)  →  Artifact (IndexedDB)  →  Download (UI)
                          exportPdfValidator       exportArtifacts         gated by findings
```

| Stage | Code | Runs in |
| --- | --- | --- |
| Build the model | `services/exportDocumentBuilder.ts` | main thread (record join only) |
| Plan the layout | `domain/export/layoutPlan.ts` | **worker** (`prepare`) |
| Shape + paint pages | `workers/exportPdfRenderer.ts` | **worker** (`paint(i)`) |
| Checkpoint | `doc.save()` every 10 pages | **worker** (`checkpoint`) |
| Validate | `workers/exportPdfValidator.ts` | **worker** (`validate`) |
| Persist + gate | `services/exportService.ts` | main thread |
| Download | `components/export/ExportResultList.tsx` | main thread (Blob + click) |

`ExportCenterPage` → `ExportStartForm` enqueues an `export_document` job
(`jobs/actions.ts#startExport`: the document must be analyzed, duplicate runs
are deduplicated, the project's `exportState` becomes `queued`); the job
handler `jobs/handlers/exportDocument.ts` maps the service outcome onto the
job state machine.

## 1. Translated document model

`buildExportDocument({ document, pages, blocks, units, fileName })` walks
pages in index order, blocks in `orderIndex` (reading) order, and joins
`translationUnits` **by block id**:

- `translatedText` comes from the unit; a block with no unit or no translation
  keeps `translatedText: null` and stays in the model — the planner falls back
  to `sourceText` and validation reports `missing_translation` per block.
- Output overrides: `fileName` (`base-targetLang.ext`), `targetLanguage`.
- `title` comes from the embedded document metadata when present, otherwise
  the file name.

## 2. Layout reconstruction

`domain/export/layoutPlan.ts` turns the model into a `RenderPlan`:

- **`keepLayout: true` (default)** — each block keeps its analysed bbox
  (x/y/width/height) so headings, columns, lists and tables land where they
  did in the source; text is re-wrapped inside that width with the measured
  font metrics (`domain/export/textLayout.ts`).
- **`keepLayout: false`** — natural flow from the top margin: one column,
  blocks stacked in reading order.
- **Overflow policy** — a block that no longer fits the page grows into the
  remaining space, the remainder moves to a continuation (`block_continued`)
  on the next page, and pages beyond the source page count are appended
  (`page_count_mismatch` is *not* emitted for planned continuation pages).
- Warnings emitted: `missing_translation`, `text_overflow`, `block_continued`,
  `table_reconstructed`, `glyph_missing`, `source_empty`.

The plan never leaves the worker: `prepare` returns only `pages`, `warnings`,
`stats` and a **signature** (document id + page geometry + options) used to
decide whether a checkpoint may be resumed.

## 3. Page rendering

`ExportPdfSession` (pdf-lib + `@pdf-lib/fontkit` + HarfBuzz):

- One `PDFDocument` per export. Latin runs use the standard Times / Helvetica /
  Courier fonts (non-embedded, no license issue); Burmese runs are shaped with
  HarfBuzz and drawn with the **bundled Myanmar font embedded once** for the
  whole document (`subset: false`), which keeps a 100+ page document to a
  single embedding instead of megabytes per page.
- `paintPage(index)` rejects an out-of-order index; if painting throws, the
  half-painted page is dropped from the session so a checkpoint never claims a
  page that is not in the file.
- Page size, rotation, margins and order come from the analysed pages.
- Hyperlinks are emitted only for actionable targets (`isActionableLink`).
- Metadata: title, producer/creator (`AI Document Translator`), page count.

**Checkpoint**: `checkpoint()` serializes the current document
(`doc.save()`) — called every `CHECKPOINT_EVERY = 10` painted pages, plus on
failure and on cancel. Serialization is a byte copy, never a base64 string.

## 4. Validation (before any download)

Run inside the worker on the finished bytes (`exportPdfValidator.inspectPdf`):
`%PDF-` header → `PDFDocument.load` → per-page content probe for `Tj`/`TJ`
text operators (a page with no text operators is a *blank page*), mapped back
to plan page indexes.

`validateExport(...)` then merges plan and artifact checks and returns
`{ findings, pageCount, structurallyValid, blocking }`:

| Finding | Severity | Meaning |
| --- | --- | --- |
| `pdf_structure` | error | bytes are not a loadable PDF |
| `page_count_mismatch` | error | file pages ≠ planned pages |
| `language_mismatch` | error | artifact language ≠ requested language |
| `missing_text` | error | a page the plan expected has no text |
| `no_pages` | error | the plan produced nothing |
| `title_missing` | warning | no title for the file metadata |
| `empty_page` | warning | a page produced no content |
| `missing_translation`, `untranslated_block` | warning | source text was used |
| `glyph_missing` | warning | characters missing from the selected font |
| `text_overflow`, `block_continued`, `table_reconstructed` | warning | layout had to adapt |

Warnings are informational; only `severity === 'error'` blocks a download
(`hasBlockingFindings`). The Export Center lists every finding with its page,
links to the workspace for inspection, and offers **Download anyway** as an
explicit, deliberate action — never an automatic one.

## 5. Persistence, checkpoints and resume

`exportArtifacts` (one row per job):

```ts
{ jobId, projectId, documentId, format, fileName, signature, pageCount,
  renderedPages, state: 'rendering' | 'ready' | 'failed', bytes, findings,
  createdAt, updatedAt }
```

Ordering matters for crash safety: **bytes are persisted first, then the
findings** (the validation call transfers the buffer, so it runs after the
structured clone).

| Outcome | Stored state | Next run |
| --- | --- | --- |
| finished + valid | `ready` | download; a newer export of the same document prunes it |
| threw mid-run | `failed` with `renderedPages` | retry resumes at `renderedPages` **if** the plan signature matches, otherwise restarts at page 1 |
| cancelled / aborted | `rendering` with the checkpoint bytes | resume from the saved page |
| secondary format | `ready` (no plan) | rendered as a unit — no resume needed |

## 6. Formats

| Format | How it is produced | Notes |
| --- | --- | --- |
| `pdf` | layout plan + painting (above) | primary, structure-preserving |
| `docx` | `domain/export/docx.ts` → OOXML parts → `writeZipEntries` | `Heading1..6` styles, real tables/hyperlinks, one section per source page (size + landscape/portrait), title/language metadata |
| `html` | `domain/export/secondaryFormats.ts` | semantic tags, `lang` = target language, `<title>`, page `<hr>` separators, escaped content |
| `txt` | same | headings underlined, numbered/bulleted lists, delimited tables, form-feed page breaks |
| `md` | same | ATX headings, GFM tables, real links, `---` page separators |
| `json` | `serializeDocument()` | versioned envelope `adt-export-document` v1; `parseDocumentExportJson()` restores the model (round-trip tested) |

Secondary formats run in the worker through the stateless `format` request and
are probed before being stored (`inspectSecondaryFormat`: valid JSON parses,
HTML contains `<html>`/`</html>`, DOCX is a ZIP containing
`[Content_Types].xml` + `word/document.xml`). Their findings come from
`validateSecondaryArtifact` (same language/title/untranslated rules,
`container_corrupt` instead of `pdf_structure`).

## 7. Fonts

- Bundled, OFL-licensed, in `src/assets/fonts/`: **Padauk** (default) and
  **Noto Sans Myanmar**, each Regular + Bold, with the license file next to
  them.
- Settings → **Export fonts**: `exportLatinFont` (`times` | `helvetica` |
  `courier`) and `exportBurmeseFont` (`padauk` | `noto-sans-myanmar`).
- `domain/export/fonts.ts` segments text by Unicode range (Myanmar vs Latin),
  so each run is measured/shaped/drawn with the font that actually covers it;
  `missingGlyphs()` reports characters neither font covers.

## 8. Performance rules

- One worker per stage of work: the export worker owns layout, shaping,
  painting, serialization, validation and container builds.
- The plan, bytes and messages move as **structured clones / transferables** —
  no base64, no JSON-stringified buffers, no repeated `ArrayBuffer` copies.
- Artifacts are stored once (structured clone), validation transfers the
  buffer after that, so a multi-megabyte PDF exists at most twice in memory.
- The Export Center reloads artifacts only when the *set of finished jobs*
  changes, never on progress ticks.
- `exportJobTimeoutMs` = 30 min; the client RPC timeout is 5 min per call and
  the worker self-terminates when idle.

## 9. Failure and recovery matrix

| Failure | Behaviour |
| --- | --- |
| paint throws | checkpoint saved as `failed`, worker closed, job → `failed`, retry resumes at the saved page |
| RPC timeout / worker crash | typed `AppError`, same `failed` checkpoint path |
| cancel | abort check between pages, checkpoint saved as `rendering`, job → `cancelled` |
| refresh mid-export | `jobQueue.init()` recovers the job to `queued`; the checkpoint is still on disk |
| validation errors | artifact stored with `ready` state *and* findings; download blocked until accepted |
| corrupt container | `structurallyValid: false` → `container_corrupt` / `pdf_structure` (error) — the file is never offered as normal |

## 10. Tests

- `domain/export/fonts.test.ts`, `textLayout.test.ts`, `layoutPlan.test.ts`,
  `validateExport.test.ts`, `secondaryFormats.test.ts`
- `core/utils/zip.test.ts` (writer ↔ reader round-trip, CRC-32)
- `workers/exportPdfRenderer.test.ts` (real rendering incl. Burmese,
  checkpoint resume, one font embed), `exportPdfValidator.test.ts`
- `services/exportDocumentBuilder.test.ts`, `services/exportService.test.ts`
  (fake IndexedDB + scripted session: happy path, crash → resume from the
  failed page, cancel, periodic checkpoint, secondary format)
