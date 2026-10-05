/**
 * Layout reconstruction (Phase 5): turns analysis blocks + translations into
 * a structure-preserving {@link RenderPlan}.
 *
 * Overflow strategy from the phase spec, in order:
 * 1. reflow inside the available bounds (wrap to the block column),
 * 2. adjust line wrapping,
 * 3. expand the block where safe (later blocks move down with it),
 * 4. rebalance surrounding content (reading order keeps its spacing),
 * 5. create a continuation page when a block runs past the page bottom,
 * 6. never silently clip: text that cannot fit is drawn wider and warned about.
 *
 * All geometry stays in top-left origin page space, and the whole module is
 * pure - metrics arrive through {@link TextMetrics}.
 */
import { isMyanmarText, missingGlyphs } from './fonts';
import { measureLine, overflowingLines, wrapText, type TextMetrics, type FontStyle } from './textLayout';
import type {
  ExportBlockInput,
  ExportDocumentInput,
  ExportPageInput,
  ExportWarning,
  ExportWarningCode,
  PageMargins,
  PlannedBlock,
  PlannedLine,
  PlannedPage,
  PlannedTableCell,
  PlannedTableRow,
  RenderPlan,
} from './types';

export interface PlanOptions {
  readonly metrics: TextMetrics;
  /** Preserve original geometry (default) or reflow into a single column. */
  readonly keepLayout?: boolean;
}

const HEADING_SCALE: readonly number[] = [1.5, 1.3, 1.18, 1.06, 1.0, 0.94];
const DEFAULT_SIZE = 11;
const MIN_SIZE = 7;
const MAX_SIZE = 48;
const FALLBACK_MARGIN = 56;
const FLOW_GAP = 10;
const TABLE_PADDING = 4;
const EPSILON = 0.01;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function blockSize(block: ExportBlockInput): number {
  const base = clamp(block.font.size || DEFAULT_SIZE, MIN_SIZE, MAX_SIZE);
  if (block.kind === 'heading' && block.headingLevel) {
    return round(base * (HEADING_SCALE[block.headingLevel - 1] ?? 1));
  }
  if (block.kind === 'caption') return round(base * 0.85);
  return round(base);
}

/** Myanmar needs visibly more leading so stacked marks never collide. */
function lineHeightFor(text: string, size: number): number {
  return round(size * (isMyanmarText(text) ? 1.75 : 1.35));
}

function baselineOffset(size: number): number {
  return size * 0.82;
}

function pageMargins(page: ExportPageInput): PageMargins {
  if (page.blocks.length === 0) {
    return { left: FALLBACK_MARGIN, right: FALLBACK_MARGIN, top: FALLBACK_MARGIN, bottom: FALLBACK_MARGIN };
  }
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const block of page.blocks) {
    left = Math.min(left, block.bbox.x);
    top = Math.min(top, block.bbox.y);
    right = Math.max(right, block.bbox.x + block.bbox.width);
    bottom = Math.max(bottom, block.bbox.y + block.bbox.height);
  }
  const capX = page.width / 4;
  const capY = page.height / 4;
  return {
    left: clamp(left, 0, capX),
    top: clamp(top, 0, capY),
    right: clamp(page.width - right, 0, capX),
    bottom: clamp(page.height - bottom, 0, capY),
  };
}

function alignX(alignment: string, colX: number, colWidth: number, lineWidth: number): number {
  if (alignment === 'center') return colX + Math.max(0, (colWidth - lineWidth) / 2);
  if (alignment === 'right') return colX + Math.max(0, colWidth - lineWidth);
  return colX;
}

function justifySpacing(
  alignment: string,
  colWidth: number,
  line: string,
  width: number,
  isLast: boolean,
): number {
  if (alignment !== 'justify' || isLast) return 0;
  const spaces = line.split(' ').length - 1;
  if (spaces <= 0) return 0;
  const extra = (colWidth - width) / spaces;
  return extra > 0.01 ? extra : 0;
}

function lineBBox(lines: readonly PlannedLine[], fallback: { x: number; y: number; width: number }) {
  if (lines.length === 0) return { ...fallback, height: 0 };
  const top = Math.min(...lines.map((line) => line.baselineY - baselineOffset(line.size)));
  const bottom = Math.max(
    ...lines.map((line) => line.baselineY + (line.height - baselineOffset(line.size))),
  );
  const left = Math.min(...lines.map((line) => line.x));
  const right = Math.max(...lines.map((line) => line.x + line.width));
  return { x: left, y: top, width: Math.max(right - left, 0), height: Math.max(bottom - top, 0) };
}

/** Text to draw for a block: translations win, source is the honest fallback. */
function resolveText(block: ExportBlockInput, push: (code: ExportWarningCode, detail?: string) => void): string {
  const translated = block.translatedText?.trim() ? block.translatedText : null;
  if (translated) {
    if (translated.trim() === block.sourceText.trim()) {
      push('untranslated_block', 'translation equals the source text');
    }
    return translated;
  }
  if (block.unitStatus !== null) push('missing_translation', 'no translation stored for this block');
  return block.sourceText;
}

interface TablePlan {
  readonly columns: readonly { readonly x: number; readonly width: number }[];
  readonly rows: readonly PlannedTableRow[];
  readonly height: number;
  readonly reconstructed: boolean;
}

/** Rebuilds a table grid: original column x/width, row heights from content. */
function planTable(block: ExportBlockInput, top: number, size: number, metrics: TextMetrics): TablePlan {
  const table = block.table;
  if (!table || table.columns === 0) return { columns: [], rows: [], height: 0, reconstructed: true };
  const style = { bold: block.font.bold, italic: block.font.italic };

  const xPositions: number[] = [];
  const rightPositions: number[] = [];
  for (const row of table.rows) {
    for (const [index, cell] of row.cells.entries()) {
      const currentX = xPositions[index];
      const currentRight = rightPositions[index];
      xPositions[index] =
        currentX === undefined ? cell.bbox.x : Math.min(currentX, cell.bbox.x);
      rightPositions[index] =
        currentRight === undefined
          ? cell.bbox.x + cell.bbox.width
          : Math.max(currentRight, cell.bbox.x + cell.bbox.width);
    }
  }

  const fallbackWidth = block.bbox.width / table.columns;
  const columns = Array.from({ length: table.columns }, (_, index) => {
    const x = xPositions[index] ?? block.bbox.x + index * fallbackWidth;
    const right = rightPositions[index] ?? x + fallbackWidth;
    return { x, width: Math.max(12, right - x) };
  });

  const reconstructed = table.rows.some((row) => row.cells.length !== table.columns);
  const rows: PlannedTableRow[] = [];
  let y = top;

  for (const row of table.rows) {
    const cells: PlannedTableCell[] = [];
    let rowHeight = TABLE_PADDING * 2;

    for (const [index, column] of columns.entries()) {
      const cell = row.cells[index];
      const innerWidth = Math.max(8, column.width - TABLE_PADDING * 2);
      const wrapped = cell ? wrapText(cell.text, { maxWidth: innerWidth, size, metrics, style }) : [];
      const lines: PlannedLine[] = [];
      let cursor = y + TABLE_PADDING;
      for (const text of wrapped) {
        const height = lineHeightFor(text, size);
        lines.push({
          text,
          x: column.x + TABLE_PADDING,
          baselineY: cursor + baselineOffset(size),
          width: measureLine(text, size, metrics, style),
          size,
          height,
          wordSpacing: 0,
        });
        cursor += height;
      }
      rowHeight = Math.max(rowHeight, cursor - y + TABLE_PADDING);
      cells.push({ x: column.x, width: column.width, lines });
    }

    rows.push({ y, height: rowHeight, cells });
    y += rowHeight;
  }

  return {
    columns,
    rows,
    height: y - top,
    reconstructed,
  };
}

interface PageState {
  part: number;
  flow: boolean;
  cursor: number;
  blocks: PlannedBlock[];
}

export function buildRenderPlan(doc: ExportDocumentInput, options: PlanOptions): RenderPlan {
  const keepLayout = options.keepLayout ?? true;
  const warnings: ExportWarning[] = [];
  const pages: PlannedPage[] = [];
  let characterCount = 0;

  const push = (code: ExportWarningCode, extra: Partial<ExportWarning>): void => {
    warnings.push({ code, ...extra });
  };

  for (const page of doc.pages) {
    const margins = pageMargins(page);
    const bottomLimit = page.height - margins.bottom;
    const ordered = [...page.blocks].sort((a, b) => a.orderIndex - b.orderIndex);
    const flowWidth = Math.max(48, page.width - margins.left - margins.right);

    const state: PageState = {
      part: 0,
      flow: !keepLayout,
      cursor: keepLayout ? (ordered[0]?.bbox.y ?? margins.top) : margins.top,
      blocks: [],
    };

    const flush = (): void => {
      pages.push({
        sourcePageIndex: page.pageIndex,
        part: state.part,
        width: page.width,
        height: page.height,
        rotation: page.rotation,
        margins,
        blocks: state.blocks,
      });
      state.part += 1;
      state.flow = true;
      state.blocks = [];
      state.cursor = margins.top;
    };

    for (const block of ordered) {
      const indent = block.kind === 'list' ? 12 : block.kind === 'quote' ? 16 : 0;
      const size = blockSize(block);
      const monospace = block.kind === 'code';

      // Tables keep their grid and move whole - a split table loses structure.
      if (block.kind === 'table' && block.table) {
        for (;;) {
          const grid = planTable(block, state.cursor, size, options.metrics);
          if (state.cursor + grid.height > bottomLimit + EPSILON && state.blocks.length > 0) {
            flush();
            continue;
          }
          if (grid.reconstructed) {
            push('table_reconstructed', { blockId: block.blockId, pageIndex: page.pageIndex });
          }
          const x = state.flow ? margins.left : block.bbox.x;
          state.blocks.push({
            type: 'table',
            blockId: block.blockId,
            kind: 'table',
            sourceBBox: block.bbox,
            bbox: { x, y: state.cursor, width: flowWidth, height: grid.height },
            columns: grid.columns.map((column) => ({ x: column.x, width: column.width })),
            rows: grid.rows,
            link: block.link,
            part: state.part,
            reconstructed: grid.reconstructed,
          });
          state.cursor += grid.height + FLOW_GAP;
          break;
        }
        continue;
      }

      const text = resolveText(block, (code, detail) =>
        push(code, {
          blockId: block.blockId,
          pageIndex: page.pageIndex,
          ...(detail ? { detail } : {}),
        }),
      );
      characterCount += text.length;

      if (text.trim() === '') {
        push('source_empty', { blockId: block.blockId, pageIndex: page.pageIndex });
        continue;
      }
      const missing = missingGlyphs(text);
      if (missing.length > 0) {
        push('glyph_missing', {
          blockId: block.blockId,
          pageIndex: page.pageIndex,
          detail: missing.join(' '),
        });
      }

      const colWidth = Math.max(12, (state.flow ? flowWidth : block.bbox.width) - indent);
      const baseX = (state.flow ? margins.left : block.bbox.x) + indent;
      const wrapOptions = {
        maxWidth: colWidth,
        size,
        metrics: options.metrics,
        style: { bold: block.font.bold, italic: block.font.italic, mono: block.kind === 'code' },
      };
      const lines = wrapText(text, wrapOptions);
      if (overflowingLines(lines, wrapOptions).length > 0) {
        push('text_overflow', { blockId: block.blockId, pageIndex: page.pageIndex });
      }

      let remaining = lines.length > 0 ? lines : [text];
      let warnedContinuation = false;

      while (remaining.length > 0) {
        const top = state.flow ? state.cursor : Math.max(block.bbox.y, state.cursor);
        const minLine = lineHeightFor(remaining[0] ?? '', size);

        // Page already full: start a continuation page before drawing anything.
        if (state.blocks.length > 0 && top + minLine > bottomLimit + EPSILON) {
          flush();
          continue;
        }

        const placed = placeLines(remaining, {
          colX: state.flow ? margins.left : baseX,
          colWidth: state.flow ? flowWidth : colWidth,
          top,
          bottomLimit,
          size,
          alignment: block.alignment,
          metrics: options.metrics,
          style: wrapOptions.style,
        });

        const bbox = lineBBox(placed.placed, {
          x: state.flow ? margins.left : baseX,
          y: top,
          width: state.flow ? flowWidth : colWidth,
        });

        state.blocks.push({
          type: 'text',
          blockId: block.blockId,
          kind: block.kind,
          sourceBBox: block.bbox,
          bbox,
          lines: placed.placed,
          bold: block.font.bold,
          italic: block.font.italic,
          alignment: block.alignment,
          monospace,
          link: block.link,
          part: state.part,
        });

        const placedBottom = bbox.y + bbox.height;
        state.cursor = state.flow
          ? placedBottom + FLOW_GAP
          : Math.max(placedBottom, block.bbox.y + block.bbox.height);

        if (placed.remainder.length === 0) break;

        if (!warnedContinuation) {
          push('block_continued', {
            blockId: block.blockId,
            pageIndex: page.pageIndex,
            detail: block.blockId,
          });
          warnedContinuation = true;
        }
        remaining = placed.remainder;
        flush();
      }
    }

    flush();
  }

  const textBlocks = pages.reduce(
    (sum, page) => sum + page.blocks.filter((block) => block.type === 'text').length,
    0,
  );

  return {
    pages,
    warnings,
    stats: {
      sourcePages: doc.pages.length,
      pages: pages.length,
      blocks: textBlocks,
      characters: characterCount,
    },
  };
}

function placeLines(
  lines: readonly string[],
  ctx: {
    colX: number;
    colWidth: number;
    top: number;
    bottomLimit: number;
    size: number;
    alignment: string;
    metrics: TextMetrics;
    style?: FontStyle;
  },
): { placed: PlannedLine[]; remainder: string[] } {
  const placed: PlannedLine[] = [];
  const remainder: string[] = [];
  let y = ctx.top;

  for (const [index, text] of lines.entries()) {
    const height = lineHeightFor(text, ctx.size);
    const width = measureLine(text, ctx.size, ctx.metrics, ctx.style);
    const fits = y + height <= ctx.bottomLimit + EPSILON;

    // Never clip: everything after the first break continues on a new page.
    if (!fits && placed.length > 0) {
      remainder.push(...lines.slice(index));
      break;
    }

    placed.push({
      text,
      x: alignX(ctx.alignment, ctx.colX, ctx.colWidth, width),
      baselineY: y + baselineOffset(ctx.size),
      width,
      size: ctx.size,
      height,
      wordSpacing: justifySpacing(ctx.alignment, ctx.colWidth, text, width, index === lines.length - 1),
    });
    y += height;
  }

  return { placed, remainder };
}
