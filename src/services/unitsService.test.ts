import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../core/errors/appError';
import type { TranslationUnit } from '../db/entities';
import { glossaryEntriesRepo, translationUnitsRepo } from '../db/repositories';
import { UnitsService } from './unitsService';

const service = new UnitsService();

function makeUnit(index: number, overrides: Partial<TranslationUnit> = {}): TranslationUnit {
  return {
    id: `u_${index}`,
    projectId: 'proj_1',
    documentId: 'doc_1',
    pageId: 'page_1',
    blockId: `b_${index}`,
    orderIndex: index,
    sourceText: `Copy ${index} files to the folder.`,
    sourceLanguage: 'en',
    targetLanguage: 'my',
    translatedText: `ဖိုင် ${index} ခု ကူးပါ။`,
    status: 'translated',
    retryCount: 0,
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    keyId: null,
    estimatedTokens: 10,
    actualTokens: 8,
    error: null,
    sourceChecksum: 'checksum',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(async () => {
  await translationUnitsRepo.clear();
  await glossaryEntriesRepo.clear();
});

describe('unitsService - manual edits', () => {
  it('saves a human edit, stamps editedAt and keeps AI provenance', async () => {
    await translationUnitsRepo.put(makeUnit(1));
    const before = await translationUnitsRepo.get('u_1');

    const { unit, warnings } = await service.updateTranslation('u_1', 'လူကိုယ်တိုင် ပြင်ထားသော ဘာသာပြန်ချက်');

    expect(unit.translatedText).toBe('လူကိုယ်တိုင် ပြင်ထားသော ဘာသာပြန်ချက်');
    expect(unit.editedAt).toBeTypeOf('number');
    expect(unit.editedAt).toBeGreaterThanOrEqual(before?.updatedAt ?? 0);
    expect(unit.status).toBe('translated');
    // Provenance of the ORIGINAL AI output stays intact for the context panel.
    expect(unit.provider).toBe('gemini');
    expect(unit.model).toBe('gemini-3.8-flash');
    expect(unit.error).toBeNull();
    // Warnings are recomputed against the edited text.
    expect(Array.isArray(warnings)).toBe(true);
  });

  it('revalidates the edit: fixing restores clean, breaking flags numbers', async () => {
    await translationUnitsRepo.put(
      makeUnit(1, { sourceText: 'Copy 7 files.', translatedText: 'ဖိုင်များ ကူးပါ။' }),
    );

    const fixed = await service.updateTranslation('u_1', '7 ဖိုင်ကို ကူးပါ။');
    expect(fixed.warnings).toEqual([]);
    expect((await translationUnitsRepo.get('u_1'))?.warnings).toEqual([]);

    const broken = await service.updateTranslation('u_1', 'ဖိုင်များ ကူးပါ။');
    expect(broken.warnings.map((warning) => warning.code)).toEqual(['numbers_changed']);
    expect((await translationUnitsRepo.get('u_1'))?.warnings?.[0]?.code).toBe('numbers_changed');
  });

  it('clearing the text un-translates the unit (pending, no text)', async () => {
    await translationUnitsRepo.put(makeUnit(1));
    const { unit } = await service.updateTranslation('u_1', '   ');
    expect(unit.translatedText).toBeNull();
    expect(unit.status).toBe('pending');
    expect(unit.editedAt).toBeTypeOf('number');
  });

  it('keeps a reviewed unit reviewed; review requires text', async () => {
    await translationUnitsRepo.put(makeUnit(1, { status: 'reviewed' }));
    const { unit } = await service.updateTranslation('u_1', 'ပြင်ဆင်ပြီး');
    expect(unit.status).toBe('reviewed');

    await translationUnitsRepo.put(makeUnit(2, { translatedText: '   ', status: 'pending' }));
    await expect(service.setReviewed('u_2', true)).rejects.toThrow(/without a translation/);

    const reviewed = await service.setReviewed('u_1', true);
    expect(reviewed.status).toBe('reviewed');
    const unreviewed = await service.setReviewed('u_1', false);
    expect(unreviewed.status).toBe('translated');
  });

  it('requestRetranslation discards the edit so the next run retranslates', async () => {
    await translationUnitsRepo.put(
      makeUnit(1, { status: 'reviewed', editedAt: 1_700_000_000_123, retryCount: 3 }),
    );
    const next = await service.requestRetranslation('u_1');
    expect(next.status).toBe('pending');
    expect(next.editedAt).toBeNull();
    expect(next.retryCount).toBe(0);
    expect(next.warnings ?? []).toEqual([]);
    // The old text stays visible until the new one arrives.
    expect(next.translatedText).toBe('ဖိုင် 1 ခု ကူးပါ။');
  });

  it('keeps the AI suggestion (aiText) when a manual edit replaces the text', async () => {
    await translationUnitsRepo.put(
      makeUnit(1, { aiText: 'ဖိုင် 1 ခု ကူးပါ။', translatedText: 'ဖိုင် 1 ခု ကူးပါ။' }),
    );

    const { unit } = await service.updateTranslation('u_1', 'လူကိုယ်တိုင် ပြင်ထားသည်');

    // The translation moved to the human text, but the AI's own wording is
    // still available for the editor's "AI suggestion" section.
    expect(unit.translatedText).toBe('လူကိုယ်တိုင် ပြင်ထားသည်');
    expect(unit.aiText).toBe('ဖိုင် 1 ခု ကူးပါ။');
    expect(unit.editedAt).toBeTypeOf('number');
  });

  it('keeps aiText through an explicit retranslation request', async () => {
    await translationUnitsRepo.put(makeUnit(1, { aiText: 'AI စာသားဟောင်း' }));
    const next = await service.requestRetranslation('u_1');
    // The next engine run will overwrite aiText with fresh AI output; until
    // then the last AI wording stays inspectable.
    expect(next.aiText).toBe('AI စာသားဟောင်း');
    expect(next.editedAt).toBeNull();
  });

  it('reports missing units as not_found', async () => {
    await expect(service.updateTranslation('u_missing', 'x')).rejects.toThrow(AppError);
    await expect(service.setReviewed('u_missing', true)).rejects.toThrow(/not found/);
    await expect(service.requestRetranslation('u_missing')).rejects.toThrow(/not found/);
  });
});
