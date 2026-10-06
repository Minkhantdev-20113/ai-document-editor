import { beforeAll, describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { detectLanguage } from '../domain/languageDetect';
import type { PageIR } from '../domain/analysis/ir';
import type { OpenedDocumentInfo } from '../domain/analysis/source';
import {
  BURMESE_LINES,
  burmesePdf,
  headingsPdf,
  listsPdf,
  mixedFontsPdf,
  normalTextPdf,
  paragraphsPdf,
  rotatedPdf,
  scannedPdf,
  tablePdf,
} from '../../test-fixtures/pdfFixtures';
import { createLocalAnalysisSource } from './analysisSession';
import type { PdfjsModule } from './pdfExtract';

/**
 * End-to-end analysis tests over real generated PDFs.
 *
 * The full chain runs exactly as it does in the app (pdf.js extraction →
 * grouping → classification → IR), with only the pdf.js build swapped for the
 * Node-compatible legacy one. Spec coverage: normal text, paragraphs, headings,
 * lists, tables, mixed formatting, Burmese, scanned pages (+ rotation).
 */

const legacy = pdfjs as unknown as PdfjsModule;

interface Fixture {
  readonly bytes: Uint8Array;
}

const fixtures: Record<string, Fixture> = {};

beforeAll(async () => {
  fixtures.normal = { bytes: (await normalTextPdf()).bytes };
  fixtures.paragraphs = { bytes: (await paragraphsPdf()).bytes };
  fixtures.headings = { bytes: (await headingsPdf()).bytes };
  fixtures.lists = { bytes: (await listsPdf()).bytes };
  fixtures.table = { bytes: (await tablePdf()).bytes };
  fixtures.mixed = { bytes: (await mixedFontsPdf()).bytes };
  fixtures.burmese = { bytes: (await burmesePdf()).bytes };
  fixtures.scanned = { bytes: (await scannedPdf()).bytes };
  fixtures.rotated = { bytes: (await rotatedPdf()).bytes };
}, 60_000);

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function openFixture(
  name: string,
  documentId: string,
  fileName: string,
): Promise<{ info: OpenedDocumentInfo; source: ReturnType<typeof createLocalAnalysisSource> }> {
  const fixture = fixtures[name];
  if (!fixture) throw new Error(`fixture ${name} not built`);
  const source = createLocalAnalysisSource(legacy);
  const info = await source.open(toArrayBuffer(fixture.bytes), { documentId, fileName });
  return { info, source };
}

async function analyzePageOf(
  name: string,
  documentId: string,
  fileName: string,
  pageIndex = 0,
): Promise<{ info: OpenedDocumentInfo; page: PageIR }> {
  const { info, source } = await openFixture(name, documentId, fileName);
  try {
    const page = await source.page(pageIndex);
    return { info, page };
  } finally {
    await source.close();
  }
}

function withinPage(page: PageIR): void {
  for (const block of page.blocks) {
    expect(block.bbox.x).toBeGreaterThanOrEqual(-1);
    expect(block.bbox.y).toBeGreaterThanOrEqual(-1);
    expect(block.bbox.x + block.bbox.width).toBeLessThanOrEqual(page.width + 2);
    expect(block.bbox.y + block.bbox.height).toBeLessThanOrEqual(page.height + 2);
  }
}

describe('analysis session over real PDFs', () => {
  it('analyzes normal text into a heading plus one paragraph', async () => {
    const { info, page } = await analyzePageOf('normal', 'doc_normal', 'normal.pdf');

    expect(info.pageCount).toBe(1);
    expect(info.metadata?.format).toBeTruthy();
    expect(page.id).toBe('doc_normal_p0');
    expect(page.requiresOcr).toBe(false);
    expect(page.charCount).toBeGreaterThan(100);

    const heading = page.blocks.find((block) => block.kind === 'heading');
    const paragraph = page.blocks.find((block) => block.kind === 'paragraph');
    expect(heading).toBeDefined();
    expect(heading!.font.size).toBe(20);
    expect(heading!.font.bold).toBe(true);
    expect(paragraph).toBeDefined();
    expect(paragraph!.lines).toHaveLength(3);
    expect(paragraph!.text).toContain('normal prose');
    withinPage(page);
  }, 20_000);

  it('splits multiple paragraphs and keeps their order', async () => {
    const { page } = await analyzePageOf('paragraphs', 'doc_para', 'paragraphs.pdf');

    const paragraphs = page.blocks.filter((block) => block.kind === 'paragraph');
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs.map((block) => block.readingOrder)).toEqual([0, 1, 2]);
    expect(paragraphs[0]!.text).toContain('Alpha paragraph');
    expect(paragraphs[1]!.text).toContain('Beta paragraph');
    expect(paragraphs[2]!.text).toContain('Gamma paragraph');
    for (const block of paragraphs) expect(block.lines).toHaveLength(2);
    withinPage(page);
  }, 20_000);

  it('classifies headings by relative size', async () => {
    const { page } = await analyzePageOf('headings', 'doc_head', 'headings.pdf');

    const headings = page.blocks.filter((block) => block.kind === 'heading');
    expect(headings).toHaveLength(2);
    expect(headings[0]!.font.size).toBe(24);
    expect(headings[0]!.font.bold).toBe(true);
    expect(headings[1]!.font.size).toBe(16);
    expect(page.blocks.filter((block) => block.kind === 'paragraph')).toHaveLength(2);
    expect(page.blocks[0]!.kind).toBe('heading');
    withinPage(page);
  }, 20_000);

  it('groups ordered and bulleted lists separately', async () => {
    const { page } = await analyzePageOf('lists', 'doc_list', 'lists.pdf');

    const lists = page.blocks.filter((block) => block.kind === 'list');
    expect(lists).toHaveLength(2);
    const ordered = lists.find((block) => block.listOrdered === true);
    const bullets = lists.find((block) => block.listOrdered === false);
    expect(ordered).toBeDefined();
    expect(bullets).toBeDefined();
    expect(ordered!.lines).toHaveLength(3);
    expect(ordered!.text).toContain('1. Draft the initial outline');
    expect(bullets!.lines).toHaveLength(2);
    expect(bullets!.text).toContain('- Collect the source documents');
    withinPage(page);
  }, 20_000);

  it('detects a three-column table with header and rows', async () => {
    const { page } = await analyzePageOf('table', 'doc_table', 'table.pdf');

    const table = page.blocks.find((block) => block.kind === 'table');
    expect(table).toBeDefined();
    expect(table!.table?.columns).toBe(3);
    expect(table!.table?.rows).toHaveLength(4);
    expect(table!.text).toContain('Department | Items | Status');
    expect(page.warnings).toContain('tables');
    // The intro paragraph reads before the table.
    expect(table!.readingOrder).toBeGreaterThan(0);
    withinPage(page);
  }, 20_000);

  it('captures mixed formatting per block (size, weight, family)', async () => {
    const { page } = await analyzePageOf('mixed', 'doc_mixed', 'mixed.pdf');

    expect(page.blocks).toHaveLength(5);
    const [bold, , italic, courier, times] = page.blocks;
    expect(bold!.font.bold).toBe(true);
    expect(bold!.font.size).toBe(14);
    expect(italic!.font.italic).toBe(true);
    expect(courier!.font.family).not.toBe(times!.font.family);
    const sizes = new Set(page.blocks.map((block) => block.font.size));
    expect(sizes.has(14)).toBe(true);
    expect(sizes.has(11)).toBe(true);
    withinPage(page);
  }, 20_000);

  it('round-trips Burmese text exactly and detects the language', async () => {
    const { info, page } = await analyzePageOf('burmese', 'doc_my', 'burmese.pdf');

    expect(info.pageCount).toBe(1);
    const heading = page.blocks.find((block) => block.kind === 'heading');
    expect(heading?.text).toBe(BURMESE_LINES.heading);
    const paragraph = page.blocks.find((block) => block.kind === 'paragraph');
    expect(paragraph?.text).toContain(BURMESE_LINES.body1);
    expect(paragraph?.text).toContain(BURMESE_LINES.body2);

    const detection = detectLanguage(page.blocks.map((block) => block.text).join('\n'));
    expect(detection.code).toBe('my');
    withinPage(page);
  }, 20_000);

  it('marks image-only pages as needing OCR and still analyzes the next page', async () => {
    const { info, source } = await openFixture('scanned', 'doc_scan', 'scanned.pdf');
    try {
      expect(info.pageCount).toBe(2);

      const scanned = await source.page(0);
      expect(scanned.requiresOcr).toBe(true);
      expect(scanned.warnings).toContain('needs_ocr');
      expect(scanned.blocks).toHaveLength(0);
      expect(scanned.images).toHaveLength(1);
      const image = scanned.images[0]!.bbox;
      expect(image.x).toBeCloseTo(40, 0);
      expect(image.y).toBeCloseTo(40, 0);
      expect(image.width).toBeCloseTo(515, 0);
      expect(image.height).toBeCloseTo(762, 0);

      const normal = await source.page(1);
      expect(normal.requiresOcr).toBe(false);
      expect(normal.blocks).toHaveLength(1);
      expect(normal.blocks[0]!.text).toContain('normal text page');

      // Rasterizing for OCR needs a canvas; Node has none, so the renderer
      // degrades to null instead of failing the page.
      expect(await source.renderPage?.(0)).toBeNull();
    } finally {
      await source.close();
    }
  }, 20_000);

  it('records rotation while extracting unrotated content space', async () => {
    const { page } = await analyzePageOf('rotated', 'doc_rot', 'rotated.pdf');

    expect(page.rotation).toBe(90);
    expect(page.warnings).toContain('rotated');
    expect(page.width).toBeCloseTo(595, 1);
    expect(page.height).toBeCloseTo(842, 1);
    expect(page.blocks).toHaveLength(1);
    expect(page.blocks[0]!.text).toContain('ninety degree rotation');
    withinPage(page);
  }, 20_000);

  it('produces identical ids across repeated analysis of the same document', async () => {
    const first = await analyzePageOf('headings', 'doc_repeat', 'headings.pdf');
    const second = await analyzePageOf('headings', 'doc_repeat', 'headings.pdf');

    expect(second.page.id).toBe(first.page.id);
    expect(second.page.blocks.map((block) => block.id)).toEqual(
      first.page.blocks.map((block) => block.id),
    );
    expect(second.page.blocks.map((block) => block.text)).toEqual(
      first.page.blocks.map((block) => block.text),
    );
  }, 20_000);

  it('rejects out-of-range pages and closed sessions with typed errors', async () => {
    const { source } = await openFixture('normal', 'doc_errors', 'normal.pdf');
    await expect(source.page(5)).rejects.toMatchObject({ code: 'not_found' });
    await expect(source.page(-1)).rejects.toMatchObject({ code: 'validation' });
    await source.close();
    await expect(source.page(0)).rejects.toMatchObject({ code: 'validation' });
  }, 20_000);
});
