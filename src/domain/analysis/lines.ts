import type { BBox, RawTextItem } from './ir';

/**
 * Line extraction: raw text runs → visual lines with cell ("part") awareness.
 *
 * A part is a run of text separated from its neighbours by a gap wider than a
 * word space. Parts are what make both table cells and multi-column layouts
 * detectable later: tables have short, vertically aligned parts, columns are
 * recovered by splitting parts across column regions.
 */

export interface LinePart {
  readonly text: string;
  readonly bbox: BBox;
}

export interface ListMarker {
  readonly ordered: boolean;
  readonly marker: string;
}

export interface GroupedLine {
  readonly parts: LinePart[];
  readonly text: string;
  readonly bbox: BBox;
  readonly baseline: number;
  readonly fontSize: number;
  readonly fontKey: string;
  readonly list: ListMarker | null;
  /** True once the extractor reported a hard break (pdf.js hasEOL). */
  closed: boolean;
}

interface WorkingItem {
  readonly item: RawTextItem;
  readonly baseline: number;
}

function unionBox(a: BBox, b: BBox): BBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function isWhitespaceOnly(item: RawTextItem): boolean {
  return item.text.trim() === '';
}

/** Baseline convention: bbox.height === fontSize, baseline at 80% of height. */
function baselineOf(item: RawTextItem): number {
  return item.bbox.y + item.bbox.height * 0.8;
}

const BULLET_MARKER = /^[•●▪◦‣·⁃*+\-–—]\s+/;
const ORDERED_MARKER = /^\(?(?:\d{1,3}|[a-zA-Z]|[ivxIVX]{1,5})[.)]\s+/;
const BURMESE_ORDERED_MARKER = /^\(?[၀-၉]{1,4}\)?[.)။]\s+/;

/** Detects a leading bullet/number marker on a line (used by classification). */
export function detectListMarker(text: string): ListMarker | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const bullet = BULLET_MARKER.exec(trimmed);
  if (bullet?.[0]) return { ordered: false, marker: bullet[0].trim() };
  const ordered = ORDERED_MARKER.exec(trimmed) ?? BURMESE_ORDERED_MARKER.exec(trimmed);
  if (ordered?.[0]) return { ordered: true, marker: ordered[0].trim() };
  return null;
}

/**
 * Groups raw runs into visual lines.
 *
 * Runs are sorted by baseline (then x) and merged when their baselines agree
 * within ~35% of the font size, so glyph-height differences inside a line do
 * not split it while real line advances always do.
 */
export function groupLines(items: readonly RawTextItem[]): GroupedLine[] {
  const working: WorkingItem[] = [];
  for (const item of items) {
    if (item.text.length === 0 && item.bbox.width <= 0) continue;
    working.push({ item, baseline: baselineOf(item) });
  }
  working.sort((a, b) => a.baseline - b.baseline || a.item.bbox.x - b.item.bbox.x);

  const lines: GroupedLine[] = [];
  let current: WorkingItem[] = [];
  let currentLine: GroupedLine | null = null;

  const flush = (): void => {
    if (currentLine && current.length > 0) {
      const built = buildLine(current, currentLine.closed);
      if (built) lines.push(built);
    }
    current = [];
    currentLine = null;
  };

  for (const workingItem of working) {
    const tolerance = currentLine
      ? Math.max(2, 0.35 * Math.min(workingItem.item.fontSize, currentLine.fontSize))
      : 0;
    if (currentLine && !currentLine.closed && Math.abs(workingItem.baseline - currentLine.baseline) <= tolerance) {
      current.push(workingItem);
      if (workingItem.item.hasEol) currentLine.closed = true;
      continue;
    }
    flush();
    current = [workingItem];
    currentLine = {
      parts: [],
      text: '',
      bbox: workingItem.item.bbox,
      baseline: workingItem.baseline,
      fontSize: workingItem.item.fontSize,
      fontKey: workingItem.item.fontKey,
      list: null,
      closed: Boolean(workingItem.item.hasEol),
    };
  }
  flush();

  return lines;
}

function buildLine(entries: readonly WorkingItem[], closed: boolean): GroupedLine | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => a.item.bbox.x - b.item.bbox.x);

  let bbox = sorted[0]!.item.bbox;
  let text = '';
  const parts: LinePart[] = [];
  let partText = '';
  let partBBox: BBox | null = null;
  let prevRight = -Infinity;
  let fontSize = 0;
  const fontVotes = new Map<string, number>();

  const closePart = (): void => {
    if (partText.trim() !== '' && partBBox) {
      parts.push({ text: partText.trim(), bbox: partBBox });
    }
    partText = '';
    partBBox = null;
  };

  for (const { item } of sorted) {
    bbox = unionBox(bbox, item.bbox);
    fontSize = Math.max(fontSize, item.fontSize);
    fontVotes.set(item.fontKey, (fontVotes.get(item.fontKey) ?? 0) + item.text.trim().length);

    const gap = prevRight === -Infinity ? 0 : item.bbox.x - prevRight;
    const whitespaceRun = isWhitespaceOnly(item) && item.bbox.width > 0;
    const separatorWidth = gap + (whitespaceRun ? item.bbox.width : 0);
    const partThreshold = Math.max(8, 1.4 * item.fontSize);
    const wordThreshold = Math.max(0.5, 0.12 * item.fontSize);

    if (separatorWidth >= partThreshold && !whitespaceRun) {
      // Wide geometric gap: this run starts a new cell/column segment.
      closePart();
      if (text && !text.endsWith(' ')) text += ' ';
    } else if (separatorWidth >= partThreshold && whitespaceRun) {
      // A wide whitespace run (common in tables) separates two cells.
      closePart();
      if (text && !text.endsWith(' ')) text += ' ';
      prevRight = item.bbox.x + item.bbox.width;
      continue;
    } else if (separatorWidth >= wordThreshold && text !== '' && !text.endsWith(' ')) {
      text += ' ';
      if (partBBox) partText += ' ';
    }

    if (!whitespaceRun || partText !== '') {
      if (partText === '' && !partBBox) partBBox = { ...item.bbox };
      else if (partBBox) partBBox = unionBox(partBBox, item.bbox);
      partText += item.text;
    }
    text += item.text;
    prevRight = item.bbox.x + item.bbox.width;
  }
  closePart();

  let dominant = sorted[0]!.item.fontKey;
  let dominantScore = -1;
  for (const [key, score] of fontVotes) {
    if (score > dominantScore) {
      dominant = key;
      dominantScore = score;
    }
  }

  const baseline = sorted[0]!.baseline;
  const trimmed = text.trim();
  if (trimmed === '' && parts.length === 0) {
    // Geometry-only lines (whitespace runs) still matter for column detection.
    if (bbox.width <= 0) return null;
    return {
      parts: [],
      text: '',
      bbox,
      baseline,
      fontSize: fontSize || 10,
      fontKey: dominant,
      list: null,
      closed,
    };
  }

  return {
    parts,
    text: trimmed,
    bbox,
    baseline,
    fontSize: fontSize || 10,
    fontKey: dominant,
    list: detectListMarker(trimmed),
    closed,
  };
}
