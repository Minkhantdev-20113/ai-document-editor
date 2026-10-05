import { appEvents } from '../core/events/eventBus';
import { AppError, toAppError } from '../core/errors/appError';
import { logger } from '../core/logging/logger';
import { newId } from '../core/utils/id';
import { deepRedact } from '../core/utils/redact';
import { syncQueueRepo } from '../db/repositories';
import type { SyncRecord, SyncStatus } from '../db/entities';
import { settingsService } from './settingsService';

export interface SyncStatusInfo {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly pending: number;
  readonly failed: number;
  readonly lastFlushedAt: number | null;
}

export interface QueueChangeInput {
  readonly entity: SyncRecord['entity'];
  readonly entityId: string;
  readonly op: SyncRecord['op'];
  readonly payload: Record<string, unknown> | null;
}

/**
 * Cloud synchronization (secondary path).
 *
 * Local writes are authoritative: this service only records that something
 * changed and, when an Apps Script endpoint is configured, pushes queued
 * records there. Payloads are deep-redacted so no secret can ever travel.
 */
class SyncService {
  async queueChange(input: QueueChangeInput): Promise<SyncRecord> {
    const timestamp = Date.now();
    // `by_entity` is keyed by the entity *type*, so the candidate rows are
    // fetched per type and narrowed by id/op in memory: one row per entity,
    // reused across changes instead of growing the queue.
    const existing = (await syncQueueRepo.queryByIndex('by_entity', input.entity)) ?? [];
    const duplicate = existing.find((record) => record.entityId === input.entityId && record.op === input.op);

    if (duplicate) {
      const merged: SyncRecord = {
        ...duplicate,
        payload: input.payload ? (deepRedact(input.payload) as Record<string, unknown>) : null,
        status: 'pending',
        updatedAt: timestamp,
      };
      await syncQueueRepo.put(merged);
      appEvents.emit('sync:changed', {});
      return merged;
    }

    const record: SyncRecord = {
      id: newId('sync'),
      entity: input.entity,
      entityId: input.entityId,
      op: input.op,
      payload: input.payload ? (deepRedact(input.payload) as Record<string, unknown>) : null,
      status: 'pending',
      attempts: 0,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await syncQueueRepo.put(record);
    appEvents.emit('sync:changed', {});
    return record;
  }

  async status(): Promise<SyncStatusInfo> {
    const settings = settingsService.get();
    const records = await syncQueueRepo.getAll();
    return {
      configured: Boolean(settings.syncEndpoint),
      enabled: settings.syncEnabled,
      pending: records.filter((record) => record.status === 'pending').length,
      failed: records.filter((record) => record.status === 'failed').length,
      lastFlushedAt: records.filter((record) => record.status === 'done').reduce<number | null>(
        (latest, record) => (latest === null || record.updatedAt > latest ? record.updatedAt : latest),
        null,
      ),
    };
  }

  /** Pushes pending records to the configured endpoint. */
  async flush(): Promise<{ sent: number }> {
    const settings = settingsService.get();
    if (!settings.syncEndpoint) {
      throw new AppError('No synchronization endpoint configured', {
        code: 'sync_unconfigured',
        retryable: false,
      });
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new AppError('You are offline', { code: 'network_offline', retryable: true });
    }

    const pending = (await syncQueueRepo.queryByIndex('by_status', 'pending')).slice(0, 100);
    if (pending.length === 0) return { sent: 0 };

    const inFlight: SyncRecord[] = pending.map((record) => ({
      ...record,
      status: 'in_flight' as SyncStatus,
      attempts: record.attempts + 1,
      updatedAt: Date.now(),
    }));
    await syncQueueRepo.putMany(inFlight);

    try {
      const response = await fetch(settings.syncEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ records: inFlight, sentAt: Date.now() }),
        mode: 'cors',
        credentials: 'omit',
      });
      if (!response.ok) {
        throw new AppError(`Endpoint responded with ${response.status}`, {
          code: 'provider_unavailable',
          retryable: true,
        });
      }
      const done: SyncRecord[] = inFlight.map((record) => ({
        ...record,
        status: 'done',
        payload: null,
        lastError: null,
        updatedAt: Date.now(),
      }));
      await syncQueueRepo.putMany(done);
      logger.info('Sync flush completed', { sent: done.length });
      appEvents.emit('sync:changed', {});
      return { sent: done.length };
    } catch (error) {
      const appError = toAppError(error, 'provider_unavailable');
      const failed: SyncRecord[] = inFlight.map((record) => ({
        ...record,
        status: 'failed',
        lastError: appError.message,
        updatedAt: Date.now(),
      }));
      await syncQueueRepo.putMany(failed);
      appEvents.emit('sync:changed', {});
      throw appError;
    }
  }

  async clear(): Promise<void> {
    await syncQueueRepo.clear();
    appEvents.emit('sync:changed', {});
  }
}

export const syncService = new SyncService();
