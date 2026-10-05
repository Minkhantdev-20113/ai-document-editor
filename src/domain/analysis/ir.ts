/**
 * Document Intermediate Representation (IR).
 *
 * The analysis pipeline transforms every supported input (PDF, TXT, Markdown,
 * DOCX) into this structure. All coordinates use top-left origin page space
 * (x grows right, y grows down) so previews, thumbnails and exporters can use
 * them directly without PDF user-space flips.
 *
 * Identity rules:
 * - page id    = `${documentId}_p${pageIndex}`
 * - block id   = `${pageId}_b${readingOrder}`
 * - line id    = `${blockId}_l${lineIndex}`
 * Ids are deterministic for identical inputs, so re-analysis replaces records
 * in place instead of duplicating them.
 */

/** Axis-aligned box in top-left origin page space (points). */
export interface BBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Typography of a block, resolved from the source document when available. */
export interface FontInfo {
  /** Family name when known (e.g. "Helvetica"), otherwise a category. */
  readonly family: string;
  /** Point size (median across the block's lines). */
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
}

export type BlockKind =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'caption'
  | 'quote'
  | 'code'
  | 'other';

export type BlockAlignment = 'left' | 'center' | 'right' | 'justify';

export type BlockFlag = 'page_number' | 'header_footer';

/** One visual line of text (already grouped from raw runs). */
export interface LineIR {
  readonly id: string;
  readonly text: string;
  readonly bbox: BBox;
  readonly fontSize: number;
}

export interface TableCellIR {
  readonly text: string;
  readonly bbox: BBox;
}

export interface TableRowIR {
  readonly cells: readonly TableCellIR[];
}

export interface TableIR {
  readonly columns: number;
  readonly rows: readonly TableRowIR[];
}

export interface BlockIR {
  readonly id: string;
  readonly kind: BlockKind;
  /** Canonical text: lines joined with \n, table rows joined with \n. */
  readonly text: string;
  readonly bbox: BBox;
  readonly lines: readonly LineIR[];
  readonly font: FontInfo;
  readonly alignment: BlockAlignment;
  /** Zero-based reading order within the page. */
  readonly readingOrder: number;
  /** 1..6 when kind === 'heading'. */
  readonly headingLevel?: number;
  /** True when kind === 'list' and items are numbered/lettered. */
  readonly listOrdered?: boolean;
  readonly table?: TableIR;
  /** URL when the block overlaps a link annotation. */
  readonly link?: string;
  readonly flags: readonly BlockFlag[];
}

export interface ImageRegion {
  readonly bbox: BBox;
}

export type PageWarningCode =
  /** Page has images but no selectable text. */
  | 'needs_ocr'
  /** Page produced no text and no images. */
  | 'empty'
  /** Unusually many blocks/lines on one page. */
  | 'dense'
  /** More than one text column detected. */
  | 'columns'
  /** At least one table block detected. */
  | 'tables'
  /** Many distinct font sizes (complex formatting). */
  | 'mixed_fonts'
  /** Page has a non-zero rotation. */
  | 'rotated'
  /** Some blocks failed during analysis. */
  | 'partial';

export interface PageIR {
  readonly id: string;
  readonly index: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly blocks: readonly BlockIR[];
  readonly images: readonly ImageRegion[];
  readonly warnings: readonly PageWarningCode[];
  /** True when the page appears to contain images but no selectable text. */
  readonly requiresOcr: boolean;
  readonly charCount: number;
  /** Analysis duration in milliseconds (measured by the pipeline). */
  readonly durationMs: number;
}

/** File-level metadata extracted during the metadata stage. */
export interface DocumentMetadata {
  readonly title: string | null;
  readonly author: string | null;
  readonly subject: string | null;
  readonly producer: string | null;
  readonly creator: string | null;
  readonly creationDate: string | null;
  /** Container/format hint, e.g. PDF version or word processor. */
  readonly format: string | null;
}

/** Result of source-language detection (see languageDetect.ts). */
export interface LanguageDetection {
  readonly code: string;
  /** 0..1 - below LANGUAGE_CONFIRM_THRESHOLD the UI asks the user to confirm. */
  readonly confidence: number;
  /** Normalized 0..1 score per candidate language. */
  readonly scores: Readonly<Record<string, number>>;
  readonly sampleChars: number;
}

/** Confidence below this value requires explicit user confirmation. */
export const LANGUAGE_CONFIRM_THRESHOLD = 0.65;

export type AnalysisStage =
  | 'validating'
  | 'parsing'
  | 'page_analysis'
  | 'units'
  | 'language'
  | 'finalizing'
  | 'done'
  | 'failed';

export type AnalysisTask =
  | 'idle'
  | 'open_document'
  | 'analyzing_pages'
  | 'saving_results'
  | 'detecting_language';

/** Live, persisted progress of one analysis run (per document). */
export interface AnalysisProgress {
  readonly stage: AnalysisStage;
  readonly task: AnalysisTask;
  readonly processedPages: number;
  readonly totalPages: number;
  readonly blocks: number;
  readonly failedPages: number;
  readonly startedAt: number;
  readonly updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Raw input produced by format extractors before the shared pipeline. */
/* ------------------------------------------------------------------ */

/**
 * One text run extracted from the source file.
 * `bbox.height` equals `fontSize` and the baseline sits at
 * `bbox.y + bbox.height * 0.8`, which the line grouper uses for alignment.
 */
export interface RawTextItem {
  readonly text: string;
  readonly bbox: BBox;
  readonly fontSize: number;
  /** Groups runs that share typography (pdf.js fontName, or a synthetic key). */
  readonly fontKey: string;
  /** Hard line break after this run (pdf.js hasEOL). */
  readonly hasEol?: boolean;
}

export interface RawFont {
  readonly key: string;
  readonly family: string;
  readonly bold: boolean;
  readonly italic: boolean;
}

export interface RawLink {
  readonly bbox: BBox;
  readonly url: string;
}

/** Page content straight from an extractor, before grouping/classification. */
export interface RawPageInput {
  readonly index: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly items: readonly RawTextItem[];
  readonly fonts: readonly RawFont[];
  readonly images: readonly ImageRegion[];
  readonly links: readonly RawLink[];
}

export function pageIdFor(documentId: string, pageIndex: number): string {
  return `${documentId}_p${pageIndex}`;
}
