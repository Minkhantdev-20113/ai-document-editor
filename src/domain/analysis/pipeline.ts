import type {
  BBox,
  BlockIR,
  LineIR,
  PageIR,
  PageWarningCode,
  RawPageInput,
} from './ir';
import { pageIdFor } from './ir';
import { groupLines, type GroupedLine } from './lines';
import {
  computeColumnRegions,
  groupParagraphs,
  regionOf,
  splitLinesByRegion,
  unionBBox,
  type ParagraphBlock,
} from './layout';
import {
  alignmentOf,
  classifyBlock,
  computeFontStats,
  detectTables,
  fontOf,
  makeBoldChecker,
  type Classification,
  type TableDraft,
} from './structure';
import { readingOrder } from './readingOrder';

/**
 * Page analysis pipeline (shared by every input format's raw extractor):
 *
 *   raw runs → lines → tables → column regions → paragraphs → classification
 *   → caption/link refinement → reading order → PageIR
 *
 * Everything here is pure and deterministic: the same RawPageInput always
 * produces byte-identical blocks with stable ids.
 */

interface Draft {
  readonly bbox: BBox;
  readonly region: number;
  readonly lines: readonly GroupedLine[];
  readonly table: TableDraft | null;
  readonly gapAbove: number;
  classification: Classification | null;
}

function intersectionArea(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function adjacent(
  block: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number; width: number; height: number },
): boolean {
  const overlapX = Math.min(block.x + block.width, target.x + target.width) - Math.max(block.x, target.x);
  if (overlapX < Math.min(block.width, target.width) * 0.4) return false;
  const gapAbove = block.y - (target.y + target.height);
  const gapBelow = target.y - (block.y + block.height);
  return (gapAbove >= -4 && gapAbove <= 32) || (gapBelow >= -4 && gapBelow <= 32);
}

function tableRowsOf(draft: TableDraft): { cells: { text: string; bbox: BBox }[] }[] {
  return draft.rows.map((row) => ({ cells: row.map((cell) => ({ text: cell.text, bbox: cell.bbox })) }));
}

function blockText(draft: Draft): string {
  if (draft.table) {
    return draft.table.rows.map((row) => row.map((cell) => cell.text).join(' | ')).join('\n');
  }
  return draft.lines.map((line) => line.text).join('\n');
}

/** Analyzes one page of raw extracted content into the Document IR. */
export function analyzePage(input: RawPageInput, documentId: string): PageIR {
  const startedAt = Date.now();
  const pageId = pageIdFor(documentId, input.index);
  const allLines = groupLines(input.items);

  let visibleChars = 0;
  for (const line of allLines) visibleChars += line.text.trim().length;

  const warnings = new Set<PageWarningCode>();
  if (input.rotation % 360 !== 0) warnings.add('rotated');

  const requiresOcr = visibleChars < 3 && input.images.length > 0;
  if (requiresOcr) {
    warnings.add('needs_ocr');
  } else if (visibleChars < 3) {
    warnings.add('empty');
  }

  const stats = computeFontStats(allLines);
  const boldOf = makeBoldChecker(input.fonts);

  const { tables, rest } = detectTables(allLines);
  const regions = computeColumnRegions(rest, input.width);

  // A "table" that straddles real column regions is column text that happens
  // to look aligned (short lines on both sides) - give it back to the flow.
  const keptTables: TableDraft[] = [];
  const rejectedLines: GroupedLine[] = [];
  for (const table of tables) {
    const spansRegions =
      regions.length > 1 &&
      table.rows.some((row) => {
        const seen = new Set(row.map((cell) => regionOf(cell.bbox.x + cell.bbox.width / 2, regions)));
        return seen.size > 1;
      });
    if (spansRegions) rejectedLines.push(...table.lines);
    else keptTables.push(table);
  }
  const flowLines = rejectedLines.length > 0 ? [...rest, ...rejectedLines] : rest;

  const segments = splitLinesByRegion(flowLines, regions);
  const paragraphDrafts = groupParagraphs(segments, boldOf);

  const drafts: Draft[] = [];
  for (const paragraph of paragraphDrafts) {
    drafts.push({
      bbox: paragraph.bbox,
      region: paragraph.region,
      lines: paragraph.lines,
      table: null,
      gapAbove: paragraph.gapAbove,
      classification: null,
    });
  }
  for (const table of keptTables) {
    let bbox: { x: number; y: number; width: number; height: number } | null = null;
    for (const line of table.lines) bbox = unionBBox(bbox, line.bbox);
    if (!bbox) continue;
    drafts.push({
      bbox,
      region: regionOf(bbox.x + bbox.width / 2, regions),
      lines: table.lines,
      table,
      gapAbove: Infinity,
      classification: { kind: 'table', flags: [] },
    });
  }

  // Gap below each paragraph = gap above the next block of the same region.
  const withGaps: { draft: Draft; gapBelow: number }[] = drafts.map((draft, index) => {
    const next = drafts[index + 1];
    const gapBelow = next && next.region === draft.region ? next.gapAbove : Infinity;
    return { draft, gapBelow };
  });

  for (const { draft, gapBelow } of withGaps) {
    if (draft.classification) continue;
    const paragraphBlock: ParagraphBlock = {
      lines: draft.lines,
      bbox: draft.bbox,
      region: draft.region,
      gapAbove: draft.gapAbove,
    };
    draft.classification = classifyBlock(paragraphBlock, {
      stats,
      pageHeight: input.height,
      gapBelow,
      boldOf,
    });
  }

  // Captions: short paragraphs hugging an image or table, or announcing
  // themselves ("Figure 2", "ဇယား ၁") - the latter already classified inline.
  const captionTargets: BBox[] = [
    ...input.images.map((image) => image.bbox),
    ...keptTables
      .map((table) => {
        let bbox: BBox | null = null;
        for (const line of table.lines) bbox = unionBBox(bbox, line.bbox);
        return bbox;
      })
      .filter((bbox): bbox is BBox => bbox !== null),
  ];
  for (const { draft } of withGaps) {
    const classification = draft.classification;
    if (!classification || classification.kind !== 'paragraph' || draft.table) continue;
    if (draft.lines.length > 2) continue;
    const chars = draft.lines.reduce((count, line) => count + line.text.trim().length, 0);
    if (chars > 200) continue;
    if (captionTargets.some((target) => adjacent(draft.bbox, target))) {
      draft.classification = { kind: 'caption', flags: [] };
    }
  }

  // Link annotations attach to the block they cover best.
  const linkByDraft = new Map<number, string>();
  for (const link of input.links) {
    let bestDraft = -1;
    let bestRatio = 0;
    drafts.forEach((draft, index) => {
      const overlap = intersectionArea(draft.bbox, link.bbox);
      if (overlap <= 0) return;
      const draftArea = Math.max(1, draft.bbox.width * draft.bbox.height);
      const linkArea = Math.max(1, link.bbox.width * link.bbox.height);
      const ratio = Math.max(overlap / draftArea, overlap / linkArea);
      if (ratio > bestRatio && ratio >= 0.5) {
        bestRatio = ratio;
        bestDraft = index;
      }
    });
    if (bestDraft >= 0 && link.url) linkByDraft.set(bestDraft, link.url);
  }

  // Reading order across bands and columns.
  const order = readingOrder(drafts, input.width);
  const orderOf = new Map<number, number>();
  order.forEach((draftIndex, position) => orderOf.set(draftIndex, position));

  const blocks: BlockIR[] = [];
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]!;
    const classification = draft.classification ?? { kind: 'paragraph' as const, flags: [] };
    const reading = orderOf.get(index) ?? index;
    const blockId = `${pageId}_b${reading}`;
    const lines: LineIR[] = draft.lines.map((line, lineIndex) => ({
      id: `${blockId}_l${lineIndex}`,
      text: line.text,
      bbox: line.bbox,
      fontSize: line.fontSize,
    }));
    const link = linkByDraft.get(index);
    const block: BlockIR = {
      id: blockId,
      kind: classification.kind,
      text: blockText(draft),
      bbox: draft.bbox,
      lines,
      font: fontOf(draft.lines, input.fonts),
      alignment: alignmentOf(draft.lines, draft.bbox.width),
      readingOrder: reading,
      flags: classification.flags,
      ...(classification.headingLevel !== undefined ? { headingLevel: classification.headingLevel } : {}),
      ...(classification.listOrdered !== undefined ? { listOrdered: classification.listOrdered } : {}),
      ...(draft.table
        ? {
            table: {
              columns: Math.max(...draft.table.rows.map((row) => row.length), 1),
              rows: tableRowsOf(draft.table),
            },
          }
        : {}),
      ...(link ? { link } : {}),
    };
    blocks.push(block);
  }

  if (blocks.length > 60 || allLines.length > 150) warnings.add('dense');
  if (regions.length > 1 && !requiresOcr) warnings.add('columns');
  if (keptTables.length > 0) warnings.add('tables');
  if (stats.distinctSizes >= 5) warnings.add('mixed_fonts');

  return {
    id: pageId,
    index: input.index,
    width: input.width,
    height: input.height,
    rotation: input.rotation,
    blocks,
    images: [...input.images],
    warnings: [...warnings],
    requiresOcr,
    charCount: visibleChars,
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}
