import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { appEvents } from '../core/events/eventBus';
import type { GlossaryEntry, TranslationUnit } from '../db/entities';
import { glossaryEntriesRepo, translationUnitsRepo } from '../db/repositories';
import { ValidationService } from './validationService';

const service = new ValidationService();

function makeUnit(index: number, overrides: Partial<TranslationUnit> = {}): TranslationUnit {
  return {
    id: `u_${index}`,
    projectId: 'proj_1',
    documentId: 'doc_1',
    pageId: 'page_1',
    blockId: `b_${index}`,
    orderIndex: index,
    sourceText: `Source sentence number ${index}. It exists for validation.`,
    sourceLanguage: 'en',
    targetLanguage: 'my',
    translatedText: `ဘာသာပြန်ချက် ${index}`,
    status: 'translated',
    retryCount: 0,
    provider: 'gemini',
    model: 'gemini-3.8-flash',
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

beforeEach(async () => {
  await translationUnitsRepo.clear();
  await glossaryEntriesRepo.clear();
});

describe('validationService', () => {
  it('validates a document, persists findings per unit and summarizes', async () => {
    await translationUnitsRepo.putMany([
      makeUnit(1),
      // Preserves nothing: no number, no URL - two findings.
      makeUnit(2, {
        sourceText: 'Download 2 files from https://example.com now.',
        translatedText: 'အခု ဖိုင်များကို ဒေါင်းလုဒ်လုပ်ပါ။',
      }),
      // Completed but empty -> broken.
      makeUnit(3, { translatedText: '   ' }),
      // Unfinished: not a validation failure.
      makeUnit(4, { status: 'pending', translatedText: null }),
    ]);

    const summary = await service.validateDocument('doc_1');

    expect(summary.documentId).toBe('doc_1');
    expect(summary.unitsChecked).toBe(4);
    expect(summary.unitsWithWarnings).toBe(2);
    expect(summary.totalWarnings).toBe(3);
    expect(summary.byCode).toEqual({ numbers_changed: 1, urls_changed: 1, unexpected_empty: 1 });

    const units = await translationUnitsRepo.queryByIndex('by_document', 'doc_1');
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    expect(byId.get('u_1')?.warnings).toEqual([]);
    expect(byId.get('u_2')?.warnings?.map((warning) => warning.code)).toEqual([
      'numbers_changed',
      'urls_changed',
    ]);
    expect(byId.get('u_3')?.warnings).toEqual([{ code: 'unexpected_empty' }]);
    // Unfinished units get no findings - an explicit clean list, not a skip.
    expect(byId.get('u_4')?.warnings).toEqual([]);
  });

  it('emits units:changed only when findings actually change', async () => {
    // Seed a unit with a real finding so the first pass has something to store.
    await translationUnitsRepo.putMany([
      makeUnit(1, { sourceText: 'Copy 7 files.', translatedText: 'ဖိုင်များ ကူးပါ။' }),
    ]);
    let events = 0;
    const off = appEvents.on('units:changed', () => (events += 1));

    await service.validateDocument('doc_1');
    const afterFirst = events;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    await service.validateDocument('doc_1');
    expect(events).toBe(afterFirst); // stable findings -> no churn
    off();
  });

  it('clears stale findings once the text is fixed', async () => {
    await translationUnitsRepo.putMany([
      makeUnit(1, { sourceText: 'Copy 7 files.', translatedText: 'ဖိုင်များ ကူးပါ။' }),
    ]);
    await service.validateDocument('doc_1');
    const broken = await translationUnitsRepo.get('u_1');
    expect(broken?.warnings?.[0]?.code).toBe('numbers_changed');

    await translationUnitsRepo.put({
      ...(broken as TranslationUnit),
      translatedText: '7 ဖိုင်ကို ကူးပါ။',
    });
    await service.validateDocument('doc_1');
    expect((await translationUnitsRepo.get('u_1'))?.warnings).toEqual([]);
  });

  it('flags duplicated text on both units with different sources', async () => {
    await translationUnitsRepo.putMany([
      makeUnit(1, { sourceText: 'Footer: All rights reserved.', translatedText: 'မူပိုင်ခွင့် အားလုံး ထိန်းသိမ်းထားသည်' }),
      makeUnit(2, { sourceText: 'Notice: Subject to change.', translatedText: 'မူပိုင်ခွင့် အားလုံး ထိန်းသိမ်းထားသည်' }),
    ]);

    const summary = await service.validateDocument('doc_1');
    expect(summary.byCode).toEqual({ duplicated_text: 2 });

    const units = await translationUnitsRepo.queryByIndex('by_document', 'doc_1');
    for (const unit of units) {
      expect(unit.warnings).toEqual([{ code: 'duplicated_text' }]);
    }
  });

  it('applies glossary rules to findings', async () => {
    await glossaryEntriesRepo.put({
      id: 'glo_1',
      projectId: 'proj_1',
      sourceTerm: 'the Submit button',
      preferredTranslation: 'တင်သည့်ခလုတ်',
      forbiddenTranslation: null,
      notes: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    } satisfies GlossaryEntry);
    await translationUnitsRepo.putMany([
      makeUnit(1, {
        sourceText: 'Click the Submit button.',
        translatedText: 'ခလုတ်ကို နှိပ်ပါ။',
      }),
    ]);

    const summary = await service.validateDocument('doc_1');
    expect(summary.byCode).toEqual({ glossary_violation: 1 });
    expect((await translationUnitsRepo.get('u_1'))?.warnings?.[0]?.detail).toContain('တင်သည့်ခလုတ်');
  });

  it('validateUnit writes only the target row', async () => {
    await translationUnitsRepo.putMany([
      makeUnit(1, { sourceText: 'Copy 5 files.', translatedText: 'ဖိုင် ကူးပါ။' }),
      makeUnit(2, { sourceText: 'Copy 9 files.', translatedText: 'ဖိုင် ကူးပါ။' }),
    ]);
    // u_2 carries stale warnings that a u_1 revalidation must not touch.
    await translationUnitsRepo.put({
      ...(await translationUnitsRepo.get('u_2'))!,
      warnings: [{ code: 'untranslated' }],
    });

    const warnings = await service.validateUnit('u_1');
    // Numbers lost from u_1, and its translation collides with u_2's (the
    // sibling contributes to the comparison but its row is not rewritten).
    expect(warnings.map((warning) => warning.code)).toEqual([
      'numbers_changed',
      'duplicated_text',
    ]);

    expect((await translationUnitsRepo.get('u_1'))?.warnings?.map((w) => w.code)).toEqual([
      'numbers_changed',
      'duplicated_text',
    ]);
    expect((await translationUnitsRepo.get('u_2'))?.warnings).toEqual([{ code: 'untranslated' }]);
    expect(await service.validateUnit('u_missing')).toEqual([]);
  });

  it('handles an empty document gracefully', async () => {
    const summary = await service.validateDocument('doc_empty');
    expect(summary).toEqual({
      documentId: 'doc_empty',
      unitsChecked: 0,
      unitsWithWarnings: 0,
      totalWarnings: 0,
      byCode: {},
    });
  });
});
