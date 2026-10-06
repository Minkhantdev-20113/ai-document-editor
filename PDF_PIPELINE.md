# PDF inspection & analysis pipeline

What happens between "you drop a PDF in" and "the app can translate it"
(Phases 1–2). Export is documented separately in
[EXPORT_PIPELINE.md](./EXPORT_PIPELINE.md).

## Goals

- **Per-page truth** — geometry, rotation, block bboxes and reading order are
  stored per page, so later stages (translation, export) work from structure,
  not from a flat text dump.
- **Resume, never restart** — pages commit one at a time; a refresh, abort or
  crash resumes from the first unanalyzed page.
- **Honest gaps** — if something cannot be read (image-only page, unsupported
  PDF feature), the app says so instead of inventing content.

## Stage 1 — inspection (`inspect_document`)

`jobs/handlers/inspectDocument.ts` → `services/documentInspectionService`:

1. validates the file (size limit, type/extension, `pdf-lib` can open it),
2. reads metadata: page count, page sizes, rotation, file-level metadata
   (title/author/producer/creation date) — used later by export metadata and
   `documentTitle()`,
3. probes each page for extractable text and for images; a page with no text
   becomes `status: 'needs_ocr'`,
4. persists `documents.pageCount`, `charCount` and `inspectionState: 'ready'`.

**Inspection never fills these pages in.** A page is `needs_ocr` because it has
no selectable text, and stage 1 only probes: reading happens in stage 2 through
`services/ocr/ocrService.ts`, which rasterizes the page to PNG inside the
analysis worker and hands it to the engine registered in
`services/ocrRegistry.ts` (on-device Tesseract,
`services/ocr/tesseractOcr.ts`). If the document's language ships no model, or
rasterization/recognition fails, the page stays `needs_ocr` — no text is
fabricated and it is never sent for translation as if it had content.

## Stage 2 — analysis (`inspect_document` with analysis)

`workers/analysis.worker.ts` runs the pure pipeline in `domain/analysis/`:

| Step | Module | Output |
| --- | --- | --- |
| extract | `workers/pdfExtract.ts` (PDF.js) | text runs, images (CTM stack), per-page IR |
| line grouping | `domain/analysis/lines.ts` | baselines → `LineIR` |
| layout | `domain/analysis/layout.ts` | columns/blocks with bboxes, font info |
| reading order | `domain/analysis/readingOrder.ts` | stable `orderIndex` across columns |
| structure | `domain/analysis/structure.ts` | `heading/list/table/caption/quote/code` + flags |
| units | `domain/analysis/pipeline.ts` | `translationUnits` per block |
| OCR (image-only pages only) | `services/ocr/ocrService.ts` + `tesseractOcr.ts` | recognized lines re-entering `analyzePage` |

Non-PDF inputs (DOCX, Markdown, HTML, plain text, CSV, JSON) flow through the
same stages with a format-specific source, so everything downstream —
translation and export — sees one model.

### What the structure stage detects

- **Headings** — by size/weight/case relative to body text → `headingLevel`.
- **Lists** — ordered (`listOrdered: true`) vs bulleted (`false`).
- **Tables** — cell grid with bboxes → `TableIR` (columns + rows).
- **Links** — target kept on the block for export.
- **Page furniture** — page numbers and header/footer blocks are *flagged*
  (`page_number`, `header_footer`) and never become translation units.
- **Font facts** — family/size/bold/italic per block, used by the export
  layout and by glyph-coverage checks.

### Persistence and resume

- `documentPages` and `documentBlocks` are written **per page** (unique
  `documentId+pageIndex`, `documentId+orderIndex`), `translationUnits`
  immediately after each page's blocks.
- Units carry `sourceChecksum`, so re-analysis preserves the translation of
  unchanged text and only re-creates units for changed text.
- Progress is broadcast as `analysis:progress` (stage, task, page x/y,
  counts), which the Analysis view renders live (stage, page matrix, block
  table).
- A failure marks that page `failed` with its error and continues; retry
  re-enters at the first page that is not `ready`.
- Language detection runs over the analyzed text with visible confidence;
  below the threshold the UI asks you to confirm the source language instead
  of guessing.

## Timeouts and limits

- Inspection jobs enqueue with `analysisJobTimeoutMs` (10 min); the generic
  default is 2 min, translation/export 30 min.
- Worker RPC calls time out client-side (5 min) so a wedged worker becomes a
  typed error the queue can retry instead of a hung UI.

## Testing

`test-fixtures/pdfFixtures.ts` builds real PDFs in memory (paragraphs,
headings, lists, tables, mixed fonts, Burmese, rotated, scanned) and
`workers/analysisSession.test.ts` runs the identical pipeline in-process, so
assertions are made against genuine documents rather than recorded snapshots.

## Known limitations

- OCR reads English and Burmese only: an image-only page in any other
  language stays `needs_ocr` instead of being read with the wrong model.
- PDF forms, digital signatures, annotations and embedded JS are not
  re-created anywhere (they are ignored on read and absent from export).
- Charts/figures are detected as image content for analysis purposes but are
  **not** re-drawn by the exporter (text and vector structure are).
- Very dense multi-column layouts can reorder imperfectly; the block table in
  the Analysis view makes that visible so you can fix text before exporting.
