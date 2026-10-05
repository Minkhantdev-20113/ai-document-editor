import { LIMITS } from '../config/appConfig';
import { appEvents } from '../core/events/eventBus';
import { registerLogSink, type LogRecord } from '../core/logging/logger';
import { newId } from '../core/utils/id';
import { errorLogsRepo } from '../db/repositories';
import type { ErrorLogRecord } from '../db/entities';
import { settingsService } from './settingsService';

/**
 * Centralized diagnostics persistence.
 *
 * Only warn/error records are stored, already redacted by the logger, and the
 * table is trimmed to a fixed size so it can never grow unbounded.
 */
class ErrorLogService {
  private started = false;
  private flushing = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    registerLogSink((record) => void this.persist(record));
    void this.trim();
  }

  private async persist(record: LogRecord): Promise<void> {
    if (!settingsService.value('retainErrorLogs')) return;
    if (this.flushing) return;
    this.flushing = true;
    try {
      const entry: ErrorLogRecord = {
        id: record.id ?? newId('err'),
        level: record.level === 'warn' ? 'warn' : 'error',
        scope: record.scope,
        message: record.message,
        code: record.code ?? null,
        context: record.context ?? null,
        stack: typeof record.context?.['stack'] === 'string' ? (record.context['stack'] as string) : null,
        occurredAt: record.ts,
      };
      await errorLogsRepo.put(entry);
      appEvents.emit('errors:changed', {});
    } catch {
      /* persistence failures must not cascade */
    } finally {
      this.flushing = false;
    }
  }

  async list(limit = 100): Promise<ErrorLogRecord[]> {
    const records = (await errorLogsRepo.queryByIndex('by_occurredAt')) ?? [];
    return records.sort((a, b) => b.occurredAt - a.occurredAt).slice(0, limit);
  }

  async count(): Promise<number> {
    return errorLogsRepo.count();
  }

  async clear(): Promise<void> {
    await errorLogsRepo.clear();
    appEvents.emit('errors:changed', {});
  }

  private async trim(): Promise<void> {
    try {
      const count = await errorLogsRepo.count();
      if (count <= LIMITS.persistedErrorLogs) return;
      const records = await errorLogsRepo.queryByIndex('by_occurredAt');
      const sorted = [...(records ?? [])].sort((a, b) => a.occurredAt - b.occurredAt);
      const excess = sorted.slice(0, count - LIMITS.persistedErrorLogs);
      await errorLogsRepo.deleteMany(excess.map((record) => record.id));
    } catch {
      /* best effort */
    }
  }
}

export const errorLogService = new ErrorLogService();
