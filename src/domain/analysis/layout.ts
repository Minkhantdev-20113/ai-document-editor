import type { BBox } from './ir';
import type { GroupedLine, LinePart } from './lines';

/**
 * Layout recovery: column detection, column splitting and paragraph grouping.
 *
 * Columns are found with y-banded gutter voting: each horizontal band of the
 * page votes for gutters visible inside it, and only gutters that persist
 * across enough of the page become real column separators. A full-width title
 * therefore never hides the two-column body beneath it, while a lone short
 * line cannot invent a phantom column.
 */

export interface ColumnRegion {
  readonly x1: number;
  readonly x2: number;
}

export interface LineSegment extends GroupedLine {
  /** Index of the column region this segment belongs to. */
  readonly region: number;
}

const BAND_COUNT = 8;
const MIN_GUTTER_PT = 12;
const MAX_REGIONS = 4;

function binWidthFor(pageWidth: number): number {
  return Math.max(2, Math.round(pageWidth / 240));
}

export function unionBBox(a: BBox | null, b: BBox): BBox {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

interface Gutter {
  readonly x1: number;
  readonly x2: number;
}

/** Empty vertical strips wide enough to separate columns, per band. */
function guttersOf(lines: readonly GroupedLine[], pageWidth: number): Gutter[] {
  if (lines.length < 2) return [];
  const bin = binWidthFor(pageWidth);
  let start = Infinity;
  let end = -Infinity;
  const parts: LinePart[] = [];
  for (const line of lines) {
    for (const part of line.parts) {
      parts.push(part);
      start = Math.min(start, part.bbox.x);
      end = Math.max(end, part.bbox.x + part.bbox.width);
    }
  }
  if (parts.length === 0 || !Number.isFinite(start) || end <= start) return [];

  const to = Math.floor(end / bin);
  const counts = new Int32Array(to + 2);
  for (const part of parts) {
    const from = Math.floor(part.bbox.x / bin);
    const upto = Math.floor((part.bbox.x + part.bbox.width) / bin);
    for (let index = from; index <= upto; index += 1) {
      if (index >= 0 && index < counts.length) counts[index] = (counts[index] ?? 0) + 1;
    }
  }

  const minBins = Math.max(2, Math.ceil(MIN_GUTTER_PT / bin));
  const gutters: Gutter[] = [];
  let runStart = -1;
  const flush = (index: number): void => {
    if (runStart >= 0 && index - runStart >= minBins) {
      const x1 = runStart * bin;
      const x2 = Math.min(index * bin, Math.ceil(end));
      if (x1 >= start && x2 <= end) gutters.push({ x1, x2 });
    }
    runStart = -1;
  };
  for (let index = 0; index < counts.length; index += 1) {
    if (counts[index] === 0) {
      if (runStart < 0) runStart = index;
    } else {
      flush(index);
    }
  }
  return gutters;
}

/**
 * Computes page-level column regions by voting gutters across y bands.
 * Returns a single region when no consistent gutter exists.
 */
export function computeColumnRegions(lines: readonly GroupedLine[], pageWidth: number): ColumnRegion[] {
  if (lines.length === 0) return [{ x1: 0, x2: pageWidth }];
  let height = 0;
  for (const line of lines) height = Math.max(height, line.bbox.y + line.bbox.height);
  const bandHeight = Math.max(1, height / BAND_COUNT);
  const bin = binWidthFor(pageWidth);

  const votes = new Map<string, { gutter: Gutter; weight: number }>();
  for (let band = 0; band < BAND_COUNT; band += 1) {
    const from = band * bandHeight;
    const to = (band + 1) * bandHeight;
    const bandLines = lines.filter((line) => line.baseline >= from && line.baseline < to);
    if (bandLines.length < 2) continue;
    for (const gutter of guttersOf(bandLines, pageWidth)) {
      const key = `${Math.round(gutter.x1 / bin)}_${Math.round(gutter.x2 / bin)}`;
      const entry = votes.get(key);
      if (entry) entry.weight += bandLines.length;
      else votes.set(key, { gutter, weight: bandLines.length });
    }
  }

  const threshold = Math.max(3, Math.ceil(lines.length * 0.2));
  const accepted = [...votes.values()]
    .filter((entry) => entry.weight >= threshold)
    .sort((a, b) => b.weight - a.weight || b.gutter.x2 - b.gutter.x1 - (a.gutter.x2 - a.gutter.x1))
    .slice(0, MAX_REGIONS - 1)
    .map((entry) => entry.gutter)
    .sort((a, b) => a.x1 - b.x1);

  if (accepted.length === 0) return [{ x1: 0, x2: pageWidth }];

  const regions: ColumnRegion[] = [];
  let cursor = 0;
  for (const gutter of accepted) {
    if (gutter.x1 > cursor) regions.push({ x1: cursor, x2: gutter.x1 });
    cursor = gutter.x2;
  }
  regions.push({ x1: cursor, x2: pageWidth });
  const usable = regions.filter((region) => region.x2 - region.x1 >= MIN_GUTTER_PT);
  return usable.length > 0 ? usable : [{ x1: 0, x2: pageWidth }];
}

export function regionOf(centerX: number, regions: readonly ColumnRegion[]): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index]!;
    const distance =
      centerX < region.x1 ? region.x1 - centerX : centerX > region.x2 ? centerX - region.x2 : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

function lineBBox(parts: readonly LinePart[]): BBox {
  let bbox: BBox | null = null;
  for (const part of parts) bbox = unionBBox(bbox, part.bbox);
  return bbox ?? { x: 0, y: 0, width: 0, height: 0 };
}

/**
 * Splits lines whose parts live in different column regions so paragraphs
 * never bleed across columns. Single-region lines pass through untouched,
 * keeping their exact original spacing.
 */
export function splitLinesByRegion(lines: readonly GroupedLine[], regions: readonly ColumnRegion[]): LineSegment[] {
  const segments: LineSegment[] = [];
  for (const line of lines) {
    const region = regionOf(line.bbox.x + line.bbox.width / 2, regions);
    if (line.parts.length < 2 || regions.length === 1) {
      segments.push({ ...line, region });
      continue;
    }
    const buckets = new Map<number, LinePart[]>();
    for (const part of line.parts) {
      const partRegion = regionOf(part.bbox.x + part.bbox.width / 2, regions);
      const bucket = buckets.get(partRegion);
      if (bucket) bucket.push(part);
      else buckets.set(partRegion, [part]);
    }
    if (buckets.size <= 1) {
      segments.push({ ...line, region });
      continue;
    }
    for (const [partRegion, parts] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      segments.push({
        parts: [...parts],
        text: parts.map((part) => part.text).join(' '),
        bbox: lineBBox(parts),
        baseline: line.baseline,
        fontSize: line.fontSize,
        fontKey: line.fontKey,
        list: line.list,
        closed: line.closed,
        region: partRegion,
      });
    }
  }
  return segments;
}

export interface ParagraphBlock {
  readonly lines: readonly GroupedLine[];
  readonly bbox: BBox;
  readonly region: number;
  /** Vertical gap to the previous block in the same region (Infinity first). */
  readonly gapAbove: number;
}

const SIZE_TOLERANCE = 0.12;
const LIST_MERGE_GAP = 1.8;
const PARAGRAPH_MERGE_GAP = 1.95;

interface Draft {
  readonly region: number;
  readonly lines: GroupedLine[];
  bbox: BBox;
}

function sameTypography(previous: GroupedLine, next: GroupedLine, boldOf: (key: string) => boolean): boolean {
  const max = Math.max(previous.fontSize, next.fontSize);
  if (Math.abs(previous.fontSize - next.fontSize) > max * SIZE_TOLERANCE) return false;
  if (boldOf(previous.fontKey) !== boldOf(next.fontKey)) return false;
  return true;
}

/**
 * Groups lines into paragraph drafts, per column region.
 * List lines only merge with list lines (same marker style); everything else
 * merges on typography plus vertical proximity.
 */
export function groupParagraphs(
  segments: readonly LineSegment[],
  boldOf: (fontKey: string) => boolean,
): ParagraphBlock[] {
  const byRegion = new Map<number, LineSegment[]>();
  for (const segment of segments) {
    const bucket = byRegion.get(segment.region);
    if (bucket) bucket.push(segment);
    else byRegion.set(segment.region, [segment]);
  }

  const drafts: Draft[] = [];
  for (const [region, regionLines] of [...byRegion.entries()].sort((a, b) => a[0] - b[0])) {
    const ordered = [...regionLines].sort((a, b) => a.baseline - b.baseline || a.bbox.x - b.bbox.x);
    let current: GroupedLine[] = [];
    let currentBBox: BBox | null = null;

    const flush = (): void => {
      if (current.length > 0 && currentBBox) drafts.push({ region, lines: current, bbox: currentBBox });
      current = [];
      currentBBox = null;
    };

    for (const line of ordered) {
      const last = current[current.length - 1];
      const listCompatible =
        last !== undefined && ((last.list !== null && line.list !== null) || (last.list === null && line.list === null));
      const gap = last ? line.baseline - last.baseline : Infinity;
      const mergeLimit =
        (line.list ? LIST_MERGE_GAP : PARAGRAPH_MERGE_GAP) * Math.max(line.fontSize, last?.fontSize ?? line.fontSize);
      const canMerge = last !== undefined && listCompatible && sameTypography(last, line, boldOf) && gap <= mergeLimit;

      if (canMerge && currentBBox) {
        current.push(line);
        currentBBox = unionBBox(currentBBox, line.bbox);
      } else {
        flush();
        current = [line];
        currentBBox = { ...line.bbox };
      }
    }
    flush();
  }

  // Vertical gaps are computed per region so column rhythm never leaks.
  const previousByRegion = new Map<number, BBox>();
  return drafts.map((draft) => {
    const previous = previousByRegion.get(draft.region);
    const gapAbove = previous ? draft.bbox.y - (previous.y + previous.height) : Infinity;
    previousByRegion.set(draft.region, draft.bbox);
    return { lines: draft.lines, bbox: draft.bbox, region: draft.region, gapAbove };
  });
}
