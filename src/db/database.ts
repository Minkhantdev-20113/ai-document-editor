import { openDB, type IDBPDatabase } from 'idb';
import { DB_NAME, DB_VERSION } from '../config/appConfig';
import { AppError, toAppError, type AppError as AppErrorType } from '../core/errors/appError';
import { logger } from '../core/logging/logger';
import { STORE_DEFINITIONS, type AppDBSchema } from './schema';

/** Structural view of an object store during an upgrade transaction. */
interface UpgradeStore {
  readonly indexNames: DOMStringList;
  createIndex(name: string, keyPath: string | string[], options?: IDBIndexParameters): IDBIndex;
}

let dbPromise: Promise<IDBPDatabase<AppDBSchema>> | null = null;
let database: IDBPDatabase<AppDBSchema> | null = null;
let closed = false;

/**
 * Single connection to IndexedDB.
 *
 * The promise is memoized so concurrent services share one connection, and a
 * failed open is retried on the next call instead of caching the failure.
 */
export function getDatabase(): Promise<IDBPDatabase<AppDBSchema>> {
  if (closed) closed = false;
  if (!dbPromise) {
    dbPromise = openDatabase()
      .then((db) => {
        database = db;
        return db;
      })
      .catch((error: unknown) => {
        dbPromise = null;
        database = null;
        logger.errorWith(error, 'IndexedDB open failed');
        throw normalizeDbError(error, 'IndexedDB could not be opened');
      });
  }
  return dbPromise;
}

export function getCurrentDatabase(): IDBPDatabase<AppDBSchema> | null {
  return database;
}

async function openDatabase(): Promise<IDBPDatabase<AppDBSchema>> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is not available in this environment');
  }

  return openDB<AppDBSchema>(DB_NAME, DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, transaction) {
      logger.info('Upgrading database schema', {
        from: _oldVersion ?? 0,
        to: _newVersion ?? DB_VERSION,
      });
      for (const definition of STORE_DEFINITIONS) {
        if (!db.objectStoreNames.contains(definition.name)) {
          db.createObjectStore(definition.name, { keyPath: definition.keyPath });
        }
        const store = transaction.objectStore(definition.name) as unknown as UpgradeStore;
        for (const index of definition.indexes) {
          if (store.indexNames.contains(index.name)) continue;
          store.createIndex(index.name, index.keyPath as string | string[], {
            unique: index.unique ?? false,
            multiEntry: false,
          });
        }
      }
    },
    blocked() {
      logger.warn('IndexedDB open blocked by another tab', { dbName: DB_NAME });
    },
    blocking() {
      // Another tab wants to upgrade: release our connection so it can proceed.
      logger.info('Closing IndexedDB connection (blocked by another tab)');
      void closeDatabase();
    },
    terminated() {
      logger.warn('IndexedDB connection terminated unexpectedly');
      database = null;
      dbPromise = null;
    },
  });
}

export async function closeDatabase(): Promise<void> {
  const current = database;
  dbPromise = null;
  database = null;
  closed = true;
  if (current) {
    current.close();
  }
}

/** Re-open after an explicit close (used by settings > reset database). */
export function reopenDatabase(): Promise<IDBPDatabase<AppDBSchema>> {
  closed = false;
  dbPromise = null;
  database = null;
  return getDatabase();
}

export async function estimateStorageUsage(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  } catch {
    return null;
  }
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export function normalizeDbError(error: unknown, message: string): AppErrorType {
  const base = toAppError(error, 'db_operation_failed');
  return new AppError(`${message}: ${base.message}`, {
    code: 'db_operation_failed',
    retryable: true,
    cause: error,
    ...(base.details ? { details: base.details } : {}),
  });
}
