import { describe, expect, it } from 'vitest';
import type { TextMetrics } from './textLayout';
import { buildRenderPlan } from './layoutPlan';
import type {
  ExportBlockInput,
  ExportDocumentInput,
  ExportPageInput,
  PlannedTextBlock,
} from './types';

const metrics: TextMetrics = {
  width: (text, _role, size) => text.length * size * 0.5,
};

const A4 = { width: 595.28, height: 841.89 };

function makeBlock(overrides: Partial<ExportBlockInput> = {}): ExportBlockInput {
  return {
    blockId: 'b1',
    orderIndex: 0,
    kind: 'paragraph',
    bbox: { x: 56, y: 100, width: 483, height: 40 },
    font: { family: 'Times', size: 10, bold: false, italic: false },
    alignment: 'left',
    headingLevel: null,
    listOrdered: null,
    table: null,
    link: null,
    flags: [],
    sourceText: 'Source sentence used for layout.',
    translatedText: 'ဘာသာပြန်ချက် တစ်ကြောင်း',
    unitStatus: 'translated',
    ...overrides,
  };
}

function makePage(blocks: ExportBlockInput[], pageIndex = 0): ExportPageInput {
  return { pageIndex, width: A4.width, height: A4.height, rotation: 0, blocks };
}

function makeDoc(pages: ExportPageInput[], overrides: Partial<ExportDocumentInput> = {}): ExportDocumentInput {
  return {
    documentId: 'doc_1',
    projectId: 'proj_1',
    title: 'Sample document',
    fileName: 'sample.pdf',
    sourceLanguage: 'en',
    targetLanguage: 'my',
    pages,
    ...overrides,
  };
}

function textBlocks(plan: ReturnType<typeof buildRenderPlan>, pageIndex: number): PlannedTextBlock[] {
  return plan.pages
    .filter((page) => page.sourcePageIndex === pageIndex)
    .flatMap((page) => page.blocks)
    .filter((block): block is PlannedTextBlock => block.type === 'text');
}

function firstPage(plan: ReturnType<typeof buildRenderPlan>, index = 0) {
  const page = plan.pages[index];
  if (!page) throw new Error(`expected plan page ${index}`);
  return page;
}

function firstTextBlock(plan: ReturnType<typeof buildRenderPlan>, pageIndex = 0): PlannedTextBlock {
  const block = textBlocks(plan, pageIndex)[0];
  if (!block) throw new Error('expected a planned text block');
  return block;
}

function firstLine(block: PlannedTextBlock) {
  const line = block.lines[0];
  if (!line) throw new Error('expected a planned line');
  return line;
}

describe('buildRenderPlan', () => {
  it('preserves the original geometry when the translation fits', () => {
    const plan = buildRenderPlan(makeDoc([makePage([makeBlock()])]), { metrics });

    expect(plan.pages).toHaveLength(1);
    expect(firstPage(plan).part).toBe(0);
    const block = firstTextBlock(plan);
    const line = firstLine(block);
    expect(line.x).toBe(56);
    expect(block.bbox.y).toBe(100);
    expect(line.text).toBe('ဘာသာပြန်ချက် တစ်ကြောင်း');
    expect(plan.warnings).toEqual([]);
    expect(plan.stats).toEqual({ sourcePages: 1, pages: 1, blocks: 1, characters: 23 });
  });

  it('expands a long block and rebalances the blocks after it', () => {
    const long = 'word '.repeat(60).trim(); // 20 lines at this column width
    const page = makePage([
      makeBlock({ blockId: 'b1', bbox: { x: 56, y: 100, width: 483, height: 40 }, translatedText: long }),
      makeBlock({
        blockId: 'b2',
        orderIndex: 1,
        bbox: { x: 56, y: 150, width: 483, height: 40 },
        translatedText: 'ဒုတိယ စာပိုဒ်',
      }),
    ]);
    const plan = buildRenderPlan(makeDoc([page]), { metrics });
    const blocks = textBlocks(plan, 0);

    expect(blocks).toHaveLength(2);
    const [first, second] = [blocks[0], blocks[1]];
    if (!first || !second) throw new Error('expected two planned blocks');
    const firstBottom = first.bbox.y + first.bbox.height;
    expect(firstBottom).toBeGreaterThan(150); // block one really grew
    expect(second.bbox.y).toBeCloseTo(firstBottom, 5); // moved down with it
    expect(plan.pages).toHaveLength(1); // still fits the page
  });

  it('continues overflowed content on a continuation page instead of clipping', () => {
    const long = 'word '.repeat(900).trim();
    const block = makeBlock({
      bbox: { x: 56, y: 100, width: 483, height: 40 },
      translatedText: long,
    });
    const plan = buildRenderPlan(makeDoc([makePage([block])]), { metrics });

    expect(plan.pages.length).toBeGreaterThan(1);
    expect(firstPage(plan, 1).part).toBe(1);
    expect(firstPage(plan, 1).sourcePageIndex).toBe(0);

    const expectedLines = Math.ceil(long.length / (483 / 5));
    const placedLines = plan.pages.reduce(
      (sum, page) => sum + page.blocks.filter((b) => b.type === 'text').reduce((n, b) => n + b.lines.length, 0),
      0,
    );
    expect(placedLines).toBeGreaterThanOrEqual(expectedLines - 1);
    expect(plan.warnings.some((warning) => warning.code === 'block_continued')).toBe(true);

    // Everything drawn stays above the page bottom margin.
    for (const page of plan.pages) {
      const bottomLimit = page.height - page.margins.bottom;
      for (const b of page.blocks) {
        if (b.type !== 'text') continue;
        expect(b.lines[0]?.baselineY).toBeLessThanOrEqual(bottomLimit + 40);
      }
    }
  });

  it('draws over-wide text wider than its column and warns (never clips)', () => {
    // A degenerate source column (12pt) with a 48pt glyph cannot be broken
    // further: the line is drawn wider than the column and flagged.
    const plan = buildRenderPlan(
      makeDoc([
        makePage([
          makeBlock({
            bbox: { x: 56, y: 100, width: 8, height: 40 },
            font: { family: 'Times', size: 48, bold: false, italic: false },
            translatedText: 'က',
          }),
        ]),
      ]),
      { metrics },
    );
    const block = firstTextBlock(plan);
    const line = firstLine(block);
    expect(line.width).toBeGreaterThan(block.sourceBBox.width);
    expect(plan.warnings.some((warning) => warning.code === 'text_overflow')).toBe(true);
  });

  it('falls back to the source text and reports missing/untranslated units', () => {
    const plan = buildRenderPlan(
      makeDoc([
        makePage([
          makeBlock({
            blockId: 'b_missing',
            translatedText: null,
            unitStatus: 'pending',
            sourceText: 'Not translated yet.',
          }),
          makeBlock({
            blockId: 'b_same',
            orderIndex: 1,
            translatedText: 'Same as source',
            sourceText: 'Same as source',
          }),
          makeBlock({
            blockId: 'b_empty',
            orderIndex: 2,
            translatedText: null,
            unitStatus: null,
            sourceText: '',
          }),
        ]),
      ]),
      { metrics },
    );

    const codes = plan.warnings.map((warning) => `${warning.code}:${warning.blockId}`);
    expect(codes).toContain('missing_translation:b_missing');
    expect(codes).toContain('untranslated_block:b_same');
    expect(codes).toContain('source_empty:b_empty');

    const blocks = textBlocks(plan, 0);
    expect(blocks.find((block) => block.blockId === 'b_missing')?.lines[0]?.text).toBe('Not translated yet.');
  });

  it('warns when no configured font can draw a character', () => {
    const plan = buildRenderPlan(
      makeDoc([makePage([makeBlock({ translatedText: '中文 test' })])]),
      { metrics },
    );
    const warning = plan.warnings.find((item) => item.code === 'glyph_missing');
    expect(warning?.detail).toBe('中 文');
  });

  it('rebuilds tables with the original column geometry', () => {
    const tableBlock = makeBlock({
      blockId: 't1',
      kind: 'table',
      bbox: { x: 56, y: 100, width: 400, height: 80 },
      table: {
        columns: 2,
        rows: [
          {
            cells: [
              { text: 'Header one', bbox: { x: 56, y: 100, width: 200, height: 20 } },
              { text: 'Header two', bbox: { x: 256, y: 100, width: 200, height: 20 } },
            ],
          },
          {
            cells: [
              { text: 'Cell value', bbox: { x: 56, y: 120, width: 200, height: 20 } },
              { text: 'Another cell', bbox: { x: 256, y: 120, width: 200, height: 20 } },
            ],
          },
        ],
      },
    });
    const plan = buildRenderPlan(makeDoc([makePage([tableBlock])]), { metrics });

    const table = firstPage(plan).blocks[0];
    if (!table || table.type !== 'table') throw new Error('expected a table block');
    expect(table.columns).toEqual([
      { x: 56, width: 200 },
      { x: 256, width: 200 },
    ]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]?.y).toBeGreaterThan(table.rows[0]?.y ?? 0);
    expect(table.rows[0]?.cells[0]?.lines[0]?.text).toBe('Header one');
    expect(table.reconstructed).toBe(false);
    expect(plan.warnings).toEqual([]);
  });

  it('flags a ragged table as reconstructed', () => {
    const tableBlock = makeBlock({
      blockId: 't2',
      kind: 'table',
      table: {
        columns: 2,
        rows: [
          { cells: [{ text: 'only one cell', bbox: { x: 56, y: 100, width: 200, height: 20 } }] },
        ],
      },
    });
    const plan = buildRenderPlan(makeDoc([makePage([tableBlock])]), { metrics });
    expect(plan.warnings.some((warning) => warning.code === 'table_reconstructed')).toBe(true);
  });

  it('reflows into the page margins when layout preservation is off', () => {
    const plan = buildRenderPlan(makeDoc([makePage([makeBlock({ bbox: { x: 300, y: 400, width: 200, height: 40 } })])]), {
      metrics,
      keepLayout: false,
    });
    const line = firstLine(firstTextBlock(plan));
    expect(line.x).toBe(firstPage(plan).margins.left);
    expect(line.baselineY).toBeGreaterThan(firstPage(plan).margins.top - 1);
  });

  it('keeps hard page order across multiple source pages', () => {
    const plan = buildRenderPlan(
      makeDoc([makePage([makeBlock({ blockId: 'p0' })], 0), makePage([makeBlock({ blockId: 'p1' })], 1)]),
      { metrics },
    );
    expect(plan.pages.map((page) => page.sourcePageIndex)).toEqual([0, 1]);
    expect(plan.stats.sourcePages).toBe(2);
    expect(plan.stats.pages).toBe(2);
  });
});
