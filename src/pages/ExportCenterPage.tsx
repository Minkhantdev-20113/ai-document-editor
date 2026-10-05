import { ROUTES, SUPPORTED_EXPORT_FORMATS } from '../config/appConfig';
import { formatRelativeTime } from '../core/utils/time';
import type { ExportArtifact, Project } from '../db/entities';
import { useCollection } from '../hooks/useAsyncData';
import { useDocumentTitle } from '../hooks/useSystem';
import { useJobs } from '../hooks/useJobs';
import { useT } from '../i18n/I18nProvider';
import { exportService } from '../services/exportService';
import { projectService } from '../services/projectService';
import { ExportResultList } from '../components/export/ExportResultList';
import { ExportStartForm } from '../components/export/ExportStartForm';
import { JobList } from '../components/jobs/JobList';
import { ButtonLink } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/Icon';
import { Notice } from '../components/ui/Notice';
import { PageHeader } from '../components/ui/PageHeader';
import { ExportStateBadge } from '../components/ui/StatusBadge';

const FINISHED_STATES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Export Center (Phase 5): queue a render, watch its per-page progress and
 * download the validated file. Everything heavy (layout, shaping, painting,
 * PDF generation, container builds) happens in the export worker; this page
 * only enqueues jobs, shows progress and presents validation findings before
 * any download is offered.
 */
export function ExportCenterPage() {
  const t = useT();
  useDocumentTitle(t('exportCenter.title'));

  const { data: projects } = useCollection<Project[]>(() => projectService.list(), [], ['projects:changed']);
  const { data: jobs } = useJobs();

  const exportJobs = (jobs ?? []).filter((job) => job.type === 'export_document');
  const finished = exportJobs.filter((job) => FINISHED_STATES.has(job.state));
  const finishedKey = finished.map((job) => job.id).join(',');

  // Artifacts carry the produced bytes, so reload them only when the set of
  // finished jobs changes - never on every progress tick.
  const { data: artifacts } = useCollection<ExportArtifact[]>(
    () => exportService.listByJobIds(finishedKey === '' ? [] : finishedKey.split(',')),
    [finishedKey],
    [],
  );

  const withExport = (projects ?? []).filter((project) => project.exportState !== 'not_started');

  return (
    <div className="page">
      <PageHeader
        title={t('exportCenter.title')}
        subtitle={t('exportCenter.subtitle')}
        actions={
          <ButtonLink to={ROUTES.workspace} variant="ghost" icon={<Icon name="layers" size={14} />}>
            {t('nav.workspace')}
          </ButtonLink>
        }
      />

      <Notice tone="info" icon="info">
        {t('exportCenter.engineNote')}
      </Notice>

      <div className="dashboard-grid">
        <div className="stack stack-6">
          <Card title={t('exportCenter.queue')}>
            <JobList
              jobs={exportJobs}
              emptyTitle={t('exportCenter.empty')}
              emptyHint={t('exportCenter.emptyHint')}
            />
          </Card>

          <Card title={t('projects.title')}>
            {withExport.length === 0 ? (
              <EmptyState icon="file" title={t('exportCenter.empty')} body={t('exportCenter.emptyHint')} plain />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('common.name')}</th>
                      <th>{t('exportCenter.exportState')}</th>
                      <th>{t('common.updated')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {withExport.map((project) => (
                      <tr key={project.id}>
                        <td className="truncate">{project.name}</td>
                        <td><ExportStateBadge state={project.exportState} /></td>
                        <td className="text-xs">{formatRelativeTime(project.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="stack stack-6">
          <Card title={t('exportCenter.startExport')}>
            <ExportStartForm projects={projects ?? []} />
          </Card>

          <Card title={t('exportCenter.results')}>
            <ExportResultList jobs={finished} artifacts={artifacts ?? []} />
          </Card>

          <Card title={t('exportCenter.formats')}>
            <div className="model-chips">
              {SUPPORTED_EXPORT_FORMATS.map((item) => (
                <span key={item} className="chip">
                  {item.toUpperCase()}
                </span>
              ))}
            </div>
            <p className="text-xs subtle" style={{ marginTop: 'var(--space-3)' }}>
              {t('exportCenter.formatHint')}
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
