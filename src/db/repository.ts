import type { IDBPDatabase } from 'idb';
import { logger } from '../core/logging/logger';
import { toAppError } from '../core/errors/appError';
import { getDatabase } from './database';
import type { AppDBSchema, StoreName } from './schema';

/** Value type stored in one store, derived from the IndexedDB contract. */
export type StoreValue<K extends StoreName> = AppDBSchema[K]['value'];

/** IndexedDB keys are string | number | date | binary | array. */
export type IndexQuery = string | number | Date | null | IDBKeyRange;

/**
 * Typed CRUD facade over one IndexedDB store.
 *
 * All persistence goes through a repository so services never touch the raw
 * database API, and every failure is normalized into an AppError.
 */
export class Repository<K extends StoreName> {
  constructor(private readonly storeName: K) {}

  private open(): Promise<IDBPDatabase<AppDBSchema>> {
    return getDatabase();
  }

  async get(id: string): Promise<StoreValue<K> | undefined> {
    try {
      return await (await this.open()).get(this.storeName, id);
    } catch (error) {
      throw toAppError(error, 'db_operation_failed');
    }
  }

  async getAll(): Promise<StoreValue<K>[]> {
    try {
      return await (await this.open()).getAll(this.storeName);
    } catch (error) {
      throw toAppError(error, 'db_operation_failed');
    }
  }

  async put(value: StoreValue<K>): Promise<string> {
    try {
      const key = await (await this.open()).put(this.storeName, value);
      return String(key);
    } catch (error) {
      throw toAppError(error, 'db_operation_failed');
    }
  }

  async putMany(values: readonly StoreValue<K>[]): Promise<void> {
    if (values.length === 0) return;
    try {
      const db = await this.open();
      const tx = db.transaction(this.storeName, 'readwrite');
      await Promise.all([...values].map((value) => tx.store.put(value)));
      await tx.done;
    } catch (error) {
      throw toAppError(error, 'db_operation_failed');
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await (await this.open()).delete(this.storeName, id);
    } catch (error) {
      throw toAppError(error, 'db_operation_failed');
    }
  }

  async deleteMany(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const db = await this.open();
      const tx = db.transaction(this.storeName, 'readwrite');
      await Promise.all([...ids].map((id) => tx.store.delete(id)));
      await tx.done;
    } catch (error) {
      throw toAppError(error, 'db_operation_failed');
    }
  }

  async clear(): Promise<void> {
    try {
      await (await this.open()).clear(this.storeName);
    } catch (error) {
      throw toAppError(error, 'db_operation_failed');
    }
  }

  async count(): Promise<number> {
    try {
      return await (await this.open()).count(this.storeName);
    } catch (error) {
      throw toAppError(error, 'db_operation_failed');
    }
  }

  async has(id: string): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }

  /**
   * Index queries are declared in schema.ts and created during the DB upgrade.
   * The index name is validated at runtime by IndexedDB itself; the cast keeps
   * one generic method instead of twenty typed duplicates.
   */
  async queryByIndex(index: string, query?: IndexQuery, count?: number): Promise<StoreValue<K>[]> {
    try {
      const db = (await this.open()) as IDBPDatabase<unknown>;
      const range = toKeyRange(query);
      const values =
        count === undefined
          ? await db.getAllFromIndex(this.storeName, index, range)
          : await db.getAllFromIndex(this.storeName, index, range, count);
      return values as StoreValue<K>[];
    } catch (error) {
      logger.warn('Index query failed', { store: this.storeName, index });
      throw toAppError(error, 'db_operation_failed');
    }
  }

  async countByIndex(index: string, query?: IndexQuery): Promise<number> {
    try {
      const db = (await this.open()) as IDBPDatabase<unknown>;
      return await db.countFromIndex(this.storeName, index, toKeyRange(query));
    } catch (error) {
      throw toAppError(error, 'db_operation_failed');
    }
  }
}

/** `null`/`undefined` means "no filter" (whole index). */
function toKeyRange(query: IndexQuery | undefined): IDBKeyRange | undefined {
  if (query === undefined || query === null) return undefined;
  if (query instanceof IDBKeyRange) return query;
  return IDBKeyRange.only(query);
}

export function createRepository<K extends StoreName>(storeName: K): Repository<K> {
  return new Repository(storeName);
}
