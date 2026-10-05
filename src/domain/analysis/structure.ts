import type { BlockAlignment, BlockFlag, BlockKind, FontInfo, RawFont } from './ir';
import type { GroupedLine, LinePart } from './lines';
import type { ParagraphBlock } from './layout';

/**
 * Structure classification: tables, font statistics and block kinds
 * (heading / list / caption / paragraph / other). All decisions are heuristic
 * but deterministic, so re-analysis of the same bytes yields identical blocks.
 */

export interface TableDraft {
  /** One entry per row; each row holds the aligned cell parts. */
  readonly rows: readonly (readonly LinePart[])[];
  readonly lines: readonly GroupedLine[];
}

export interface FontStats {
  /** Characters-weighted dominant text size of the page. */
  readonly bodySize: number;
  /** Number of distinct half-point sizes with meaningful text. */
  readonly distinctSizes: number;
  readonly maxSize: number;
}

export interface Classification {
  readonly kind: BlockKind;
  readonly headingLevel?: number;
  readonly listOrdered?: boolean;
  readonly flags: readonly BlockFlag[];
}

export interface ClassificationContext {
  readonly stats: FontStats;
  readonly pageHeight: number;
  /** Gap below the block (computed by the caller from the next block). */
  readonly gapBelow: number;
  /** Resolves whether a line's font is bold. */
  readonly boldOf: (fontKey: string) => boolean;
}

const MAX_CELL_WORDS = 4;
const MAX_CELL_CHARS = 40;

function wordCount(text: string): number {
  let count = 0;
  let inWord = false;
  for (const char of text) {
    const isSpace = char === ' ' || char === '\t';
    if (!isSpace && !inWord) {
      count += 1;
      inWord = true;
    } else if (isSpace) {
      inWord = false;
    }
  }
  return count;
}

function isTableCandidateLine(line: GroupedLine): boolean {
  if (line.list !== null) return false;
  if (line.parts.length < 2) return false;
  return line.parts.every((part) => wordCount(part.text) <= MAX_CELL_WORDS && part.text.length <= MAX_CELL_CHARS);
}

function columnsMatch(cells: readonly LinePart[], columns: readonly LinePart[]): boolean {
  if (cells.length !== columns.length) return false;
  const used = new Set<number>();
  for (const cell of cells) {
    const center = cell.bbox.x + cell.bbox.width / 2;
    let matched = -1;
    for (let index = 0; index < columns.length; index += 1) {
      if (used.has(index)) continue;
      const column = columns[index]!;
      const columnCenter = column.bbox.x + column.bbox.width / 2;
      const tolerance = Math.max(6, 0.25 * column.bbox.width);
      // Left-aligned tables match on the left edge; centered ones on centers.
      const leftAligned = Math.abs(cell.bbox.x - column.bbox.x) <= tolerance;
      const centerAligned = Math.abs(center - columnCenter) <= tolerance;
      if (leftAligned || centerAligned) {
        matched = index;
        break;
      }
    }
    if (matched < 0) return false;
    used.add(matched);
  }
  return true;
}

/**
 * Detects table blocks: ≥2 consecutive lines whose short parts align into the
 * same columns. Consumed lines are removed from the paragraph flow.
 */
export function detectTables(lines: readonly GroupedLine[]): {
  readonly tables: TableDraft[];
  readonly rest: GroupedLine[];
} {
  const ordered = [...lines].sort((a, b) => a.baseline - b.baseline || a.bbox.x - b.bbox.x);
  const tables: TableDraft[] = [];
  const rest: GroupedLine[] = [];

  let group: GroupedLine[] = [];
  let columns: LinePart[] = [];

  const close = (nextLine: GroupedLine | null): void => {
    if (group.length >= 2) {
      tables.push({ rows: group.map((line) => line.parts), lines: group });
    } else {
      rest.push(...group);
    }
    group = [];
    columns = [];
    if (nextLine && isTableCandidateLine(nextLine)) {
      group = [nextLine];
      columns = [...nextLine.parts];
    }
  };

  for (const line of ordered) {
    if (!isTableCandidateLine(line)) {
      if (group.length > 0) close(null);
      rest.push(line);
      continue;
    }
    if (group.length === 0) {
      group = [line];
      columns = [...line.parts];
      continue;
    }
    const last = group[group.length - 1]!;
    const rowGap = line.baseline - last.baseline;
    const near = rowGap <= 1.75 * Math.max(line.fontSize, last.fontSize);
    if (near && columnsMatch(line.parts, columns)) {
      group.push(line);
      continue;
    }
    close(line);
  }
  if (group.length > 0) close(null);

  return { tables, rest };
}

/** Characters-weighted dominant size = body text; also counts size variety. */
export function computeFontStats(lines: readonly GroupedLine[]): FontStats {
  const weights = new Map<number, number>();
  let maxSize = 0;
  for (const line of lines) {
    const size = Math.round(line.fontSize * 2) / 2;
    const chars = line.text.trim().length;
    if (chars === 0) continue;
    weights.set(size, (weights.get(size) ?? 0) + chars);
    maxSize = Math.max(maxSize, line.fontSize);
  }
  let bodySize = 12;
  let best = -1;
  for (const [size, weight] of weights) {
    if (weight > best) {
      best = weight;
      bodySize = size;
    }
  }
  let distinctSizes = 0;
  for (const [, weight] of weights) {
    if (weight >= 8) distinctSizes += 1;
  }
  return { bodySize, distinctSizes, maxSize };
}

const FIGURE_CAPTION = /^(fig(?:ure)?|tab(?:le)?|chart|graph|plate|schema)\s*\.?\s*\d/i;
const BURMESE_CAPTION = /^(ရုပ်|ဇယား)/;
const PAGE_NUMBER = /^([0-9]{1,4}|[IVXLivxl]{1,6})$/;
const LATIN_LETTERS = /[A-Za-z]/;

function headingLevelFor(ratio: number): number {
  if (ratio >= 2) return 1;
  if (ratio >= 1.6) return 2;
  if (ratio >= 1.4) return 3;
  if (ratio >= 1.28) return 4;
  return 5;
}

function charCountOf(block: ParagraphBlock): number {
  let count = 0;
  for (const line of block.lines) count += line.text.trim().length;
  return count;
}

/** Pure structural classification (image-adjacent captions are refined later). */
export function classifyBlock(block: ParagraphBlock, context: ClassificationContext): Classification {
  const { stats, pageHeight, gapBelow, boldOf } = context;
  const size = medianSize(block.lines);
  const ratio = stats.bodySize > 0 ? size / stats.bodySize : 1;
  const chars = charCountOf(block);
  const short = chars <= 220 && block.lines.length <= 3;
  const first = block.lines[0]!;
  const text = first.text.trim();

  // Page numbers and running headers/footers are layout furniture.
  const nearTop = block.bbox.y <= pageHeight * 0.06;
  const nearBottom = block.bbox.y + block.bbox.height >= pageHeight * 0.94;
  if (block.lines.length === 1 && PAGE_NUMBER.test(text) && (nearTop || nearBottom || block.gapAbove > size * 2)) {
    return { kind: 'other', flags: ['page_number'] };
  }
  if (
    block.lines.length <= 2 &&
    chars <= 90 &&
    (nearTop || nearBottom) &&
    size <= stats.bodySize * 1.1
  ) {
    return { kind: 'other', flags: ['header_footer'] };
  }

  // Lists: every line carries a marker (grouped by the paragraph stage).
  if (first.list !== null) {
    return { kind: 'list', listOrdered: first.list.ordered, flags: [] };
  }

  // Headings: larger type, or bold/uppercase with breathing room around it.
  const isolated = block.gapAbove >= size * 0.4 || gapBelow >= size * 0.4;
  if (short && ratio >= 1.2) {
    return { kind: 'heading', headingLevel: headingLevelFor(ratio), flags: [] };
  }
  if (short && ratio >= 1.08 && hasBoldLine(block, boldOf) && isolated) {
    return { kind: 'heading', headingLevel: headingLevelFor(Math.max(ratio, 1.2)), flags: [] };
  }
  if (
    short &&
    block.lines.length <= 2 &&
    ratio >= 1.05 &&
    LATIN_LETTERS.test(text) &&
    text === text.toUpperCase()
  ) {
    return { kind: 'heading', headingLevel: headingLevelFor(Math.max(ratio, 1.2)), flags: [] };
  }

  // Captions that announce themselves (Figure 1, ဇယား ၁ …).
  if (chars <= 200 && block.lines.length <= 2 && (FIGURE_CAPTION.test(text) || BURMESE_CAPTION.test(text))) {
    return { kind: 'caption', flags: [] };
  }

  return { kind: 'paragraph', flags: [] };
}

function medianSize(lines: readonly GroupedLine[]): number {
  const sizes = lines.map((line) => line.fontSize).sort((a, b) => a - b);
  const mid = Math.floor(sizes.length / 2);
  if (sizes.length === 0) return 12;
  return sizes.length % 2 === 1 ? sizes[mid]! : (sizes[mid - 1]! + sizes[mid]!) / 2;
}

function hasBoldLine(block: ParagraphBlock, boldOf: (fontKey: string) => boolean): boolean {
  return block.lines.some((line) => boldOf(line.fontKey));
}

/** Text alignment from line edge spread inside the block. */
export function alignmentOf(lines: readonly GroupedLine[], blockWidth: number): BlockAlignment {
  if (lines.length < 2) return 'left';
  const lefts = lines.map((line) => line.bbox.x);
  const rights = lines.map((line) => line.bbox.x + line.bbox.width);
  const centers = lines.map((line) => line.bbox.x + line.bbox.width / 2);
  const spread = (values: readonly number[]): number => Math.max(...values) - Math.min(...values);
  const tolerance = Math.max(3, blockWidth * 0.02);

  if (lines.length >= 3 && spread(lefts) <= tolerance && spread(rights) <= tolerance) return 'justify';
  if (spread(lefts) <= tolerance) return 'left';
  if (spread(centers) <= tolerance) return 'center';
  if (spread(rights) <= tolerance) return 'right';
  return 'left';
}

export function fontOf(lines: readonly GroupedLine[], fonts: readonly RawFont[]): FontInfo {
  const lookup = new Map(fonts.map((font) => [font.key, font]));
  let bestKey = lines[0]?.fontKey ?? '';
  let bestChars = -1;
  const votes = new Map<string, number>();
  for (const line of lines) {
    votes.set(line.fontKey, (votes.get(line.fontKey) ?? 0) + line.text.trim().length);
  }
  for (const [key, chars] of votes) {
    if (chars > bestChars) {
      bestChars = chars;
      bestKey = key;
    }
  }
  const font = lookup.get(bestKey);
  const hasBold = font?.bold ?? false;
  const hasItalic = font?.italic ?? false;
  return {
    family: font?.family ?? 'sans-serif',
    size: medianSize(lines),
    bold: hasBold,
    italic: hasItalic,
  };
}

/** Resolves the bold flag used during paragraph merging. */
export function makeBoldChecker(fonts: readonly RawFont[]): (fontKey: string) => boolean {
  const lookup = new Map(fonts.map((font) => [font.key, font.bold]));
  return (fontKey: string) => lookup.get(fontKey) ?? false;
}
