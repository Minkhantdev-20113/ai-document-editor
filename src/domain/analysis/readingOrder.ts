import type { BBox } from './ir';

/**
 * Reading-order detection.
 *
 * The page is cut into horizontal bands at full-width blocks (titles, section
 * rules, full-width paragraphs). Inside a band, blocks are read by column
 * region (left → right) and then top → bottom, which reproduces both single
 * column and multi-column layouts without ever interleaving columns.
 */

export interface OrderedInput {
  readonly bbox: BBox;
  /** Column region index from the layout stage. */
  readonly region: number;
}

const FULL_WIDTH_RATIO = 0.6;

/**
 * Returns indices of `blocks` in reading order.
 * Full-width blocks open a new band; band order is top → bottom.
 */
export function readingOrder<T extends OrderedInput>(blocks: readonly T[], pageWidth: number): number[] {
  const indexed = blocks.map((block, index) => ({ block, index }));
  indexed.sort((a, b) => a.block.bbox.y - b.block.bbox.y || a.block.bbox.x - b.block.bbox.x);

  type Band = { header: number | null; rest: number[] };
  const bands: Band[] = [];
  let current: Band = { header: null, rest: [] };

  for (const { block, index } of indexed) {
    const fullWidth = block.bbox.width >= pageWidth * FULL_WIDTH_RATIO;
    if (fullWidth) {
      bands.push(current);
      current = { header: index, rest: [] };
    } else {
      current.rest.push(index);
    }
  }
  bands.push(current);

  const order: number[] = [];
  for (const band of bands) {
    if (band.header !== null) order.push(band.header);
    const rest = band.rest
      .map((index) => ({ index, block: blocks[index]! }))
      .sort(
        (a, b) =>
          a.block.region - b.block.region ||
          a.block.bbox.y - b.block.bbox.y ||
          a.block.bbox.x - b.block.bbox.x,
      );
    for (const { index } of rest) order.push(index);
  }
  return order;
}
