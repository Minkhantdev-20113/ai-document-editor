import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createProgress, type ErrorState } from '../domain/types';
import { isActive } from '../domain/jobStates';
import type { JobRecord } from '../db/entities';
import { jobsRepo } from '../db/repositories';
import { jobQueue } from './jobQueue';

function makeJob(patch: Partial<JobRecord> = {}): JobRecord {
  const now = Date.now();
  return {
    id: 'job-1',
    type: 'inspect_document',
    state: 'queued',
    projectId: null,
    documentId: null,
    label: 'Inspect',
    payload: {},
    progress: createProgress(0, 0),
    attempts: 0,
    maxAttempts: 5,
    priority: 0,
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    lastError: null,
    interruptions: 0,
    result: null,
    ...patch,
  };
}

async function waitFor(
  id: string,
  predicate: (job: JobRecord) => boolean,
  timeoutMs = 4000,
): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: JobRecord | undefined;
  while (Date.now() < deadline) {
    last = await jobQueue.get(id);
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for job ${id}; last state: ${last?.state ?? 'missing'}`);
}

describe('jobQueue (persistent state machine)', () => {
  beforeAll(async () => {
    await jobsRepo.clear();
    // Simulates a job that was running when the browser refreshed.
    await jobsRepo.put(
      makeJob({ id: 'job-interrupted', type: 'translate_document', state: 'translating', startedAt: Date.now() }),
    );
    jobQueue.registerHandler('translate_document', async (context) => {
      context.progress(1, 1);
      return { inspectedPages: 1 };
    });
    jobQueue.registerHandler('inspect_document', async () => ({ pageCount: 3 }));
    jobQueue.registerHandler('extract_text', async () => ({ charCount: 42 }));
    // `export_document` is intentionally left without a handler.
    await jobQueue.init();
  });

  it('recovers interrupted jobs to the queue instead of losing them', async () => {
    expect(jobQueue.recovered).toBe(1);
    const recovered = await waitFor('job-interrupted', (job) => !isActive(job.state));
    expect(recovered.interruptions).toBe(1);
    expect(['queued', 'completed', 'cancelled', 'failed']).toContain(recovered.state);
  });

  it('runs an enqueued job through queued → active → completed', async () => {
    const job = await jobQueue.enqueue({ type: 'inspect_document', label: 'Inspect document' });
    expect(job.state).toBe('queued');

    const final = await waitFor(job.id, (record) => record.state === 'completed');
    expect(final.attempts).toBe(1);
    expect(final.startedAt).not.toBeNull();
    expect(final.finishedAt).not.toBeNull();
    expect(final.result).toMatchObject({ pageCount: 3 });
  });

  it('pauses and resumes a job through validated transitions', async () => {
    await jobsRepo.put(makeJob({ id: 'job-pause', type: 'extract_text', state: 'retrying', attempts: 1 }));

    const paused = await jobQueue.pause('job-pause');
    expect(paused?.state).toBe('paused');

    const resumed = await jobQueue.resume('job-pause');
    expect(resumed?.state).toBe('queued');

    const final = await waitFor('job-pause', (record) => record.state === 'completed');
    expect(final.state).toBe('completed');
  });

  it('cancels a job that has not started', async () => {
    await jobsRepo.put(makeJob({ id: 'job-cancel', type: 'extract_text', state: 'retrying', attempts: 1 }));
    const cancelled = await jobQueue.cancel('job-cancel');
    expect(cancelled?.state).toBe('cancelled');
    expect(cancelled?.finishedAt).not.toBeNull();
  });

  it('fails loudly when no handler is registered for a job type', async () => {
    const job = await jobQueue.enqueue({ type: 'export_document', label: 'Export without handler' });
    const final = await waitFor(job.id, (record) => record.state === 'failed');
    expect(final.lastError?.code).toBe('handler_missing');
    expect(final.lastError?.retryable).toBe(false);
  });

  it('re-queues a failed job through the queue API', async () => {
    const failed = await jobQueue.list({ states: ['failed'] });
    expect(failed.length).toBeGreaterThan(0);
    const target = failed[0];
    expect(target).toBeDefined();

    const requeued = await jobQueue.retry(target?.id ?? '');
    expect(requeued?.state).toBe('queued');
    expect(requeued?.lastError).toBeNull();
    expect(requeued?.attempts).toBe(0);
  });

  it('persists a pause reason as lastError on a queued job (Phase 3)', async () => {
    // `retrying` (like the pause test above) is a non-running job the scheduler
    // will not auto-dequeue mid-test; the pause path is identical to `queued`
    // (both go through the validated transition with the reason patch).
    await jobsRepo.put(makeJob({ id: 'job-pause-reason', type: 'extract_text', state: 'retrying', attempts: 1 }));
    const reason: ErrorState = {
      code: 'provider_quota_exceeded',
      message: 'Provider quota exhausted for gemini. Translation pauses safely until the quota resets.',
      at: Date.now(),
      retryable: false,
    };

    const paused = await jobQueue.pause('job-pause-reason', reason);
    expect(paused?.state).toBe('paused');
    // The reason is persisted, not just emitted: the job list renders
    // `lastError.message` so the user sees WHY the job is waiting.
    expect(paused?.lastError).toEqual(reason);

    const stored = await jobsRepo.get('job-pause-reason');
    expect(stored?.state).toBe('paused');
    expect(stored?.lastError?.code).toBe('provider_quota_exceeded');
    expect(stored?.finishedAt).toBeNull(); // paused is not terminal
  });

  it('a running handler can pause itself with an explanatory reason (Phase 3)', async () => {
    // Mirrors translate_document: the engine returns paused_quota and the
    // handler calls jobQueue.pause(id, reason) while the job is in flight.
    jobQueue.registerHandler('extract_text', async (context) => {
      await jobQueue.pause(context.job.id, {
        code: 'provider_quota_exceeded',
        message: 'Provider quota exhausted for gemini.',
        at: Date.now(),
        retryable: false,
      });
      return { abandoned: true };
    });

    const job = await jobQueue.enqueue({ type: 'extract_text', label: 'Self-pausing run' });
    const final = await waitFor(job.id, (record) => record.state === 'paused');

    expect(final.lastError?.code).toBe('provider_quota_exceeded');
    expect(final.lastError?.message).toContain('quota');
    expect(final.attempts).toBe(1);
    expect(final.finishedAt).toBeNull();
    // The handler's return value is discarded: an aborted run never "completes".
    expect(final.result).toBeNull();
  });
});
