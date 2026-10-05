import type { ExportFormat } from '../config/appConfig';
import type { JobState } from './jobStates';

/** Project status is the job state plus a `draft` state before any job exists. */
export type ProjectStatus = JobState | 'draft';

export type UnitStatus = 'pending' | 'in_progress' | 'translated' | 'reviewed' | 'failed';

export type ExportState =
  | 'not_started'
  | 'queued'
  | 'exporting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface FileMetadata {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified: number;
  /** SHA-256 of the payload when it was hashed during import. */
  readonly checksum?: string;
}

export interface ProgressState {
  readonly processed: number;
  readonly total: number;
  readonly percent: number;
}

export interface ErrorState {
  readonly code: string;
  readonly message: string;
  readonly at: number;
  readonly retryable: boolean;
}

export const EMPTY_PROGRESS: ProgressState = { processed: 0, total: 0, percent: 0 };

export function createProgress(processed: number, total: number): ProgressState {
  const safeTotal = Math.max(0, total);
  const safeProcessed = Math.min(Math.max(0, processed), safeTotal);
  const percent = safeTotal === 0 ? 0 : Math.round((safeProcessed / safeTotal) * 100);
  return { processed: safeProcessed, total: safeTotal, percent };
}

export type ExportRequest = {
  readonly projectId: string;
  readonly format: ExportFormat;
  readonly options: {
    readonly keepLayout: boolean;
    readonly includeSource: boolean;
  };
};
