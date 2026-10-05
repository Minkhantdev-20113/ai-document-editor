import type { PDFDocumentProxy, PageViewport, PDFPageProxy } from 'pdfjs-dist';
import type * as PdfjsNamespace from 'pdfjs-dist';
import type {
  BBox,
  DocumentMetadata,
  ImageRegion,
  RawFont,
  RawLink,
  RawPageInput,
  RawTextItem,
} from '../domain/analysis/ir';

/**
 * PDF extraction (pdf.js layer).
 *
 * Everything that needs pdf.js lives here and receives the module as a
 * parameter, so the browser worker uses `pdfjs-dist` while tests inject the
 * Node-compatible `pdfjs-dist/legacy/build/pdf.mjs` build. The output is a
 * `RawPageInput` - plain data with no pdf.js types - which the pure analysis
 * pipeline in `domain/analysis` then classifies.
 *
 * Conventions:
 * - coordinates are unrotated content space (top-left origin); `PageIR.rotation`
 *   records the display rotation, so line grouping always sees horizontal text,
 * - a text run box spans `fontSize` in height with the baseline at 80% down,
 *   exactly the assumption `groupLines` makes.
 */
export type PdfjsModule = typeof PdfjsNamespace;

type PdfTextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;
type PdfTextStyle = PdfTextContent['styles'][string];
type PdfOperatorList = Awaited<ReturnType<PDFPageProxy['getOperatorList']>>;

/** Narrow views of pdf.js structures so no `any` escapes this module. */
interface PdfFontMetrics {
  readonly bold?: unknown;
  readonly italic?: unknown;
  readonly black?: unknown;
  readonly loadedName?: unknown;
}

interface PdfLinkAnnotation {
  readonly subtype?: unknown;
  readonly url?: unknown;
  readonly unsafeUrl?: unknown;
  readonly rect?: unknown;
}

interface PdfInfoDictionary {
  readonly Title?: unknown;
  readonly Author?: unknown;
  readonly Subject?: unknown;
  readonly Producer?: unknown;
  readonly Creator?: unknown;
  readonly CreationDate?: unknown;
  readonly PDFFormatVersion?: unknown;
}

export interface OpenedPdf {
  readonly doc: PDFDocumentProxy;
  readonly pageCount: number;
  readonly metadata: DocumentMetadata | null;
  /** Call on close to free the pdf.js worker and all cached objects. */
  readonly dispose: () => Promise<void>;
}

/** pdf.js internal font ids look like `g_d0_f1`; they carry no family name. */
const ANONYMOUS_FONT_ID = /^g_.*_f\d+$/;

/**
 * Parse and open a PDF for analysis.
 *
 * Rendering options are disabled on purpose: we only need text runs, font
 * metrics and image boxes, never pixels.
 */
export async function openPdf(ns: PdfjsModule, bytes: ArrayBuffer): Promise<OpenedPdf> {
  const task = ns.getDocument({ data: new Uint8Array(bytes), disableFontFace: true });
  try {
    const doc = await task.promise;
    const metadata = await readMetadata(doc);
    return {
      doc,
      pageCount: doc.numPages,
      metadata,
      dispose: async () => {
        await task.destroy().catch(() => undefined);
      },
    };
  } catch (error) {
    await task.destroy().catch(() => undefined);
    throw error;
  }
}

/** Extract every raw signal of one page: text runs, fonts, images, links. */
export async function extractPdfPage(
  ns: PdfjsModule,
  doc: PDFDocumentProxy,
  index: number,
): Promise<RawPageInput> {
  const page = await doc.getPage(index + 1);
  try {
    // Font objects are registered while the operator list is processed, so this
    // must complete before metrics are read - otherwise bold/italic come back
    // unknown. The same pass yields image paint operations.
    const operatorList = await page.getOperatorList();
    // rotation 0 = unrotated content space (see file header).
    const viewport = page.getViewport({ scale: 1, rotation: 0 });
    const content = await page.getTextContent();

    const items: RawTextItem[] = [];
    const fontKeys: string[] = [];
    const seenFonts = new Set<string>();
    for (const entry of content.items) {
      if (!('str' in entry) || entry.str.length === 0) continue;
      const style: PdfTextStyle | undefined = content.styles[entry.fontName];
      const fontKey = entry.fontName || 'f_unknown';
      items.push({
        text: entry.str,
        bbox: runBox(entry, style?.vertical === true, viewport),
        fontSize: fontSizeOf(entry.transform),
        fontKey,
        ...(entry.hasEOL ? { hasEol: true } : {}),
      });
      if (entry.fontName && !seenFonts.has(entry.fontName)) {
        seenFonts.add(entry.fontName);
        fontKeys.push(entry.fontName);
      }
    }

    return {
      index,
      width: viewport.width,
      height: viewport.height,
      rotation: normalizeRotation(page.rotate),
      items,
      fonts: fontKeys.map((key) => resolveFont(page, key, content.styles)),
      images: collectImages(ns, operatorList, viewport),
      links: await collectLinks(page, viewport),
    };
  } finally {
    page.cleanup();
  }
}

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

async function readMetadata(doc: PDFDocumentProxy): Promise<DocumentMetadata | null> {
  try {
    const result = await doc.getMetadata();
    const info = (result.info ?? {}) as PdfInfoDictionary;
    return {
      title: textOrNull(info.Title),
      author: textOrNull(info.Author),
      subject: textOrNull(info.Subject),
      producer: textOrNull(info.Producer),
      creator: textOrNull(info.Creator),
      creationDate: textOrNull(info.CreationDate),
      format: textOrNull(info.PDFFormatVersion),
    };
  } catch {
    return null;
  }
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/* ------------------------------------------------------------------ */
/* Text runs                                                           */
/* ------------------------------------------------------------------ */

/** Font size from the text matrix: the matrix's y-basis length for horizontal text. */
function fontSizeOf(transform: readonly unknown[]): number {
  const c = Number(transform[2] ?? 0);
  const d = Number(transform[3] ?? 0);
  const a = Number(transform[0] ?? 0);
  const b = Number(transform[1] ?? 0);
  return Math.hypot(c, d) || Math.hypot(a, b) || 10;
}

/** One text run's box in unrotated content space (top-left origin). */
function runBox(
  item: { readonly transform: readonly unknown[]; readonly width: number },
  vertical: boolean,
  viewport: PageViewport,
): BBox {
  const e = Number(item.transform[4] ?? 0);
  const f = Number(item.transform[5] ?? 0);
  const size = fontSizeOf(item.transform);
  const width = Number(item.width ?? 0);

  let x1: number;
  let y1: number;
  let x2: number;
  let y2: number;
  if (vertical) {
    // Vertical writing: runs advance downward, glyphs straddle the origin.
    x1 = e - size * 0.8;
    x2 = e + size * 0.2;
    y1 = f - Math.max(width, size * 0.5);
    y2 = f + size * 0.2;
  } else {
    // Horizontal: baseline at `f`, ascender 0.8em above / descender 0.2em below.
    x1 = e;
    x2 = e + width;
    y1 = f - size * 0.2;
    y2 = f + size * 0.8;
  }

  const [ax, ay] = toViewport(viewport, x1, y1);
  const [bx, by] = toViewport(viewport, x2, y2);
  return bounds(ax, ay, bx, by);
}

function toViewport(viewport: PageViewport, x: number, y: number): [number, number] {
  const point = viewport.convertToViewportPoint(x, y);
  return [Number(point[0] ?? 0), Number(point[1] ?? 0)];
}

function bounds(x1: number, y1: number, x2: number, y2: number): BBox {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function normalizeRotation(rotation: number): number {
  return ((Math.round(rotation) % 360) + 360) % 360;
}

/* ------------------------------------------------------------------ */
/* Fonts                                                               */
/* ------------------------------------------------------------------ */

function resolveFont(page: PDFPageProxy, key: string, styles: Record<string, PdfTextStyle>): RawFont {
  const style = styles[key];
  let family = typeof style?.fontFamily === 'string' && style.fontFamily !== '' ? style.fontFamily : null;
  let bold = false;
  let italic = false;

  const metrics = readFontMetrics(page, key);
  if (metrics) {
    bold = metrics.bold === true || metrics.black === true;
    italic = metrics.italic === true;
    const loaded = typeof metrics.loadedName === 'string' ? metrics.loadedName : null;
    if (loaded && !ANONYMOUS_FONT_ID.test(loaded)) family = loaded;
    // Standard-14 font objects do not always expose style flags: fall back to
    // the font name ("Helvetica-Bold", "Times-Italic", ...).
    const name = `${loaded ?? ''} ${family ?? ''}`;
    bold = bold || /\b(bold|black|heavy|semibold)\b/i.test(name);
    italic = italic || /\b(italic|oblique)\b/i.test(name);
  }

  return { key, family: family ?? 'unknown', bold, italic };
}

function readFontMetrics(page: PDFPageProxy, key: string): PdfFontMetrics | null {
  try {
    const value: unknown = page.commonObjs.get(key);
    if (value && typeof value === 'object') return value as PdfFontMetrics;
    return null;
  } catch {
    // Unresolved font (e.g. Type3 without metrics): fall back to the style hints.
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Images (operator-list transform tracking)                           */
/* ------------------------------------------------------------------ */

function collectImages(ns: PdfjsModule, list: PdfOperatorList, viewport: PageViewport): ImageRegion[] {
  const ops = ns.OPS;
  const paintOps = new Set<number>([
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintImageMaskXObject,
  ]);
  const images: ImageRegion[] = [];
  let ctm: number[] | null = null;
  const stack: Array<number[] | null> = [];

  for (let position = 0; position < list.fnArray.length; position += 1) {
    const fn = list.fnArray[position] ?? -1;
    const args: unknown = list.argsArray[position];

    if (fn === ops.save) {
      stack.push(ctm ? [...ctm] : null);
    } else if (fn === ops.restore) {
      ctm = stack.pop() ?? null;
    } else if (fn === ops.transform) {
      const matrix = asMatrix(args);
      if (matrix) ctm = concatenate(ctm, matrix);
    } else if (fn === ops.paintFormXObjectBegin) {
      // Mirrors the renderer: the form matrix is concatenated in place; the
      // form's own q/Q stream governs restoration.
      ctm = concatenate(ctm, formMatrix(args));
    } else if (paintOps.has(fn)) {
      if (!ctm) continue;
      const box = unitSquareBox(ctm);
      const [ax, ay] = toViewport(viewport, box[0], box[1]);
      const [bx, by] = toViewport(viewport, box[2], box[3]);
      const bbox = bounds(ax, ay, bx, by);
      // Ignore sub-pixel paint artifacts (glyph-cache masks etc.).
      if (bbox.width >= 1 && bbox.height >= 1) images.push({ bbox });
    }
  }

  return images;
}

/** The form matrix can arrive as args[0] (bbox first) or args[1]. */
function formMatrix(args: unknown): number[] | null {
  if (!Array.isArray(args)) return null;
  for (const candidate of args) {
    const matrix = asMatrix(candidate);
    if (matrix) return matrix;
  }
  return null;
}

function asMatrix(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 6) return null;
  const matrix = value.slice(0, 6).map(Number);
  return matrix.every((entry) => Number.isFinite(entry)) ? matrix : null;
}

/**
 * Concatenate `op` onto `base`: CTM' = base × op (column form).
 *
 * The newest `cm` must transform the point *first* (innermost), so e.g.
 * `translate(x,y)` followed by `scale(w,h)` maps the unit square to
 * `(x, y) … (x+w, y+h)` - not `(w·x, h·y)` offset by `w·x`.
 */
function concatenate(base: number[] | null, op: number[] | null): number[] | null {
  if (!op) return base;
  const b = base ?? [1, 0, 0, 1, 0, 0];
  const o = op;
  const b0 = b[0] ?? 1;
  const b1 = b[1] ?? 0;
  const b2 = b[2] ?? 0;
  const b3 = b[3] ?? 1;
  const b4 = b[4] ?? 0;
  const b5 = b[5] ?? 0;
  const o0 = o[0] ?? 1;
  const o1 = o[1] ?? 0;
  const o2 = o[2] ?? 0;
  const o3 = o[3] ?? 1;
  const o4 = o[4] ?? 0;
  const o5 = o[5] ?? 0;
  return [
    b0 * o0 + b2 * o1,
    b1 * o0 + b3 * o1,
    b0 * o2 + b2 * o3,
    b1 * o2 + b3 * o3,
    b0 * o4 + b2 * o5 + b4,
    b1 * o4 + b3 * o5 + b5,
  ];
}

/** Image xobjects paint their unit square through the CTM. */
function unitSquareBox(ctm: number[]): [number, number, number, number] {
  const points: Array<[number, number]> = [
    transformPoint(ctm, 0, 0),
    transformPoint(ctm, 1, 0),
    transformPoint(ctm, 0, 1),
    transformPoint(ctm, 1, 1),
  ];
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function transformPoint(m: number[], x: number, y: number): [number, number] {
  const m0 = m[0] ?? 1;
  const m1 = m[1] ?? 0;
  const m2 = m[2] ?? 0;
  const m3 = m[3] ?? 1;
  const m4 = m[4] ?? 0;
  const m5 = m[5] ?? 0;
  return [m0 * x + m2 * y + m4, m1 * x + m3 * y + m5];
}

/* ------------------------------------------------------------------ */
/* Links                                                               */
/* ------------------------------------------------------------------ */

async function collectLinks(page: PDFPageProxy, viewport: PageViewport): Promise<RawLink[]> {
  const links: RawLink[] = [];
  const annotations: unknown[] = await page.getAnnotations({ intent: 'display' });
  for (const entry of annotations) {
    if (!entry || typeof entry !== 'object') continue;
    const annotation = entry as PdfLinkAnnotation;
    if (annotation.subtype !== 'Link') continue;
    const url =
      typeof annotation.url === 'string' && annotation.url !== ''
        ? annotation.url
        : typeof annotation.unsafeUrl === 'string' && annotation.unsafeUrl !== ''
          ? annotation.unsafeUrl
          : null;
    if (!url || !Array.isArray(annotation.rect) || annotation.rect.length < 4) continue;
    const rect = annotation.rect.slice(0, 4).map(Number);
    if (!rect.every((value) => Number.isFinite(value))) continue;
    const [ax, ay] = toViewport(viewport, rect[0] ?? 0, rect[1] ?? 0);
    const [bx, by] = toViewport(viewport, rect[2] ?? 0, rect[3] ?? 0);
    const bbox = bounds(ax, ay, bx, by);
    if (bbox.width >= 1 && bbox.height >= 1) links.push({ bbox, url });
  }
  return links;
}
