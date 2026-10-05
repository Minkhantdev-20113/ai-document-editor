import { useCallback, useEffect, useRef, useState } from 'react';
import { appEvents, type AppEventName } from '../core/events/eventBus';
import { toAppError, type AppError } from '../core/errors/appError';

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: AppError | null;
}

interface LoadEntry<T> {
  /** Key of the load this entry belongs to (version + deps + enabled). */
  readonly key: string;
  readonly data: T | null;
  readonly error: AppError | null;
}

export interface AsyncResult<T> extends AsyncState<T> {
  reload: () => void;
}

/**
 * Runs an async loader with cancellation, error normalization and manual
 * reload. Used by every read path so loading/error handling stays uniform.
 *
 * Loading is derived from the key of the last settled load instead of being
 * written into state from an effect: a new key (mount, dependency change or
 * `reload()`) means "loading", a matching key means "settled". This keeps
 * effects free of synchronous state updates while preserving the previous
 * data during a refresh.
 */
export function useAsyncData<T>(
  loader: () => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean } = {},
): AsyncResult<T> {
  const enabled = options.enabled ?? true;
  const [version, setVersion] = useState(0);
  const [entry, setEntry] = useState<LoadEntry<T> | null>(null);
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });

  const reload = useCallback(() => setVersion((value) => value + 1), []);

  const key = `${version}:${enabled ? '1' : '0'}:${JSON.stringify(deps)}`;

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const loadKey = key;
    loaderRef
      .current()
      .then((data) => {
        if (!cancelled) setEntry({ key: loadKey, data, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setEntry({ key: loadKey, data: null, error: toAppError(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, key]);

  if (!enabled) return { data: null, loading: false, error: null, reload };
  const settled = entry !== null && entry.key === key;
  return {
    data: entry?.data ?? null,
    loading: !settled,
    error: settled ? entry.error : null,
    reload,
  };
}

/**
 * Like `useAsyncData`, but re-runs whenever one of the given app events fires.
 * This is how views stay in sync with services without a global UI store.
 */
export function useCollection<T>(
  loader: () => Promise<T>,
  deps: readonly unknown[],
  events: readonly AppEventName[],
): AsyncResult<T> {
  const result = useAsyncData(loader, deps);
  const eventsKey = events.join('|');
  const reload = result.reload;

  useEffect(() => {
    const names = eventsKey.split('|').filter(Boolean) as AppEventName[];
    const unsubscribers = names.map((name) => appEvents.on(name, () => reload()));
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [eventsKey, reload]);

  return result;
}
