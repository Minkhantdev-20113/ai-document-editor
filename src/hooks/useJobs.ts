import { useCallback, useEffect, useMemo, useRef } from 'react';
import { appEvents } from '../core/events/eventBus';
import { jobQueue } from '../jobs/jobQueue';
import type { JobRecord } from '../db/entities';
import type { JobFilter } from '../jobs/jobQueue';
import { useCollection } from './useAsyncData';
import type { AsyncResult } from './useAsyncData';

const JOB_EVENTS = ['jobs:changed'] as const;

/** Reactive job list backed by the persisted queue. */
export function useJobs(filter: JobFilter = {}): AsyncResult<JobRecord[]> {
  const filterKey = `${filter.projectId ?? ''}|${(filter.states ?? []).join(',')}`;
  const stableFilter = useMemo(
    () => filter,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey],
  );

  return useCollection(
    () => jobQueue.list(stableFilter),
    [filterKey],
    JOB_EVENTS,
  );
}

/** Current queue activity: running count + recovered-after-reload notice. */
export function useQueueStatus(): { running: number; initialized: boolean; recovered: number } {
  const { data: jobs } = useJobs();
  const running = (jobs ?? []).filter((job) => job.state === 'analyzing' || job.state === 'translating' || job.state === 'exporting').length;
  return { running, initialized: jobQueue.isInitialized(), recovered: jobQueue.recovered };
}

/**
 * Runs `effect` when the tab becomes visible again - used to refresh state
 * after the user returns from another application.
 */
export function useVisibilityRefresh(effect: () => void): void {
  const callback = useRef(effect);
  useEffect(() => {
    callback.current = effect;
  });

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') callback.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
}

/** Debounced callback with proper cleanup (used by autosaving editors). */
export function useDebouncedCallback<A extends unknown[]>(
  callback: (...args: A) => void,
  delayMs: number,
): (...args: A) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  });

  const debounced = useCallback(
    (...args: A) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => callbackRef.current(...args), delayMs);
    },
    [delayMs],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return debounced;
}

/** Subscribe to a single app event (used for narrow invalidations). */
export function useAppEvent(event: Parameters<typeof appEvents.on>[0], handler: () => void): void {
  const stable = useRef(handler);
  useEffect(() => {
    stable.current = handler;
  });
  useEffect(() => appEvents.on(event, () => stable.current()), [event]);
}
