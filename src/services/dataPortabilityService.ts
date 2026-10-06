import { APP_VERSION } from '../config/appConfig';
import { appEvents } from '../core/events/eventBus';
import { AppError } from '../core/errors/appError';
import { logger } from '../core/logging/logger';
import { keyVault } from '../security/keyVault';
import { STORES, type StoreName } from '../db/schema';
import {
  apiKeysRepo,
  documentBlocksRepo,
  documentsRepo,
  documentPagesRepo,
  editorDocumentsRepo,
  errorLogsRepo,
  glossaryEntriesRepo,
  jobsRepo,
  keyRuntimeRepo,
  projectsRepo,
  providerConfigsRepo,
  secretsRepo,
  settingsRepo,
  syncQueueRepo,
  translationUnitsRepo,
  usageRepo,
} from '../db/repositories';
import { removeUnsupportedProviderState } from './providerCleanup';

/**
 * Stores included in an export. Secrets are deliberately excluded, and the
 * export store only ever holds transient binary checkpoints/files (not a
 * portable backup), so it stays out of JSON bundles too.
 */
const EXPORTABLE_STORES = STORES.filter(
  (store) => store !== 'secretVault' && store !== 'exportArtifacts',
) as readonly StoreName[];

export interface ExportBundle {
  readonly format: 'adt-export';
  readonly version: number;
  readonly appVersion: string;
  readonly exportedAt: number;
  readonly stores: Partial<Record<StoreName, unknown[]>>;
}

function repoFor(store: StoreName): { getAll(): Promise<unknown[]>; putMany(values: never[]): Promise<void>; clear(): Promise<void> } {
  switch (store) {
    case 'projects':
      return projectsRepo as never;
    case 'documents':
      return documentsRepo as never;
    case 'documentPages':
      return documentPagesRepo as never;
    case 'documentBlocks':
      return documentBlocksRepo as never;
    case 'translationUnits':
      return translationUnitsRepo as never;
    case 'glossaryEntries':
      return glossaryEntriesRepo as never;
    case 'editorDocuments':
      return editorDocumentsRepo as never;
    case 'settings':
      return settingsRepo as never;
    case 'providerConfigs':
      return providerConfigsRepo as never;
    case 'apiKeyMetadata':
      return apiKeysRepo as never;
    case 'keyRuntime':
      return keyRuntimeRepo as never;
    case 'jobQueue':
      return jobsRepo as never;
    case 'usageSnapshots':
      return usageRepo as never;
    case 'syncQueue':
      return syncQueueRepo as never;
    case 'errorLogs':
      return errorLogsRepo as never;
    default:
      throw new AppError(`Store ${store} is not exportable`, { code: 'validation' });
  }
}

/** Local data portability: export/import every non-secret store as JSON. */
class DataPortabilityService {
  async exportAll(): Promise<ExportBundle> {
    const stores: Partial<Record<StoreName, unknown[]>> = {};
    for (const store of EXPORTABLE_STORES) {
      stores[store] = await repoFor(store).getAll();
    }
    return {
      format: 'adt-export',
      version: 1,
      appVersion: APP_VERSION,
      exportedAt: Date.now(),
      stores,
    };
  }

  async downloadExport(): Promise<void> {
    const bundle = await this.exportAll();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ai-document-translator-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logger.info('Data export created', { stores: EXPORTABLE_STORES.length });
  }

  /** Validates a bundle and merges it into the local database. */
  async importBundle(raw: string): Promise<{ records: number }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new AppError('The file is not valid JSON', { code: 'import_invalid', retryable: false });
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new AppError('Unexpected file contents', { code: 'import_invalid', retryable: false });
    }
    const bundle = parsed as Partial<ExportBundle>;
    if (bundle.format !== 'adt-export' || !bundle.stores || typeof bundle.stores !== 'object') {
      throw new AppError('This file is not an AI Document Translator export', {
        code: 'import_invalid',
        retryable: false,
      });
    }

    let records = 0;
    for (const store of EXPORTABLE_STORES) {
      const values = bundle.stores[store];
      if (!Array.isArray(values) || values.length === 0) continue;
      await repoFor(store).putMany(values as never);
      records += values.length;
    }

    // An older bundle can carry provider rows this build dropped (DeepSeek in
    // 0.6.0): write first so the reported record count is honest about the
    // file, then drop what the app cannot use any more.
    await removeUnsupportedProviderState();

    logger.info('Data import completed', { records });
    appEvents.emit('projects:changed', {});
    appEvents.emit('documents:changed', {});
    appEvents.emit('jobs:changed', {});
    appEvents.emit('settings:changed', { keys: [] });
    appEvents.emit('providers:changed', {});
    appEvents.emit('apiKeys:changed', {});
    appEvents.emit('usage:changed', {});
    appEvents.emit('editor:changed', {});
    return { records };
  }

  async clearAllLocalData(): Promise<void> {
    // Secrets are cleared through the vault so the in-memory key is dropped too.
    for (const store of EXPORTABLE_STORES) {
      await repoFor(store).clear();
    }
    await secretsRepo.clear().catch(() => undefined);
    keyVault.lock();
    logger.warn('All local data cleared');
    appEvents.emit('projects:changed', {});
    appEvents.emit('documents:changed', {});
    appEvents.emit('jobs:changed', {});
    appEvents.emit('settings:changed', { keys: [] });
    appEvents.emit('providers:changed', {});
    appEvents.emit('apiKeys:changed', {});
    appEvents.emit('usage:changed', {});
    appEvents.emit('editor:changed', {});
    appEvents.emit('errors:changed', {});
    appEvents.emit('sync:changed', {});
  }
}

export const dataPortabilityService = new DataPortabilityService();
