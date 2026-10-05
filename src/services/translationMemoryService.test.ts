import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TranslationUnit } from '../db/entities';
import { translationUnitsRepo } from '../db/repositories';
import { MEMORY_THRESHOLDS } from '../domain/translationMemory';
import { TranslationMemoryService } from './translationMemoryService';

const service = new TranslationMemoryService();

function makeUnit(index: number, overrides: Partial<TranslationUnit> = {}): TranslationUnit {
  return {
    id: `u_${index}`,
    projectId: 'proj_1',
    documentId: 'doc_1',
    pageId: 'page_1',
    blockId: `b_${index}`,
    orderIndex: index,
    sourceText: `Source sentence number ${index}.`,
    sourceLanguage: 'en',
    targetLanguage: 'my',
    translatedText: `ဘာသာပြန်ချက် ${index}`,
    status: 'translated',
    retryCount: 0,
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    keyId: null,
    estimatedTokens: null,
    actualTokens: null,
    error: null,
    sourceChecksum: 'checksum',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

const BOILERPLATE = 'Click the Submit button to save the document.';

beforeEach(async () => {
  await translationUnitsRepo.clear();
});

describe('translationMemoryService', () => {
  it('suggests the closest previous translations first', async () => {
    await translationUnitsRepo.putMany([
      makeUnit(1, { sourceText: BOILERPLATE, translatedText: 'စာရွက်ကို သိမ်းရန် တင်သည့်ခလုတ်ကို နှိပ်ပါ' }),
      makeUnit(2, { sourceText: 'Click the Submit button to save the file.', translatedText: 'ဖိုင်သိမ်းရန် နှိပ်ပါ' }),
      makeUnit(3, { sourceText: 'The weather in Yangon is hot today.', translatedText: 'ရန်ကုန်ရာသီဥတု ပူသည်' }),
    ]);

    const matches = await service.suggest({ projectId: 'proj_1', sourceText: BOILERPLATE });

    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches[0]?.unitId).toBe('u_1');
    expect(matches[0]?.score).toBe(1);
    // The unrelated unit never reaches the suggestion list.
    expect(matches.some((match) => match.unitId === 'u_3')).toBe(false);
    for (const match of matches) {
      expect(match.score).toBeGreaterThanOrEqual(MEMORY_THRESHOLDS.suggest);
    }
  });

  it('never suggests the unit itself and honours limit', async () => {
    await translationUnitsRepo.putMany([
      makeUnit(1, { sourceText: BOILERPLATE }),
      makeUnit(2, { sourceText: BOILERPLATE }),
      makeUnit(3, { sourceText: BOILERPLATE }),
    ]);

    const matches = await service.suggest({
      projectId: 'proj_1',
      sourceText: BOILERPLATE,
      excludeUnitId: 'u_1',
      limit: 1,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.unitId).toBe('u_2');
  });

  it('ignores untranslated units, other projects and other target languages', async () => {
    await translationUnitsRepo.putMany([
      makeUnit(1, { sourceText: BOILERPLATE, status: 'pending', translatedText: null }),
      makeUnit(2, { sourceText: BOILERPLATE, translatedText: '   ' }),
      makeUnit(3, { sourceText: BOILERPLATE, projectId: 'proj_2' }),
      makeUnit(4, { sourceText: BOILERPLATE, targetLanguage: 'de' }),
      makeUnit(5, { sourceText: BOILERPLATE, status: 'reviewed' }),
    ]);

    const matches = await service.suggest({
      projectId: 'proj_1',
      sourceText: BOILERPLATE,
      targetLanguage: 'my',
    });
    expect(matches.map((match) => match.unitId)).toEqual(['u_5']);
  });

  it('respects a raised minScore (no weak matches)', async () => {
    await translationUnitsRepo.putMany([
      makeUnit(1, { sourceText: 'Click the Submit button to save the document.' }),
      makeUnit(2, { sourceText: 'Click the Cancel button to discard changes.' }),
    ]);
    const matches = await service.suggest({
      projectId: 'proj_1',
      sourceText: BOILERPLATE,
      minScore: 0.99,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.unitId).toBe('u_1');
  });

  it('best() returns the top match or null', async () => {
    expect(await service.best({ projectId: 'proj_1', sourceText: BOILERPLATE })).toBeNull();

    await translationUnitsRepo.putMany([makeUnit(1, { sourceText: BOILERPLATE })]);
    const best = await service.best({
      projectId: 'proj_1',
      sourceText: BOILERPLATE,
      excludeUnitId: 'u_1',
    });
    expect(best).toBeNull();

    await translationUnitsRepo.putMany([makeUnit(2, { sourceText: BOILERPLATE })]);
    const match = await service.best({ projectId: 'proj_1', sourceText: BOILERPLATE });
    expect(match?.unitId).toBe('u_1');
    expect(match?.score).toBe(1);
  });
});
