import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { appEvents } from '../core/events/eventBus';
import { AppError } from '../core/errors/appError';
import { glossaryEntriesRepo } from '../db/repositories';
import { GlossaryService } from './glossaryService';

const service = new GlossaryService();

const RULE = {
  sourceTerm: 'the Submit button',
  preferredTranslation: 'တင်သည့်ခလုတ်',
};

describe('glossaryService', () => {
  beforeEach(async () => {
    await glossaryEntriesRepo.clear();
  });

  it('creates, lists (sorted) and projects rules', async () => {
    const seen: Array<{ projectId?: string }> = [];
    const off = appEvents.on('glossary:changed', (payload) => seen.push(payload));

    await service.create('prj-1', RULE);
    await service.create('prj-1', { sourceTerm: 'Alpha', preferredTranslation: 'အယ်လ်ဖာ' });
    // Entries in another project must not leak into this one's list.
    await service.create('prj-2', { sourceTerm: 'Beta', preferredTranslation: 'ဘီတာ' });

    const entries = await service.list('prj-1');
    expect(entries.map((entry) => entry.sourceTerm)).toEqual(['Alpha', 'the Submit button']);
    expect(entries[0]?.projectId).toBe('prj-1');

    const rules = await service.rulesFor('prj-1');
    expect(rules).toEqual([
      { source: 'Alpha', preferred: 'အယ်လ်ဖာ' },
      { source: 'the Submit button', preferred: 'တင်သည့်ခလုတ်' },
    ]);

    expect(seen).toEqual([{ projectId: 'prj-1' }, { projectId: 'prj-1' }, { projectId: 'prj-2' }]);
    off();
  });

  it('rejects a duplicate term case-insensitively', async () => {
    await service.create('prj-1', RULE);
    await expect(
      service.create('prj-1', { sourceTerm: '  THE submit  BUTTON ', preferredTranslation: 'x' }),
    ).rejects.toThrow(/already has a glossary rule/);

    // Same term in a DIFFERENT project is allowed.
    await expect(
      service.create('prj-2', { sourceTerm: 'the Submit button', preferredTranslation: 'x' }),
    ).resolves.toBeDefined();
  });

  it('validates inputs with typed errors before touching storage', async () => {
    const before = await glossaryEntriesRepo.count();
    await expect(service.create('prj-1', { sourceTerm: ' ', preferredTranslation: 'x' })).rejects.toThrow(
      AppError,
    );
    expect(await glossaryEntriesRepo.count()).toBe(before);
  });

  it('updates an entry, keeping its own term and rejecting sibling collisions', async () => {
    const created = await service.create('prj-1', RULE);
    const sibling = await service.create('prj-1', {
      sourceTerm: 'the Cancel button',
      preferredTranslation: 'ပယ်ဖျက်သည့်ခလုတ်',
    });

    // Keeping the entry's own term while editing its translation is fine.
    const updated = await service.update(created.id, {
      ...RULE,
      preferredTranslation: 'တင်ရန်ခလုတ်',
      notes: 'control',
    });
    expect(updated.preferredTranslation).toBe('တင်ရန်ခလုတ်');
    expect(updated.notes).toBe('control');
    expect(updated.id).toBe(created.id);

    // Colliding with the sibling term is not.
    await expect(
      service.update(created.id, { sourceTerm: 'the cancel button', preferredTranslation: 'y' }),
    ).rejects.toThrow(/already has a glossary rule/);

    // The sibling can adopt the vacated... it never was vacated; it still collides.
    await expect(
      service.update(sibling.id, { sourceTerm: 'the Submit Button', preferredTranslation: 'z' }),
    ).rejects.toThrow(/already has a glossary rule/);
  });

  it('removes an entry and reports missing entries as not_found', async () => {
    const created = await service.create('prj-1', RULE);
    await service.remove(created.id);
    expect(await service.get(created.id)).toBeUndefined();
    await expect(service.require(created.id)).rejects.toThrow(/not found/);
    await expect(service.remove('glo_missing')).rejects.toThrow(/not found/);
  });
});
