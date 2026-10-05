import { describe, expect, it } from 'vitest';
import type { BBox, ImageRegion, RawLink, RawPageInput, RawTextItem } from './ir';
import { analyzePage } from './pipeline';

const DOC = 'doc_test';

function textItem(
  text: string,
  x: number,
  baseline: number,
  fontSize = 12,
  fontKey = 'f_regular',
): RawTextItem {
  const width = text.length * fontSize * 0.5;
  return {
    text,
    bbox: { x, y: baseline - fontSize * 0.8, width, height: fontSize },
    fontSize,
    fontKey,
  };
}

function page(partial: Partial<RawPageInput>): RawPageInput {
  return {
    index: 0,
    width: 595,
    height: 842,
    rotation: 0,
    items: [],
    fonts: [
      { key: 'f_regular', family: 'Helvetica', bold: false, italic: false },
      { key: 'f_bold', family: 'Helvetica', bold: true, italic: false },
    ],
    images: [],
    links: [],
    ...partial,
  };
}

describe('analyzePage', () => {
  it('groups lines into a single paragraph block with stable ids', () => {
    const input = page({
      items: [
        textItem('The first line of a paragraph sits here.', 40, 100),
        textItem('The second line continues the same paragraph.', 40, 116),
      ],
    });
    const result = analyzePage(input, DOC);

    expect(result.blocks).toHaveLength(1);
    const block = result.blocks[0]!;
    expect(block.kind).toBe('paragraph');
    expect(block.lines).toHaveLength(2);
    expect(block.id).toBe(`${DOC}_p0_b0`);
    expect(block.lines[0]!.id).toBe(`${DOC}_p0_b0_l0`);
    expect(block.readingOrder).toBe(0);
    expect(block.alignment).toBe('left');
    expect(block.font.size).toBe(12);
    expect(result.charCount).toBeGreaterThan(50);
    expect(result.requiresOcr).toBe(false);
  });

  it('classifies larger type as a heading and keeps reading order', () => {
    const input = page({
      items: [
        textItem('CHAPTER ONE', 40, 60, 24, 'f_bold'),
        textItem('Body text follows the heading with plenty of words', 40, 120),
        textItem('to make the body font dominate the character histogram.', 40, 136),
      ],
    });
    const result = analyzePage(input, DOC);

    expect(result.blocks).toHaveLength(2);
    const heading = result.blocks.find((block) => block.kind === 'heading');
    expect(heading).toBeDefined();
    expect(heading!.readingOrder).toBe(0);
    expect(heading!.headingLevel).toBe(1);
    expect(heading!.font.bold).toBe(true);
    expect(heading!.font.size).toBe(24);
    expect(result.blocks.some((block) => block.kind === 'paragraph')).toBe(true);
  });

  it('detects numbered and bulleted lists as one block each', () => {
    const input = page({
      items: [
        textItem('1. First ordered item', 40, 100),
        textItem('2. Second ordered item', 40, 116),
        textItem('- a bullet item', 40, 150),
        textItem('- another bullet', 40, 166),
      ],
    });
    const result = analyzePage(input, DOC);

    const lists = result.blocks.filter((block) => block.kind === 'list');
    expect(lists).toHaveLength(2);
    const ordered = lists.find((block) => block.listOrdered === true);
    const bullets = lists.find((block) => block.listOrdered === false);
    expect(ordered).toBeDefined();
    expect(bullets).toBeDefined();
    expect(ordered!.lines).toHaveLength(2);
    expect(ordered!.text).toContain('First ordered item');
    expect(bullets!.text).toContain('a bullet item');
  });

  it('detects Burmese numbered lists (၁။ markers)', () => {
    const input = page({
      items: [
        textItem('၁။ ပထမ အချက်', 40, 100),
        textItem('၂။ ဒုတိယ အချက်', 40, 116),
      ],
    });
    const result = analyzePage(input, DOC);
    const list = result.blocks.find((block) => block.kind === 'list');
    expect(list).toBeDefined();
    expect(list!.listOrdered).toBe(true);
    expect(list!.lines).toHaveLength(2);
  });

  it('detects a table from short aligned cells', () => {
    const input = page({
      items: [
        textItem('Quarterly numbers for the report', 40, 100),
        textItem('Name', 40, 400),
        textItem('Value', 300, 400),
        textItem('Alpha', 40, 416),
        textItem('42', 300, 416),
        textItem('Beta', 40, 432),
        textItem('7', 300, 432),
      ],
    });
    const result = analyzePage(input, DOC);

    const table = result.blocks.find((block) => block.kind === 'table');
    expect(table).toBeDefined();
    expect(table!.table?.columns).toBe(2);
    expect(table!.table?.rows).toHaveLength(3);
    expect(table!.text).toContain('Name | Value');
    expect(result.warnings).toContain('tables');
    expect(table!.readingOrder).toBeGreaterThan(0);
  });

  it('reads two-column layouts column by column, heading first', () => {
    const items: RawTextItem[] = [textItem('COLUMNS DEMO', 40, 60, 24, 'f_bold')];
    for (let index = 0; index < 10; index += 1) {
      const baseline = 100 + index * 16;
      items.push(textItem(`Left column line number ${index} here`, 40, baseline));
      items.push(textItem(`Right column line number ${index}`, 345, baseline));
    }
    const result = analyzePage(page({ items }), DOC);

    expect(result.warnings).toContain('columns');
    const order = [...result.blocks].sort((a, b) => a.readingOrder - b.readingOrder);
    expect(order[0]!.kind).toBe('heading');
    expect(order[1]!.text).toContain('Left column');
    expect(order[order.length - 1]!.text).toContain('Right column');
    // No interleaving: every left block precedes every right block.
    const lastLeft = order.map((block) => block.readingOrder).at(-1);
    expect(lastLeft).toBe(order.length - 1);
    const leftTexts = order.filter((block) => block.text.includes('Left column'));
    const rightTexts = order.filter((block) => block.text.includes('Right column'));
    expect(leftTexts).toHaveLength(1);
    expect(rightTexts).toHaveLength(1);
    expect(leftTexts[0]!.readingOrder).toBeLessThan(rightTexts[0]!.readingOrder);
  });

  it('marks image-only pages as needing OCR without inventing text', () => {
    const image: ImageRegion = { bbox: { x: 50, y: 50, width: 495, height: 700 } };
    const result = analyzePage(page({ images: [image] }), DOC);

    expect(result.requiresOcr).toBe(true);
    expect(result.warnings).toContain('needs_ocr');
    expect(result.blocks).toHaveLength(0);
    expect(result.charCount).toBe(0);
  });

  it('flags empty pages', () => {
    const result = analyzePage(page({}), DOC);
    expect(result.warnings).toContain('empty');
    expect(result.blocks).toHaveLength(0);
    expect(result.requiresOcr).toBe(false);
  });

  it('classifies stray page numbers near the margin as furniture', () => {
    const input = page({
      items: [textItem('42', 290, 812)],
    });
    const result = analyzePage(input, DOC);
    const block = result.blocks[0]!;
    expect(block.kind).toBe('other');
    expect(block.flags).toContain('page_number');
  });

  it('promotes short paragraphs hugging an image to captions', () => {
    const image: ImageRegion = { bbox: { x: 100, y: 300, width: 200, height: 150 } };
    const input = page({
      images: [image],
      items: [
        textItem('Body text that fills the page with enough characters', 40, 100),
        textItem('to dominate the histogram over the caption words here.', 40, 116),
        textItem('A small sample diagram', 100, 468, 10),
      ],
    });
    const result = analyzePage(input, DOC);
    const caption = result.blocks.find((block) => block.kind === 'caption');
    expect(caption).toBeDefined();
    expect(caption!.text).toContain('sample diagram');
  });

  it('detects Figure captions by pattern', () => {
    const input = page({
      items: [
        textItem('Body copy that carries plenty of characters for statistics', 40, 100),
        textItem('and keeps going on the next line for safe measurement.', 40, 116),
        textItem('Figure 3: Architecture overview', 40, 200, 10),
      ],
    });
    const result = analyzePage(input, DOC);
    const caption = result.blocks.find((block) => block.kind === 'caption');
    expect(caption).toBeDefined();
    expect(caption!.text).toContain('Architecture overview');
  });

  it('records rotation and returns deterministic output for identical input', () => {
    const input = page({
      rotation: 90,
      items: [
        textItem('Rotated page body text with a decent amount of content', 40, 100),
        textItem('on a second line so it forms a real paragraph block.', 40, 116),
      ],
    });
    const first = analyzePage(input, DOC);
    const second = analyzePage(input, DOC);
    // durationMs is measurement, not output: everything else must be identical.
    const fingerprint = (result: typeof first): string => JSON.stringify({ ...result, durationMs: 0 });

    expect(first.warnings).toContain('rotated');
    expect(fingerprint(first)).toBe(fingerprint(second));
    expect(first.blocks.map((block) => block.id)).toEqual(second.blocks.map((block) => block.id));
    const orders = first.blocks.map((block) => block.readingOrder).sort((a, b) => a - b);
    expect(orders).toEqual(first.blocks.map((_block, index) => index));
  });

  it('attaches link annotations to the block they cover', () => {
    const link: RawLink = {
      bbox: { x: 40, y: 90, width: 200, height: 14 } satisfies BBox,
      url: 'https://example.com/docs',
    };
    const input = page({
      links: [link],
      items: [
        textItem('Visit the documentation portal for details', 40, 100),
        textItem('and more information about the product itself.', 40, 116),
      ],
    });
    const result = analyzePage(input, DOC);
    expect(result.blocks[0]!.link).toBe('https://example.com/docs');
  });
});
