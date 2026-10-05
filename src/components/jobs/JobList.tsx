import { useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { useToast } from '../../state/ToastProvider';
import { jobQueue } from '../../jobs/jobQueue';
import type { JobRecord } from '../../db/entities';
import { toAppError } from '../../core/errors/appError';
import { formatDateTime, formatRelativeTime } from '../../core/utils/time';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { ProgressBar } from '../ui/Progress';
import { StatusBadge } from '../ui/StatusBadge';
import { Icon } from '../ui/Icon';

export interface JobListProps {
  readonly jobs: readonly JobRecord[];
  readonly emptyTitle?: string;
  readonly emptyHint?: string;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/**
 * Job queue view with state-machine driven controls.
 * Buttons only appear for transitions the queue actually accepts, so the UI can
 * never request an illegal state change.
 */
export function JobList({ jobs, emptyTitle, emptyHint }: JobListProps) {
  const t = useT();
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (jobs.length === 0) {
    return <EmptyState icon="activity" title={emptyTitle ?? t('job.empty')} body={emptyHint ?? t('job.emptyHint')} />;
  }

  async function act(jobId: string, action: 'pause' | 'resume' | 'cancel' | 'retry') {
    setBusyId(jobId);
    try {
      if (action === 'pause') await jobQueue.pause(jobId);
      if (action === 'resume') await jobQueue.resume(jobId);
      if (action === 'cancel') await jobQueue.cancel(jobId);
      if (action === 'retry') await jobQueue.retry(jobId);
    } catch (error) {
      const appError = toAppError(error);
      toast.error(t('toast.error'), t(`errors.${appError.code}`));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t('common.name')}</th>
            <th>{t('job.type')}</th>
            <th>{t('job.state')}</th>
            <th>{t('common.progress')}</th>
            <th className="num">{t('job.attempts')}</th>
            <th>{t('job.queuedAt')}</th>
            <th aria-label={t('common.actions')} />
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const running = !TERMINAL.has(job.state) && job.state !== 'paused';
            return (
              <tr key={job.id}>
                <td>
                  <div className="stack stack-1">
                    <span className="truncate">{job.label}</span>
                    {job.lastError && (
                      <span className="text-xs" style={{ color: 'var(--color-danger)' }}>
                        {job.lastError.message}
                      </span>
                    )}
                  </div>
                </td>
                <td className="mono text-xs">{job.type}</td>
                <td>
                  <StatusBadge state={job.state} />
                </td>
                <td style={{ minWidth: 140 }}>
                  <div className="stack stack-1">
                    <ProgressBar
                      value={job.progress.total > 0 ? job.progress.percent : undefined}
                      label={`${job.progress.processed} ${t('common.of')} ${job.progress.total}`}
                    />
                    <span className="text-xs subtle">
                      {job.progress.total > 0
                        ? `${job.progress.processed} ${t('common.of')} ${job.progress.total}`
                        : '—'}
                    </span>
                  </div>
                </td>
                <td className="num">
                  {job.attempts}
                  <span className="subtle"> / {job.maxAttempts}</span>
                </td>
                <td className="text-xs nowrap" title={formatDateTime(job.queuedAt)}>
                  {formatRelativeTime(job.queuedAt)}
                </td>
                <td>
                  <div className="row row-2" style={{ justifyContent: 'flex-end' }}>
                    {job.state === 'paused' && (
                      <Button
                        size="sm"
                        icon={<Icon name="play" size={13} />}
                        loading={busyId === job.id}
                        onClick={() => void act(job.id, 'resume')}
                      >
                        {t('job.resume')}
                      </Button>
                    )}
                    {running && job.state !== 'queued' && (
                      <Button
                        size="sm"
                        icon={<Icon name="pause" size={13} />}
                        loading={busyId === job.id}
                        onClick={() => void act(job.id, 'pause')}
                      >
                        {t('job.pause')}
                      </Button>
                    )}
                    {(job.state === 'failed' || job.state === 'cancelled') && (
                      <Button
                        size="sm"
                        icon={<Icon name="refresh" size={13} />}
                        loading={busyId === job.id}
                        onClick={() => void act(job.id, 'retry')}
                      >
                        {t('common.retry')}
                      </Button>
                    )}
                    {!TERMINAL.has(job.state) && (
                      <Button
                        size="sm"
                        variant="danger"
                        loading={busyId === job.id}
                        onClick={() => void act(job.id, 'cancel')}
                      >
                        {t('job.cancel')}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
