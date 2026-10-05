import { QUEUE_DEFAULTS } from '../config/appConfig';
import { appEvents } from '../core/events/eventBus';
import { AppError, toAppError } from '../core/errors/appError';
import { logger } from '../core/logging/logger';
import { newId } from '../core/utils/id';
import { jobsRepo } from '../db/repositories';
import type { JobPayload, JobRecord, JobResult } from '../db/entities';
import { activeStateFor, canTransition, type JobState, type JobType } from '../domain/jobStates';
import { createProgress, type ErrorState, type ProgressState } from '../domain/types';
import { settingsService } from '../services/settingsService';

export type AbortReason = 'pause' | 'cancel' | 'timeout';

export interface JobContext {
  readonly job: JobRecord;
  readonly payload: JobPayload;
  readonly signal: AbortSignal;
  /** Report progress; persisted at most every `progressFlushMs`. */
  progress(processed: number, total: number): void;
  /** Move a multi-stage job between active states (analyzing → translating). */
  transition(state: JobState): void;
  log(message: string, context?: Record<string, unknown>): void;
}

export type JobHandler = (context: JobContext) => Promise<JobResult | void>;

export interface EnqueueInput {
  readonly type: JobType;
  readonly label: string;
  readonly projectId?: string | null;
  readonly documentId?: string | null;
  readonly payload?: JobPayload;
  readonly priority?: number;
  readonly maxAttempts?: number;
}

export interface JobFilter {
  readonly projectId?: string;
  readonly states?: readonly JobState[];
}

interface RunningJob {
  readonly controller: AbortController;
  record: JobRecord;
}

const ACTIVE_STATES: readonly JobState[] = ['analyzing', 'translating', 'exporting'];

/**
 * Persistent job queue.
 *
 * Design rules:
 * - state transitions are validated (no illegal jumps from UI actions),
 * - every transition is written to IndexedDB before it is announced,
 * - jobs interrupted by a refresh are recovered to `queued`, never lost,
 * - a missing handler fails loudly instead of silently pretending success.
 */
class JobQueue {
  private readonly handlers = new Map<JobType, JobHandler>();
  private readonly running = new Map<string, RunningJob>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Why a running job is being paused (e.g. "Provider quota exhausted"). */
  private readonly pauseReasons = new Map<string, ErrorState>();
  private initialized = false;
  private initPromise: Promise<{ recovered: number }> | null = null;
  private scheduling = false;
  private recoveredCount = 0;

  registerHandler(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler);
    logger.info('Job handler registered', { type });
  }

  hasHandler(type: JobType): boolean {
    return this.handlers.has(type);
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /** Recover interrupted jobs, then start scheduling. Idempotent. */
  init(): Promise<{ recovered: number }> {
    if (!this.initPromise) {
      this.initPromise = this.initialize().catch((error: unknown) => {
        this.initPromise = null;
        throw toAppError(error, 'db_operation_failed');
      });
    }
    return this.initPromise;
  }

  private async initialize(): Promise<{ recovered: number }> {
    const jobs = await jobsRepo.getAll();
    let recovered = 0;

    for (const job of jobs) {
      if (!ACTIVE_STATES.includes(job.state)) continue;
      const next: JobRecord = {
        ...job,
        state: 'queued',
        startedAt: null,
        interruptions: job.interruptions + 1,
        updatedAt: Date.now(),
      };
      await jobsRepo.put(next);
      recovered += 1;
      appEvents.emit('jobs:changed', { jobId: next.id, projectId: next.projectId ?? undefined });
    }

    this.initialized = true;
    this.recoveredCount = recovered;
    if (recovered > 0) {
      logger.info('Recovered interrupted jobs', { count: recovered });
    }
    void this.schedule();
    return { recovered };
  }

  get recovered(): number {
    return this.recoveredCount;
  }

  async enqueue(input: EnqueueInput): Promise<JobRecord> {
    const timestamp = Date.now();
    const job: JobRecord = {
      id: newId('job'),
      type: input.type,
      state: 'queued',
      projectId: input.projectId ?? null,
      documentId: input.documentId ?? null,
      label: input.label,
      payload: input.payload ?? {},
      progress: createProgress(0, 0),
      attempts: 0,
      maxAttempts: input.maxAttempts ?? settingsService.value('jobMaxAttempts') ?? QUEUE_DEFAULTS.maxAttempts,
      priority: input.priority ?? 0,
      queuedAt: timestamp,
      startedAt: null,
      finishedAt: null,
      updatedAt: timestamp,
      lastError: null,
      interruptions: 0,
      result: null,
    };

    await jobsRepo.put(job);
    logger.info('Job enqueued', { jobId: job.id, type: job.type, label: job.label });
    appEvents.emit('jobs:changed', { jobId: job.id, projectId: job.projectId ?? undefined });
    void this.schedule();
    return job;
  }

  async get(id: string): Promise<JobRecord | undefined> {
    return jobsRepo.get(id);
  }

  async list(filter: JobFilter = {}): Promise<JobRecord[]> {
    let jobs = await jobsRepo.getAll();
    if (filter.projectId) jobs = jobs.filter((job) => job.projectId === filter.projectId);
    if (filter.states) jobs = jobs.filter((job) => filter.states?.includes(job.state));
    return jobs.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.queuedAt - a.queuedAt;
    });
  }

  async listRecent(limit = 50): Promise<JobRecord[]> {
    const jobs = await this.list();
    return jobs.slice(0, limit);
  }

  /**
   * Pauses a job. `reason` (optional) is persisted as `lastError` so the UI
   * can explain WHY the job paused - e.g. "Provider quota exhausted" after
   * every shared key hit the account quota.
   */
  async pause(id: string, reason?: ErrorState): Promise<JobRecord | undefined> {
    const active = this.running.get(id);
    if (active) {
      if (reason) this.pauseReasons.set(id, reason);
      active.controller.abort('pause');
      return active.record;
    }
    this.clearRetryTimer(id);
    const job = await jobsRepo.get(id);
    if (!job) return undefined;
    if (job.state === 'queued' || job.state === 'retrying') {
      return this.transition(job, 'paused', reason ? { lastError: reason } : {});
    }
    return job;
  }

  async resume(id: string): Promise<JobRecord | undefined> {
    const job = await jobsRepo.get(id);
    if (!job) return undefined;
    if (job.state !== 'paused') return job;
    const next = await this.transition(job, 'queued');
    void this.schedule();
    return next;
  }

  async cancel(id: string): Promise<JobRecord | undefined> {
    this.clearRetryTimer(id);
    const active = this.running.get(id);
    if (active) {
      active.controller.abort('cancel');
      return active.record;
    }
    const job = await jobsRepo.get(id);
    if (!job) return undefined;
    return this.transition(job, 'cancelled', { finishedAt: Date.now() });
  }

  /** Manual retry of a failed/cancelled job: clears the error and re-queues. */
  async retry(id: string): Promise<JobRecord | undefined> {
    this.clearRetryTimer(id);
    const job = await jobsRepo.get(id);
    if (!job) return undefined;
    if (job.state !== 'failed' && job.state !== 'cancelled' && job.state !== 'retrying') return job;
    const next = await this.transition(job, 'queued', {
      attempts: 0,
      lastError: null,
      finishedAt: null,
      startedAt: null,
      progress: createProgress(0, job.progress.total),
    });
    void this.schedule();
    return next;
  }

  async remove(id: string): Promise<void> {
    this.clearRetryTimer(id);
    this.clearFlushTimer(id);
    this.running.get(id)?.controller.abort('cancel');
    this.running.delete(id);
    await jobsRepo.delete(id);
    appEvents.emit('jobs:changed', { jobId: id });
  }

  // ---------------------------------------------------------------- internals

  private async schedule(): Promise<void> {
    if (!this.initialized || this.scheduling) return;
    this.scheduling = true;
    try {
      const concurrency = Math.max(1, settingsService.value('queueConcurrency') || QUEUE_DEFAULTS.concurrency);
      while (this.running.size < concurrency) {
        const candidate = await this.nextQueuedJob();
        if (!candidate) break;

        if (!this.handlers.has(candidate.type)) {
          await this.fail(
            candidate,
            new AppError(`No handler registered for job type "${candidate.type}"`, {
              code: 'handler_missing',
              retryable: false,
            }),
          );
          continue;
        }
        void this.run(candidate);
      }
    } catch (error) {
      logger.errorWith(error, 'Job scheduling failed');
    } finally {
      this.scheduling = false;
    }
  }

  private async nextQueuedJob(): Promise<JobRecord | null> {
    const queued = (await jobsRepo.queryByIndex('by_state', 'queued')) ?? [];
    const available = queued.filter((job) => !this.running.has(job.id));
    if (available.length === 0) return null;
    available.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.queuedAt - b.queuedAt;
    });
    return available[0] ?? null;
  }

  private async run(job: JobRecord): Promise<void> {
    const controller = new AbortController();
    const entry: RunningJob = { controller, record: job };
    this.running.set(job.id, entry);

    let current: JobRecord;
    try {
      current = await this.transition(job, activeStateFor(job.type), {
        startedAt: job.startedAt ?? Date.now(),
        attempts: job.attempts + 1,
        lastError: null,
      });
      entry.record = current;
    } catch (error) {
      this.running.delete(job.id);
      logger.errorWith(error, 'Job could not start', { jobId: job.id });
      return;
    }

    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.running.delete(job.id);
      await this.fail(
        current,
        new AppError(`No handler registered for "${job.type}"`, { code: 'handler_missing' }),
      );
      return;
    }

    // Analysis jobs may request a longer window via payload (large documents
    // legitimately take minutes); everything else uses the default timeout.
    const override = current.payload['jobTimeoutMs'];
    const timeoutMs = typeof override === 'number' && override > 0 ? override : QUEUE_DEFAULTS.jobTimeoutMs;
    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);

    const context: JobContext = {
      job: current,
      payload: current.payload,
      signal: controller.signal,
      progress: (processed, total) => {
        this.reportProgress(job.id, createProgress(processed, total));
      },
      transition: (state) => {
        const active = this.running.get(job.id);
        if (!active) return;
        if (!canTransition(active.record.state, state)) {
          logger.warn('Ignoring invalid job transition', {
            jobId: job.id,
            from: active.record.state,
            to: state,
          });
          return;
        }
        void this.transition(active.record, state).then((next) => {
          const still = this.running.get(job.id);
          if (still) still.record = next;
        });
      },
      log: (message, logContext) => logger.info(message, { jobId: job.id, ...logContext }),
    };

    try {
      const result = await handler(context);
      clearTimeout(timeout);

      const abortReason = readAbortReason(controller.signal);
      if (abortReason) {
        await this.handleAbort(job.id, abortReason);
        return;
      }

      const final = await this.transition(
        this.currentRecord(job.id, current),
        'completed',
        { finishedAt: Date.now(), progress: this.finalProgress(job.id), result: result ?? null },
      );
      logger.info('Job completed', { jobId: final.id, type: final.type });
    } catch (error) {
      clearTimeout(timeout);
      const abortReason = readAbortReason(controller.signal);
      if (abortReason) {
        await this.handleAbort(job.id, abortReason);
        return;
      }
      await this.handleFailure(job.id, error);
    } finally {
      this.clearFlushTimer(job.id);
      this.running.delete(job.id);
      appEvents.emit('jobs:changed', { jobId: job.id, projectId: job.projectId ?? undefined });
      void this.schedule();
    }
  }

  private currentRecord(jobId: string, fallback: JobRecord): JobRecord {
    return this.running.get(jobId)?.record ?? fallback;
  }

  private finalProgress(jobId: string): ProgressState {
    return this.running.get(jobId)?.record.progress ?? createProgress(0, 0);
  }

  private async handleAbort(jobId: string, reason: AbortReason): Promise<void> {
    const job = (await jobsRepo.get(jobId)) ?? this.running.get(jobId)?.record;
    const pauseReason = this.pauseReasons.get(jobId);
    this.pauseReasons.delete(jobId);
    if (!job) return;
    if (reason === 'pause') {
      const next = await this.transition(job, 'paused', pauseReason ? { lastError: pauseReason } : {});
      logger.info('Job paused', { jobId, code: pauseReason?.code ?? 'user' });
      appEvents.emit('jobs:changed', { jobId, projectId: next.projectId ?? undefined });
      return;
    }
    if (reason === 'cancel') {
      await this.transition(job, 'cancelled', { finishedAt: Date.now() });
      return;
    }
    // timeout: fall through to retryable failure handling
    await this.handleFailure(jobId, new AppError('Job timed out', { code: 'job_timeout', retryable: true }));
  }

  private async handleFailure(jobId: string, error: unknown): Promise<void> {
    const job = (await jobsRepo.get(jobId)) ?? this.running.get(jobId)?.record;
    if (!job) return;
    const appError = toAppError(error, 'unknown');
    await this.fail(job, appError);
  }

  private async fail(job: JobRecord, error: AppError): Promise<void> {
    const errorState: ErrorState = {
      code: error.code,
      message: error.message,
      at: Date.now(),
      retryable: error.retryable,
    };

    const canRetry = error.retryable && job.attempts < job.maxAttempts;
    if (canRetry) {
      await this.transition(job, 'retrying', { lastError: errorState });
      const delay = backoffDelay(job.attempts);
      logger.warn('Job failed; scheduling retry', {
        jobId: job.id,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        delayMs: delay,
        code: error.code,
      });
      const timer = setTimeout(() => {
        this.retryTimers.delete(job.id);
        void (async () => {
          const latest = await jobsRepo.get(job.id);
          if (!latest || latest.state !== 'retrying') return;
          await this.transition(latest, 'queued');
          void this.schedule();
        })();
      }, delay);
      this.retryTimers.set(job.id, timer);
      appEvents.emit('jobs:changed', { jobId: job.id, projectId: job.projectId ?? undefined });
      return;
    }

    const failed = await this.transition(job, 'failed', { lastError: errorState, finishedAt: Date.now() });
    logger.error('Job failed', {
      jobId: failed.id,
      code: error.code,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      message: error.message,
    });
    appEvents.emit('jobs:changed', { jobId: failed.id, projectId: failed.projectId ?? undefined });
  }

  private reportProgress(jobId: string, progress: ProgressState): void {
    const active = this.running.get(jobId);
    if (!active) return;
    active.record = { ...active.record, progress };
    appEvents.emit('jobs:changed', { jobId, projectId: active.record.projectId ?? undefined });

    if (this.flushTimers.has(jobId)) return;
    const timer = setTimeout(() => {
      this.flushTimers.delete(jobId);
      const current = this.running.get(jobId);
      if (!current) return;
      void jobsRepo.put(current.record).catch((error: unknown) => {
        logger.warn('Progress flush failed', { jobId, error: String(error) });
      });
    }, QUEUE_DEFAULTS.progressFlushMs);
    this.flushTimers.set(jobId, timer);
  }

  private async transition(
    job: JobRecord,
    next: JobState,
    patch: Partial<JobRecord> = {},
  ): Promise<JobRecord> {
    if (!canTransition(job.state, next)) {
      logger.warn('Rejected invalid job transition', { jobId: job.id, from: job.state, to: next });
      throw new AppError(`Invalid job transition ${job.state} → ${next}`, {
        code: 'invalid_transition',
        retryable: false,
      });
    }
    const updated: JobRecord = {
      ...job,
      ...patch,
      state: next,
      updatedAt: Date.now(),
    };
    await jobsRepo.put(updated);
    const active = this.running.get(job.id);
    if (active && (ACTIVE_STATES.includes(next) || !ACTIVE_STATES.includes(job.state))) {
      active.record = updated;
    }
    appEvents.emit('jobs:changed', { jobId: updated.id, projectId: updated.projectId ?? undefined });
    return updated;
  }

  private clearRetryTimer(jobId: string): void {
    const timer = this.retryTimers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(jobId);
    }
  }

  private clearFlushTimer(jobId: string): void {
    const timer = this.flushTimers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(jobId);
    }
  }
}

function readAbortReason(signal: AbortSignal): AbortReason | null {
  if (!signal.aborted) return null;
  const reason: unknown = signal.reason;
  if (reason === 'pause' || reason === 'cancel' || reason === 'timeout') return reason;
  return 'cancel';
}

function backoffDelay(attempt: number): number {
  const exponential = QUEUE_DEFAULTS.baseBackoffMs * 2 ** Math.max(0, attempt);
  return Math.min(exponential, QUEUE_DEFAULTS.maxBackoffMs);
}

export const jobQueue = new JobQueue();
