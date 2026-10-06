import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { appEvents } from '../core/events/eventBus';
import type { DocumentRecord, TranslationUnit } from '../db/entities';
import { documentsRepo, translationUnitsRepo } from '../db/repositories';
import type { RawPageInput } from '../domain/analysis/ir';
import { analyzePage } from '../domain/analysis/pipeline';
import { documentService } from './documentService';

const T0 = 1_700_000_000_000;

function makeDocument(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: 'doc_1',
    projectId: 'proj_1',
    kind: 'text',
    fileName: 'notes.md',
    fileSize: 1_024,
    mimeType: 'text/markdown',
    lastModified: T0,
    checksum: null,
    payload: null,
    payloadStored: false,
    sourceLanguage: 'en',
    targetLanguage: 'en',
    pageCount: 1,
    charCount: 2_000,
    inspectionState: 'ready',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function makeUnit(index: number, overrides: Partial<TranslationUnit> = {}): TranslationUnit {
  return {
    id: `u_${index}`,
    projectId: 'proj_1',
    documentId: 'doc_1',
    pageId: 'page_1',
    blockId: `b_${index}`,
    orderIndex: index,
    sourceText: `Source ${index}`,
    sourceLanguage: 'en',
    targetLanguage: 'en',
    translatedText: null,
    status: 'pending',
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

beforeEach(async () => {
  await documentsRepo.clear();
  await translationUnitsRepo.clear();
});

describe('documentService.setTargetLanguage (Phase 4 workflow)', () => {
  it('applies the chosen target language to the document and every unit', async () => {
    await documentsRepo.put(makeDocument());
    await translationUnitsRepo.putMany([makeUnit(1), makeUnit(2)]);

    const unitEvents: unknown[] = [];
    const docEvents: unknown[] = [];
    const offUnits = appEvents.on('units:changed', (payload) => unitEvents.push(payload));
    const offDocs = appEvents.on('documents:changed', (payload) => docEvents.push(payload));

    try {
      await documentService.setTargetLanguage('doc_1', 'my');
    } finally {
      offUnits();
      offDocs();
    }

    const document = await documentsRepo.get('doc_1');
    expect(document?.targetLanguage).toBe('my');
    const units = (await translationUnitsRepo.queryByIndex('by_document', 'doc_1')) ?? [];
    expect(units).toHaveLength(2);
    for (const unit of units) {
      expect(unit.targetLanguage).toBe('my');
    }
    // Views watching units/documents refetch immediately.
    expect(unitEvents).toHaveLength(1);
    expect(docEvents).toHaveLength(1);
  });

  it('is a no-op for units that already use that language', async () => {
    await documentsRepo.put(makeDocument({ targetLanguage: 'my' }));
    await translationUnitsRepo.putMany([
      makeUnit(1, { targetLanguage: 'my', updatedAt: T0 }),
    ]);

    await documentService.setTargetLanguage('doc_1', 'my');

    const unit = await translationUnitsRepo.get('u_1');
    // Nothing changed, so the row was not rewritten (updatedAt untouched).
    expect(unit?.updatedAt).toBe(T0);
  });

  it('fails loudly for unknown documents', async () => {
    await expect(documentService.setTargetLanguage('doc_missing', 'my')).rejects.toThrow(
      /not found/i,
    );
  });
});

function rawPageInput(): RawPageInput {
  return {
    index: 0,
    width: 612,
    height: 792,
    rotation: 0,
    items: [
      {
        text: 'First line of the page.',
        bbox: { x: 72, y: 72, width: 200, height: 14 },
        fontSize: 14,
        fontKey: 'f1',
        hasEol: true,
      },
      {
        text: 'Second line of the page.',
        bbox: { x: 72, y: 92, width: 210, height: 14 },
        fontSize: 14,
        fontKey: 'f1',
        hasEol: true,
      },
    ],
    fonts: [{ key: 'f1', family: 'Helvetica', bold: false, italic: false }],
    images: [],
    links: [],
  };
}

describe('documentService.applyPageAnalysis (per-page commit counters)', () => {
  it('re-applying the same page does not double-count progress or blocks', async () => {
    await documentsRepo.put(makeDocument());
    const page = analyzePage(rawPageInput(), 'doc_1');
    expect(page.blocks.length).toBeGreaterThan(0);

    await documentService.applyPageAnalysis('doc_1', page);
    const first = await documentService.require('doc_1');
    expect(first.analysis?.processedPages).toBe(1);
    expect(first.analysis?.blocks).toBe(page.blocks.length);

    // What an OCR retry does: the very same page is applied a second time.
    await documentService.applyPageAnalysis('doc_1', page);
    const second = await documentService.require('doc_1');
    expect(second.analysis?.processedPages).toBe(1);
    expect(second.analysis?.blocks).toBe(page.blocks.length);
    expect(await documentService.blocksOfDocument('doc_1')).toHaveLength(page.blocks.length);
  });
});
