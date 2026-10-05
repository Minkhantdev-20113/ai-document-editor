/**
 * Minimal typed pub/sub used to keep React views in sync with services.
 * Services own the data; views refetch on change events. No global mutable UI
 * store is required, which keeps persistence the single source of truth.
 */
import type { AnalysisStage, AnalysisTask } from '../../domain/analysis/ir';
import type { ProviderId } from '../../providers/types';

export interface AppEventMap {
  'projects:changed': { projectId?: string };
  'documents:changed': { documentId?: string; projectId?: string };
  'pages:changed': { documentId?: string };
  /** Live analysis progress (stage/task/counters) for the analysis views. */
  'analysis:progress': {
    readonly documentId: string;
    readonly projectId: string;
    readonly stage: AnalysisStage;
    readonly task: AnalysisTask;
    /** 1-based page currently being processed, 0 when not page-specific. */
    readonly page: number;
    readonly pageCount: number;
    readonly analyzed: number;
    readonly blocks: number;
    readonly failed: number;
  };
  'units:changed': { documentId?: string };
  'glossary:changed': { projectId?: string };
  /**
   * Live translation progress (Phase 4): page/unit x-y plus provider, model
   * and the masked key id for the workflow progress display. Status itself
   * comes from the job record (`jobs:changed`).
   */
  'translation:progress': {
    readonly documentId: string;
    readonly projectId: string | null;
    readonly processed: number;
    readonly total: number;
    readonly batchIndex: number;
    readonly batchCount: number;
    readonly providerId: ProviderId | null;
    readonly model: string | null;
    /** Vault key id for masking - never the key itself. */
    readonly keyId: string | null;
    readonly completedPages: number;
    readonly totalPages: number;
  };
  'editor:changed': { editorDocumentId?: string };
  'jobs:changed': { jobId?: string; projectId?: string };
  'settings:changed': { keys: string[] };
  'providers:changed': { providerId?: string };
  'apiKeys:changed': Record<string, never>;
  'usage:changed': Record<string, never>;
  'sync:changed': Record<string, never>;
  'errors:changed': Record<string, never>;
  'vault:changed': Record<string, never>;
}

export type AppEventName = keyof AppEventMap;

type Handler<K extends AppEventName> = (payload: AppEventMap[K]) => void;

export interface EventBus {
  on<K extends AppEventName>(event: K, handler: Handler<K>): () => void;
  once<K extends AppEventName>(event: K, handler: Handler<K>): () => void;
  off<K extends AppEventName>(event: K, handler: Handler<K>): void;
  emit<K extends AppEventName>(event: K, payload: AppEventMap[K]): void;
}

export function createEventBus(): EventBus {
  const handlers = new Map<AppEventName, Set<Handler<AppEventName>>>();

  function on<K extends AppEventName>(event: K, handler: Handler<K>): () => void {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(handler as Handler<AppEventName>);
    return () => off(event, handler);
  }

  function off<K extends AppEventName>(event: K, handler: Handler<K>): void {
    handlers.get(event)?.delete(handler as Handler<AppEventName>);
  }

  function once<K extends AppEventName>(event: K, handler: Handler<K>): () => void {
    const unsubscribe = on(event, (payload) => {
      unsubscribe();
      handler(payload);
    });
    return unsubscribe;
  }

  function emit<K extends AppEventName>(event: K, payload: AppEventMap[K]): void {
    const set = handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as Handler<K>)(payload);
      } catch (error) {
        console.error(`[events] handler for "${event}" threw`, error);
      }
    }
  }

  return { on, once, off, emit };
}

export const appEvents = createEventBus();
