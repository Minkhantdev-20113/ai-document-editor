import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { appEvents } from '../core/events/eventBus';
import type { DocumentRecord, TranslationUnit } from '../db/entities';
import { documentsRepo, translationUnitsRepo } from '../db/repositories';
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
