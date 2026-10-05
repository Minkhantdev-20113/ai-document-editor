import { useState } from 'react';
import { ROUTES, type ExportFormat } from '../../config/appConfig';
import { downloadBytes, mimeTypeForFormat } from '../../core/utils/download';
import { formatBytes } from '../../core/utils/format';
import { formatRelativeTime } from '../../core/utils/time';
import type { ExportArtifact, JobRecord } from '../../db/entities';
import {
  hasBlockingFindings,
  type ExportFinding,
} from '../../domain/export/validateExport';
import { useT } from '../../i18n/I18nProvider';
import { Button, ButtonLink } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import { Notice } from '../ui/Notice';

/** Findings shown before the "+n more" line keeps the list readable. */
const MAX_VISIBLE_FINDINGS = 8;

export interface ExportResultListProps {
  readonly jobs: readonly JobRecord[];
  readonly artifacts: readonly ExportArtifact[];
}

/**
 * Finished exports: file, size and the pre-download validation report.
 *
 * Error findings block the download until the user explicitly accepts them;
 * warnings are informational. Nothing is ever downloaded automatically, and
 * every finding with a page links back to the workspace so the affected page
 * can be inspected - the spec forbids silently shipping a broken file.
 */
export function ExportResultList({ jobs, artifacts }: ExportResultListProps) {
  const t = useT();
  const [accepted, setAccepted] = useState<Readonly<Record<string, boolean>>>({});

  if (jobs.length === 0) {
    return (
      <EmptyState icon="file" title={t('exportCenter.empty')} body={t('exportCenter.emptyHint')} plain />
    );
  }

  function download(artifact: ExportArtifact): void {
    if (!artifact.bytes) return;
    downloadBytes(
      artifact.fileName,
      artifact.bytes,
      mimeTypeForFormat(artifact.format as ExportFormat),
    );
  }

  return (
    <div className="stack stack-6">
      {jobs.map((job) => {
        const artifact = artifacts.find((item) => item.jobId === job.id);
        const findings = artifact?.findings ?? [];
        const blocking = hasBlockingFindings(findings);
        const warningCount = findings.filter((item) => item.severity === 'warning').length;
        const errorCount = findings.length - warningCount;
        const acceptedForJob = accepted[job.id] === true;
        const failed = job.state === 'failed' || job.state === 'cancelled';

        return (
          <div key={job.id} className="stack stack-3">
            <div className="row row-2" style={{ justifyContent: 'space-between' }}>
              <div className="stack stack-1">
                <span className="truncate">{artifact?.fileName ?? job.label}</span>
                <span className="text-xs subtle">
                  {[
                    artifact?.format.toUpperCase(),
                    artifact?.bytes ? formatBytes(artifact.bytes.byteLength) : null,
                    artifact
                      ? t('exportCenter.pageCount', { count: artifact.pageCount })
                      : null,
                    formatRelativeTime(job.updatedAt),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              <div className="row row-2">
                {artifact?.state === 'ready' && artifact.bytes && (
                  <Button
                    size="sm"
                    variant={blocking && !acceptedForJob ? undefined : 'primary'}
                    icon={<Icon name="download" size={13} />}
                    disabled={blocking && !acceptedForJob}
                    onClick={() => download(artifact)}
                  >
                    {t('exportCenter.download')}
                  </Button>
                )}
                {artifact?.state === 'ready' && blocking && !acceptedForJob && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => setAccepted((value) => ({ ...value, [job.id]: true }))}
                  >
                    {t('exportCenter.downloadAnyway')}
                  </Button>
                )}
              </div>
            </div>

            {failed && artifact && artifact.state !== 'ready' && (
              <Notice tone="warning" icon="alertTriangle">
                {t('exportCenter.checkpointNote', {
                  rendered: artifact.renderedPages,
                  total: artifact.pageCount,
                })}
              </Notice>
            )}

            {job.state === 'completed' && !artifact && (
              <Notice tone="warning" icon="alertTriangle">
                {t('exportCenter.missingArtifact')}
              </Notice>
            )}

            {artifact?.state === 'ready' && blocking && !acceptedForJob && (
              <Notice tone="warning" icon="alertTriangle">
                {t('exportCenter.blocked', { errors: errorCount })}
              </Notice>
            )}

            {artifact?.state === 'ready' && !blocking && warningCount === 0 && (
              <p className="text-xs" style={{ color: 'var(--color-success)' }}>
                <Icon name="check" size={13} /> {t('exportCenter.valid')}
              </p>
            )}

            {artifact?.state === 'ready' && !blocking && warningCount > 0 && (
              <p className="text-xs subtle">
                {t('exportCenter.warningsOnly', { warnings: warningCount })}
              </p>
            )}

            {findings.length > 0 && (
              <FindingList findings={findings} projectId={artifact?.projectId ?? ''} />
            )}
          </div>
        );
      })}
    </div>
  );
}

interface FindingListProps {
  readonly findings: readonly ExportFinding[];
  readonly projectId: string;
}

function FindingList({ findings, projectId }: FindingListProps) {
  const t = useT();
  const visible = findings.slice(0, MAX_VISIBLE_FINDINGS);
  const hidden = findings.length - visible.length;

  return (
    <div className="stack stack-1">
      <span className="text-xs subtle">{t('exportCenter.findings')}</span>
      <ul className="stack stack-1" style={{ listStyle: 'none' }}>
        {visible.map((finding, index) => (
          <li key={`${finding.code}_${finding.pageIndex ?? -1}_${index}`} className="row row-2">
            <Icon
              name={finding.severity === 'error' ? 'alertTriangle' : 'alertCircle'}
              size={13}
            />
            <span className="text-xs">{t(`exportFindings.${finding.code}`)}</span>
            {finding.pageIndex !== undefined && projectId !== '' && (
              <ButtonLink
                to={ROUTES.workspaceEditor(projectId)}
                size="sm"
                variant="ghost"
                icon={<Icon name="externalLink" size={11} />}
              >
                {t('exportCenter.pageLabel', { page: finding.pageIndex + 1 })}
              </ButtonLink>
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <span className="text-xs subtle">{t('exportCenter.moreFindings', { count: hidden })}</span>
      )}
    </div>
  );
}
