// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { syncQueueRepo } from '../db/repositories';
import { settingsService } from './settingsService';
import { syncService } from './syncService';

describe('syncService (optional, metadata-only, redacted)', () => {
  beforeEach(async () => {
    await syncQueueRepo.clear();
    await settingsService.setMany({ syncEndpoint: null, syncEnabled: false });
  });

  it('redacts secret-looking content before a record is queued', async () => {
    const record = await syncService.queueChange({
      entity: 'projects',
      entityId: 'project-1',
      op: 'upsert',
      payload: {
        name: 'Quarterly report',
        apiKey: 'AIzaSyFakeKeyNotReal012345',
        note: 'temporary token sk-abcdefghijklmnop',
      },
    });

    expect(record.status).toBe('pending');
    expect(record.payload?.apiKey).toBe('[redacted]');
    expect(record.payload?.note).toBe('temporary token [redacted]');
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('AIzaSyFakeKeyNotReal012345');
    expect(serialized).not.toContain('sk-abcdefgh');
  });

  it('merges repeat changes for one entity instead of growing the queue', async () => {
    const first = await syncService.queueChange({
      entity: 'projects',
      entityId: 'project-1',
      op: 'upsert',
      payload: { name: 'A' },
    });
    const second = await syncService.queueChange({
      entity: 'projects',
      entityId: 'project-1',
      op: 'upsert',
      payload: { name: 'B' },
    });

    expect(second.id).toBe(first.id);
    expect(await syncQueueRepo.count()).toBe(1);
    expect(second.payload?.name).toBe('B');
  });

  it('stays a no-op without an endpoint: records keep waiting', async () => {
    await syncService.queueChange({
      entity: 'projects',
      entityId: 'project-1',
      op: 'upsert',
      payload: { name: 'A' },
    });

    await expect(syncService.flush()).rejects.toMatchObject({ code: 'sync_unconfigured' });

    const records = await syncQueueRepo.getAll();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('pending');
    expect(await syncService.status()).toMatchObject({ configured: false, pending: 1 });
  });

  it('keeps records pending when a flush runs offline', async () => {
    await settingsService.set('syncEndpoint', 'https://example.invalid/exec');
    await syncService.queueChange({
      entity: 'projects',
      entityId: 'project-1',
      op: 'upsert',
      payload: { name: 'A' },
    });

    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    try {
      await expect(syncService.flush()).rejects.toMatchObject({ code: 'network_offline' });
    } finally {
      Reflect.deleteProperty(window.navigator, 'onLine');
    }

    const records = await syncQueueRepo.getAll();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('pending');
    expect(await syncService.status()).toMatchObject({ configured: true, pending: 1 });
  });
});
