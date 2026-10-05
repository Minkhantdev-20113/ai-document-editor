/**
 * Export PDF session (Phase 5): planned pages → one PDF document.
 *
 * The session owns a single pdf-lib document for the whole export, so the
 * Burmese font is embedded once instead of once per page, and pages can be
 * painted one RPC call at a time (UI stays responsive, a failed page can be
 * retried in place).
 *
 * Painting mirrors the planner: Latin runs use the standard fonts, Burmese runs
 * are positioned from HarfBuzz advances — one Tm per jump (marks, reordered
 * medials) and one shared show string while the viewer's advance matches ours.
 * `checkpoint()` serializes whatever is painted so a crash resumes from page N
 * instead of page 1.
 */
import fontkit from '@pdf-lib/fontkit';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  beginText,
  degrees,
  endText,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingRgbColor,
  setFontAndSize,
  setTextMatrix,
  showText,
  type PDFContext,
  type PDFPage,
  type PDFFont,
  type PDFOperator,
  type StandardFonts,
} from 'pdf-lib';
import { AppError } from '../core/errors/appError';
import type { BBox } from '../domain/analysis/ir';
import { buildRenderPlan } from '../domain/export/layoutPlan';
import { segmentText, type ExportFontSelection, type FontRole } from '../domain/export/fonts';
import type { FontStyle } from '../domain/export/textLayout';
import type {
  ExportDocumentInput,
  ExportWarning,
  PlannedBlock,
  PlannedLine,
  PlannedPage,
  PlannedTableBlock,
  RenderPlan,
  RenderPlanStats,
} from '../domain/export/types';
import { ExportTextEngine, type ShapedRun } from './exportTextEngine';
import { fetchFontBytes, type FontBytesLoader } from './exportFontSources';

/** Glyph-position tolerance for sharing one show operator, in points. */
const FLAT_TOLERANCE = 0.02;
const TABLE_LINE_COLOR = rgb(0.35, 0.35, 0.35);
const GRID_THICKNESS = 0.5;
const PRODUCER = 'AI Document Translator';

export interface ExportPdfMeta {
  readonly title: string;
  readonly subject?: string;
  readonly keywords?: readonly string[];
}

export interface PrepareOptions {
  /** Resume from a previous checkpoint when the plan still matches. */
  readonly resume?: { readonly bytes: Uint8Array; readonly signature: string };
  /** `false` reflows into the source page margins instead of preserving boxes. */
  readonly keepLayout?: boolean;
}

export interface PrepareResult {
  readonly pages: number;
  readonly warnings: readonly ExportWarning[];
  readonly stats: RenderPlanStats;
  readonly signature: string;
  /** Pages already present in the resumed document (0 when starting fresh). */
  readonly resumedFrom: number;
}

interface PreparedRun {
  readonly role: FontRole;
  readonly text: string;
  readonly shaped: ShapedRun | null;
}

interface PreparedLine {
  readonly line: PlannedLine;
  readonly style: FontStyle;
  readonly runs: readonly PreparedRun[];
}

export class ExportPdfSession {
  private plan: RenderPlan | null = null;
  private painted = 0;
  private readonly latinFonts = new Map<StandardFonts, PDFFont>();
  private readonly burmeseFonts = new Map<'regular' | 'bold', PDFFont>();
  private readonly fontKeys = new Map<PDFFont, PDFName>();

  private constructor(
    readonly engine: ExportTextEngine,
    private doc: PDFDocument,
  ) {}

  static async create(
    fonts: ExportFontSelection,
    loadBytes: FontBytesLoader = fetchFontBytes,
  ): Promise<ExportPdfSession> {
    const engine = await ExportTextEngine.create(fonts, loadBytes);
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    return new ExportPdfSession(engine, doc);
  }

  /** Pages painted so far (also the resume point). */
  get renderedPages(): number {
    return this.painted;
  }

  /** The current plan (read by the worker's pre-download validation). */
  get renderPlan(): RenderPlan | null {
    return this.plan;
  }

  /**
   * Lays the document out and, when a checkpoint matches the new plan,
   * reloads it so painting continues where the previous attempt stopped.
   */
  async prepare(document: ExportDocumentInput, options: PrepareOptions = {}): Promise<PrepareResult> {
    const plan = buildRenderPlan(document, {
      metrics: this.engine.metrics,
      keepLayout: options.keepLayout ?? true,
    });
    const signature = planSignature(document, plan);
    this.plan = plan;
    this.painted = 0;

    if (options.resume) {
      await this.tryRestore(options.resume, signature, plan);
    }

    return {
      pages: plan.pages.length,
      warnings: plan.warnings,
      stats: plan.stats,
      signature,
      resumedFrom: this.painted,
    };
  }

  /** Paints plan page `index` (must be the next unpainted page). */
  async paintPage(index: number): Promise<void> {
    const planPage = this.planPage(index);
    if (index !== this.painted) {
      throw new AppError(`Export expected page ${this.painted}, received ${index}`, {
        code: 'validation',
      });
    }
    await this.ensureFonts(planPage);

    const before = this.doc.getPageCount();
    const page = this.doc.addPage([planPage.width, planPage.height]);
    if (planPage.rotation !== 0) page.setRotation(degrees(planPage.rotation));
    // Font resource names are per page: register them again on this page.
    this.fontKeys.clear();

    try {
      for (const block of planPage.blocks) {
        if (block.type === 'table') this.paintTableGrid(page, planPage, block);
        for (const line of this.shapeBlock(block)) this.paintLine(page, planPage, line);
        if (block.link) this.addLink(page, planPage, block.link, block.bbox);
      }
    } catch (error) {
      // Never leave a half-painted page behind: the retry paints it again.
      if (this.doc.getPageCount() > before) this.doc.removePage(this.doc.getPageCount() - 1);
      throw error;
    }

    this.painted = index + 1;
  }

  /** Serializes everything painted so far (crash-recovery artifact). */
  async checkpoint(): Promise<Uint8Array> {
    return this.doc.save();
  }

  /** Sets document metadata and returns the finished PDF bytes. */
  async finish(meta: ExportPdfMeta): Promise<Uint8Array> {
    this.doc.setTitle(meta.title);
    if (meta.subject !== undefined) this.doc.setSubject(meta.subject);
    if (meta.keywords !== undefined) this.doc.setKeywords([...meta.keywords]);
    this.doc.setProducer(PRODUCER);
    this.doc.setCreator(PRODUCER);
    this.doc.setCreationDate(new Date());
    this.doc.setModificationDate(new Date());
    return this.doc.save();
  }

  private async tryRestore(
    resume: { bytes: Uint8Array; signature: string },
    signature: string,
    plan: { pages: readonly PlannedPage[] },
  ): Promise<void> {
    if (resume.signature !== signature) return;
    try {
      const doc = await PDFDocument.load(resume.bytes);
      if (doc.getPageCount() > plan.pages.length) return;
      doc.registerFontkit(fontkit);
      this.doc = doc;
      this.painted = doc.getPageCount();
      // Font refs belong to the old document context.
      this.latinFonts.clear();
      this.burmeseFonts.clear();
      this.fontKeys.clear();
    } catch {
      // Unreadable checkpoint: start from page 1 rather than fail the export.
      this.painted = 0;
    }
  }

  private planPage(index: number): PlannedPage {
    const page = this.plan?.pages[index];
    if (!page) {
      throw new AppError(`Export has no planned page ${index}`, { code: 'validation' });
    }
    return page;
  }

  private async ensureFonts(planPage: PlannedPage): Promise<void> {
    const programs = new Set<StandardFonts>();
    const needs: { regular: boolean; bold: boolean } = { regular: false, bold: false };

    for (const block of planPage.blocks) {
      const style: FontStyle =
        block.type === 'table'
          ? { bold: false, italic: false }
          : { bold: block.bold, italic: block.italic, mono: block.monospace };
      for (const line of block.type === 'table' ? tableLines(block) : block.lines) {
        for (const run of segmentText(line.text)) {
          if (run.role === 'latin') programs.add(this.engine.latinProgram(style));
          else if (style.bold) needs.bold = true;
          else needs.regular = true;
        }
      }
    }

    for (const program of programs) {
      if (this.latinFonts.has(program)) continue;
      this.latinFonts.set(program, await this.doc.embedFont(program));
    }
    for (const [key, needed] of [
      ['regular', needs.regular],
      ['bold', needs.bold],
    ] as const) {
      if (!needed || this.burmeseFonts.has(key)) continue;
      // Subset: false — pdf-lib's subsetter only learns about glyphs it encodes
      // itself, and Burmese is drawn from HarfBuzz glyph ids. The full face is
      // embedded exactly once for the whole document.
      this.burmeseFonts.set(key, await this.doc.embedFont(this.engine.burmeseBytes(key === 'bold'), { subset: false }));
    }
  }

  /** Shapes every line of one block (Burmese runs become HarfBuzz glyph runs). */
  private shapeBlock(block: PlannedBlock): PreparedLine[] {
    const style: FontStyle =
      block.type === 'table'
        ? { bold: false, italic: false }
        : { bold: block.bold, italic: block.italic, mono: block.monospace };
    return (block.type === 'table' ? tableLines(block) : block.lines).map((line) => ({
      line,
      style,
      runs: segmentText(line.text).map((run) => ({
        role: run.role,
        text: run.text,
        shaped: run.role === 'burmese' ? this.engine.shapeBurmese(run.text, line.size, style.bold === true) : null,
      })),
    }));
  }

  private fontKey(page: PDFPage, font: PDFFont): PDFName {
    const existing = this.fontKeys.get(font);
    if (existing) return existing;
    const key = page.node.newFontDictionary(font.name, font.ref);
    this.fontKeys.set(font, key);
    return key;
  }

  private paintLine(page: PDFPage, planPage: PlannedPage, job: PreparedLine): void {
    const y = planPage.height - job.line.baselineY;
    const ops: PDFOperator[] = [pushGraphicsState(), beginText(), setFillingRgbColor(0, 0, 0)];
    let x = job.line.x;
    for (const run of job.runs) {
      x =
        run.role === 'latin'
          ? this.paintLatinRun(page, ops, job, run, x, y)
          : this.paintBurmeseRun(page, ops, job, run, x, y);
    }
    ops.push(endText(), popGraphicsState());
    page.pushOperators(...ops);
  }

  private paintLatinRun(
    page: PDFPage,
    ops: PDFOperator[],
    job: PreparedLine,
    run: PreparedRun,
    x: number,
    y: number,
  ): number {
    const size = job.line.size;
    const program = this.engine.latinProgram(job.style);
    const font = this.latinFonts.get(program);
    if (!font) throw new AppError(`Export font not embedded: ${program}`, { code: 'worker_failed' });
    const key = this.fontKey(page, font);
    const spacing = job.line.wordSpacing;

    if (spacing <= 0) {
      ops.push(setFontAndSize(key, size), setTextMatrix(1, 0, 0, 1, x, y), showText(font.encodeText(run.text)));
      return x + this.engine.width(run.text, 'latin', size, job.style);
    }

    // Justified: every space of the run grows by `wordSpacing`. Runs never span
    // scripts, so a line's spaces all live in its Latin runs.
    let pen = x;
    const pieces = run.text.split(' ');
    for (const [index, piece] of pieces.entries()) {
      if (piece !== '') {
        ops.push(setFontAndSize(key, size), setTextMatrix(1, 0, 0, 1, pen, y), showText(font.encodeText(piece)));
        pen += this.engine.width(piece, 'latin', size, job.style);
      }
      if (index < pieces.length - 1) {
        pen += this.engine.width(' ', 'latin', size, job.style) + spacing;
      }
    }
    return pen;
  }

  private paintBurmeseRun(
    page: PDFPage,
    ops: PDFOperator[],
    job: PreparedLine,
    run: PreparedRun,
    x: number,
    y: number,
  ): number {
    const size = job.line.size;
    const bold = job.style.bold === true;
    const shaped = run.shaped;
    if (!shaped) return x;
    const font = this.burmeseFonts.get(bold ? 'bold' : 'regular');
    if (!font) return x + shaped.width;

    ops.push(setFontAndSize(this.fontKey(page, font), size));

    let pen = x;
    let groupStartX = x;
    let group: number[] = [];
    const flushGroup = () => {
      if (group.length === 0) return;
      ops.push(
        setTextMatrix(1, 0, 0, 1, groupStartX, y),
        showText(PDFHexString.of(group.map(toHexGlyphId).join(''))),
      );
      group = [];
    };

    for (const glyph of shaped.glyphs) {
      if (glyph.id === 0) {
        // Notdef: nothing drawable, but the pen must still advance.
        flushGroup();
        pen += glyph.advance;
        groupStartX = pen;
        continue;
      }

      const flat =
        glyph.xOffset === 0 &&
        glyph.yOffset === 0 &&
        Math.abs(this.engine.burmeseGlyphAdvancePoints(glyph.id, size, bold) - glyph.advance) <
          FLAT_TOLERANCE;

      if (flat) {
        if (group.length === 0) groupStartX = pen;
        group.push(glyph.id);
        pen += glyph.advance;
        continue;
      }

      flushGroup();
      ops.push(
        setTextMatrix(1, 0, 0, 1, pen + glyph.xOffset, y + glyph.yOffset),
        showText(PDFHexString.of(toHexGlyphId(glyph.id))),
      );
      pen += glyph.advance;
      groupStartX = pen;
    }
    flushGroup();

    return pen;
  }

  /** Table borders (cell text is painted like any other line). */
  private paintTableGrid(page: PDFPage, planPage: PlannedPage, block: PlannedTableBlock): void {
    const { rows, columns, bbox } = block;
    if (rows.length === 0) return;
    const height = planPage.height;
    const left = bbox.x;
    const right = bbox.x + bbox.width;

    for (const row of rows) {
      for (const edge of [row.y, row.y + row.height]) {
        page.drawLine({
          start: { x: left, y: height - edge },
          end: { x: right, y: height - edge },
          thickness: GRID_THICKNESS,
          color: TABLE_LINE_COLOR,
        });
      }
    }

    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const row of rows) {
      top = Math.min(top, row.y);
      bottom = Math.max(bottom, row.y + row.height);
    }
    for (const [index, column] of columns.entries()) {
      const edges = index === 0 ? [column.x, column.x + column.width] : [column.x + column.width];
      for (const edge of edges) {
        page.drawLine({
          start: { x: edge, y: height - top },
          end: { x: edge, y: height - bottom },
          thickness: GRID_THICKNESS,
          color: TABLE_LINE_COLOR,
        });
      }
    }
  }

  /** Link annotation; only plain web/mail targets become actions. */
  private addLink(page: PDFPage, planPage: PlannedPage, url: string, bbox: BBox): void {
    if (!isActionableLink(url)) return;
    const context = this.doc.context;

    const action = PDFDict.withContext(context);
    action.set(PDFName.of('S'), PDFName.of('URI'));
    action.set(PDFName.of('URI'), PDFHexString.of(bytesToHex(url)));

    const annot = PDFDict.withContext(context);
    annot.set(PDFName.of('Type'), PDFName.of('Annot'));
    annot.set(PDFName.of('Subtype'), PDFName.of('Link'));
    annot.set(PDFName.of('Rect'), rectOf(context, bbox, planPage.height));
    const border = PDFArray.withContext(context);
    border.push(PDFNumber.of(0));
    border.push(PDFNumber.of(0));
    border.push(PDFNumber.of(0));
    annot.set(PDFName.of('Border'), border);
    annot.set(PDFName.of('A'), context.register(action));

    page.node.addAnnot(context.register(annot));
  }
}

function tableLines(block: PlannedTableBlock): PlannedLine[] {
  const lines: PlannedLine[] = [];
  for (const row of block.rows) {
    for (const cell of row.cells) {
      for (const line of cell.lines) lines.push(line);
    }
  }
  return lines;
}

function rectOf(context: PDFContext, bbox: BBox, pageHeight: number): PDFArray {
  const array = PDFArray.withContext(context);
  array.push(PDFNumber.of(bbox.x));
  array.push(PDFNumber.of(pageHeight - (bbox.y + bbox.height)));
  array.push(PDFNumber.of(bbox.x + bbox.width));
  array.push(PDFNumber.of(pageHeight - bbox.y));
  return array;
}

/** Identity of a plan: checkpoints only resume when this still matches. */
function planSignature(document: ExportDocumentInput, plan: { stats: RenderPlanStats; pages: readonly PlannedPage[] }): string {
  return [
    document.title,
    document.targetLanguage,
    plan.stats.sourcePages,
    plan.pages.length,
    plan.stats.characters,
  ].join('|');
}

export function isActionableLink(url: string): boolean {
  const value = url.trim().toLowerCase();
  return value.startsWith('https://') || value.startsWith('http://') || value.startsWith('mailto:');
}

function toHexGlyphId(id: number): string {
  let hex = id.toString(16).padStart(4, '0');
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return hex;
}

function bytesToHex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
