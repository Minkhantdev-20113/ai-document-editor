import { describe, expect, it } from 'vitest';
import type { DocumentBlock, DocumentPage, DocumentRecord, TranslationUnit } from '../db/entities';
import type { BBox, FontInfo } from '../domain/analysis/ir';
import { buildExportDocument, documentTitle } from './exportDocumentBuilder';

const T0 = 1_700_000_000_000;
const BBOX: BBox = { x: 72, y: 700, width: 450, height: 20 };
const FONT: FontInfo = { family: 'Times New Roman', size: 12, bold: false, italic: false };

function makeDocument(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: 'doc_1',
    projectId: 'proj_1',
    kind: 'pdf',
    fileName: 'report.pdf',
    fileSize: 2_048,
    mimeType: 'application/pdf',
    lastModified: T0,
    checksum: null,
    payload: null,
    payloadStored: false,
    sourceLanguage: 'en',
    targetLanguage: 'my',
    pageCount: 2,
    charCount: 200,
    inspectionState: 'ready',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function makePage(pageIndex: number): DocumentPage {
  return {
    id: `page_${pageIndex}`,
    projectId: 'proj_1',
    documentId: 'doc_1',
    pageIndex,
    width: 595,
    height: 842,
    rotation: 0,
    charCount: 100,
    unitCount: 2,
    status: 'ready',
    blockCount: 2,
    createdAt: T0,
    updatedAt: T0,
  };
}

function makeBlock(pageIndex: number, readingOrder: number, overrides: Partial<DocumentBlock> = {}): DocumentBlock {
  return {
    id: `page_${pageIndex}_b${readingOrder}`,
    projectId: 'proj_1',
    documentId: 'doc_1',
    pageId: `page_${pageIndex}`,
    pageIndex,
    readingOrder,
    orderIndex: pageIndex * 100_000 + readingOrder,
    kind: 'paragraph',
    text: `Source ${pageIndex}-${readingOrder}`,
    bbox: BBOX,
    font: FONT,
    alignment: 'left',
    headingLevel: null,
    listOrdered: null,
    table: null,
    link: null,
    flags: [],
    lines: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function makeUnit(blockId: string, orderIndex: number, overrides: Partial<TranslationUnit> = {}): TranslationUnit {
  return {
    id: blockId,
    projectId: 'proj_1',
    documentId: 'doc_1',
    pageId: blockId.split('_b')[0] ?? 'page_0',
    blockId,
    orderIndex,
    sourceText: `Source ${blockId}`,
    sourceLanguage: 'en',
    targetLanguage: 'my',
    translatedText: `ဘာသာပြန် ${blockId}`,
    status: 'translated',
    retryCount: 0,
    provider: null,
    model: null,
    keyId: null,
    estimatedTokens: null,
    actualTokens: null,
    error: null,
    sourceChecksum: 'checksum',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe('buildExportDocument (Phase 5 document model)', () => {
  it('orders pages and blocks by reading order and joins units by block id', () => {
    const model = buildExportDocument({
      document: makeDocument(),
      pages: [makePage(1), makePage(0)],
      blocks: [
        makeBlock(1, 1),
        makeBlock(0, 1),
        makeBlock(1, 0),
        makeBlock(0, 0),
      ],
      units: [
        makeUnit('page_1_b1', 100_001),
        makeUnit('page_0_b1', 1),
        makeUnit('page_1_b0', 100_000),
        makeUnit('page_0_b0', 0),
      ],
    });

    expect(model.pages.map((page) => page.pageIndex)).toEqual([0, 1]);
    expect(model.pages[0]?.blocks.map((block) => block.blockId)).toEqual([
      'page_0_b0',
      'page_0_b1',
    ]);
    expect(model.pages[1]?.blocks.map((block) => block.blockId)).toEqual([
      'page_1_b0',
      'page_1_b1',
    ]);

    const first = model.pages[0]?.blocks[0];
    expect(first?.sourceText).toBe('Source page_0_b0');
    expect(first?.translatedText).toBe('ဘာသာပြန် page_0_b0');
    expect(first?.unitStatus).toBe('translated');
    expect(first?.bbox).toEqual(BBOX);
    expect(model.targetLanguage).toBe('my');
    expect(model.title).toBe('report.pdf');
    expect(model.fileName).toBe('report.pdf');
  });

  it('keeps untranslated blocks with null translations instead of dropping them', () => {
    const model = buildExportDocument({
      document: makeDocument(),
      pages: [makePage(0)],
      blocks: [makeBlock(0, 0), makeBlock(0, 1)],
      units: [makeUnit('page_0_b0', 0)],
    });

    const blocks = model.pages[0]?.blocks;
    expect(blocks).toHaveLength(2);
    expect(blocks?.[0]?.translatedText).toBe('ဘာသာပြန် page_0_b0');
    expect(blocks?.[1]?.translatedText).toBeNull();
    expect(blocks?.[1]?.unitStatus).toBeNull();
    expect(blocks?.[1]?.sourceText).toBe('Source 0-1');
  });

  it('honours file name and target language overrides', () => {
    const model = buildExportDocument({
      document: makeDocument(),
      pages: [makePage(0)],
      blocks: [],
      units: [],
      fileName: 'report-my.pdf',
      targetLanguage: 'ja',
    });

    expect(model.fileName).toBe('report-my.pdf');
    expect(model.targetLanguage).toBe('ja');
    expect(model.sourceLanguage).toBe('en');
  });
});

describe('documentTitle', () => {
  it('prefers the embedded PDF title', () => {
    const document = makeDocument({
      metadata: {
        title: '  Annual Report  ',
        author: null,
        subject: null,
        producer: null,
        creator: null,
        creationDate: null,
        format: 'PDF 1.7',
      },
    });
    expect(documentTitle(document)).toBe('Annual Report');
  });

  it('falls back to the file name when no metadata title exists', () => {
    expect(documentTitle(makeDocument())).toBe('report.pdf');
    expect(documentTitle(makeDocument({ metadata: null }))).toBe('report.pdf');
  });
});
