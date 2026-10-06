import type { DocumentMetadata, PageIR } from './ir';

/** Identity the source needs in order to mint deterministic IR ids. */
export interface OpenRequest {
  readonly documentId: string;
  readonly fileName: string;
}

/** Everything knowable about a document before any page is analyzed. */
export interface OpenedDocumentInfo {
  readonly pageCount: number;
  readonly metadata: DocumentMetadata | null;
  /** Title hint provided by the document itself (PDF title, markdown H1, HTML title). */
  readonly title: string | null;
}

/** A rendered page image plus the pixels-per-point scale it was drawn at. */
export interface PageRenderResult {
  readonly blob: Blob;
  /** Pixels per page point: `pixels / scale` lands back in IR coordinates. */
  readonly scale: number;
}

/**
 * Uniform read interface over every supported format.
 *
 * Sessions are stateful: `open` once, then `page(index)` for each page in any
 * order, then `close` exactly once. Two implementations run the identical
 * extraction + analysis code:
 *
 * - `analysisClient.ts`   → one Web Worker per session (browser, keeps UI free)
 * - `analysisSession.ts`  → in-process (tests, Node)
 *
 * so a result produced in a test is byte-identical to a result produced in
 * the app.
 */
export interface AnalysisSource {
  open(bytes: ArrayBuffer, request: OpenRequest): Promise<OpenedDocumentInfo>;
  /** Analyze one page. A rejection leaves the session usable (per-page retry). */
  page(index: number): Promise<PageIR>;
  /**
   * Rasterizes one page to PNG for OCR (image-only pages only). Returns null
   * when the environment cannot render - the page then keeps its `needs_ocr`
   * status rather than getting invented text. Absent on sources that do not
   * support rendering.
   */
  renderPage?(index: number): Promise<PageRenderResult | null>;
  close(): Promise<void>;
}
