/**
 * Job lifecycle.
 *
 * The state machine is deliberately explicit: every transition is validated so
 * a UI action can never corrupt a job (for example resuming a completed job).
 */

export const JOB_STATES = [
  'queued',
  'analyzing',
  'translating',
  'paused',
  'retrying',
  'exporting',
  'completed',
  'failed',
  'cancelled',
] as const;

export type JobState = (typeof JOB_STATES)[number];

const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ['analyzing', 'translating', 'exporting', 'paused', 'retrying', 'failed', 'cancelled'],
  // Analysis-only jobs (inspect/extract/sync) finish directly from `analyzing`;
  // document translation continues to `translating` or `exporting`.
  analyzing: ['translating', 'exporting', 'completed', 'paused', 'retrying', 'failed', 'cancelled'],
  translating: ['paused', 'retrying', 'exporting', 'completed', 'failed', 'cancelled'],
  paused: ['queued', 'cancelled'],
  retrying: ['queued', 'paused', 'failed', 'cancelled'],
  exporting: ['completed', 'failed', 'retrying', 'paused', 'cancelled'],
  completed: [],
  failed: ['retrying', 'queued', 'cancelled'],
  cancelled: ['queued'],
};

export function canTransition(from: JobState, to: JobState): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function nextStates(from: JobState): readonly JobState[] {
  return TRANSITIONS[from];
}

export function isTerminal(state: JobState): boolean {
  return state === 'completed' || state === 'cancelled';
}

export function isActive(state: JobState): boolean {
  return state === 'analyzing' || state === 'translating' || state === 'exporting';
}

export function isPaused(state: JobState): boolean {
  return state === 'paused';
}

export function isRetryable(state: JobState): boolean {
  return state === 'failed' || state === 'retrying';
}

/** States that must be recovered (reset to queued) after a browser refresh. */
export function needsRecovery(state: JobState): boolean {
  return isActive(state);
}

/**
 * Job kinds handled by the queue. Phase 1 ships `inspect_document` with a real
 * Web Worker implementation; the remaining kinds are wired to handlers in later
 * phases and fail loudly (never silently) if enqueued before then.
 */
export const JOB_TYPES = [
  'inspect_document',
  'extract_text',
  'translate_document',
  'export_document',
  'sync_push',
] as const;

export type JobType = (typeof JOB_TYPES)[number];

/** The job state a job enters when it starts running. */
export function activeStateFor(type: JobType): JobState {
  switch (type) {
    case 'inspect_document':
    case 'extract_text':
      return 'analyzing';
    case 'translate_document':
      return 'translating';
    case 'export_document':
      return 'exporting';
    case 'sync_push':
      return 'analyzing';
  }
}
