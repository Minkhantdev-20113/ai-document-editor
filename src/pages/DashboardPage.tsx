import { Link } from 'react-router-dom';
import { ROUTES } from '../config/appConfig';
import { estimateStorageUsage } from '../db/database';
import { apiKeyService } from '../services/apiKeyService';
import { errorLogService } from '../services/errorLogService';
import { projectService } from '../services/projectService';
import { providerConfigService } from '../services/providerConfigService';
import type { Project, JobRecord } from '../db/entities';
import { useCollection } from '../hooks/useAsyncData';
import { useJobs, useQueueStatus } from '../hooks/useJobs';
import { useDocumentTitle } from '../hooks/useSystem';
import { useT } from '../i18n/I18nProvider';
import { formatBytes } from '../core/utils/format';
import { formatRelativeTime } from '../core/utils/time';
import { ButtonLink } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/Icon';
import { LoadingBlock } from '../components/ui/Progress';
import { Notice } from '../components/ui/Notice';
import { PageHeader } from '../components/ui/PageHeader';
import { JobList } from '../components/jobs/JobList';
import { ProjectRow } from '../components/projects/ProjectRow';

interface DashboardData {
  readonly stats: Awaited<ReturnType<typeof projectService.stats>>;
  readonly recent: Project[];
  readonly keyCount: number;
  readonly providerCount: number;
  readonly errorCount: number;
  readonly storage: { usage: number; quota: number } | null;
}

const REFRESH_EVENTS = [
  'projects:changed',
  'jobs:changed',
  'apiKeys:changed',
  'providers:changed',
  'errors:changed',
] as const;

/** Local workspace overview: counts, recent work and system status. */
export function DashboardPage() {
  const t = useT();
  useDocumentTitle(t('dashboard.title'));
  const { data, loading, error } = useCollection<DashboardData>(
    async () => ({
      stats: await projectService.stats(),
      recent: (await projectService.list()).slice(0, 5),
      keyCount: await apiKeyService.count(),
      providerCount: await providerConfigService.enabledCount(),
      errorCount: await errorLogService.count(),
      storage: await estimateStorageUsage(),
    }),
    [],
    REFRESH_EVENTS,
  );
  const { data: jobsData } = useJobs();
  const jobs: JobRecord[] = jobsData ?? [];
  const { recovered } = useQueueStatus();

  if (loading && !data) return <LoadingBlock>{t('common.loading')}</LoadingBlock>;

  const stats = data?.stats;
  const storage = data?.storage;

  return (
    <div className="page">
      <PageHeader
        title={t('dashboard.title')}
        subtitle={t('dashboard.subtitle')}
        actions={
          <ButtonLink to={ROUTES.projects} variant="primary" icon={<Icon name="plus" size={14} />}>
            {t('projects.create')}
          </ButtonLink>
        }
      />

      {recovered > 0 && (
        <Notice tone="info" icon="refresh">
          <strong>{t('job.recoveredTitle')}</strong>
          <div className="text-xs">{t('job.recoveredBody')}</div>
        </Notice>
      )}

      {error && <Notice tone="warning">{t(`errors.${error.code}`)}</Notice>}

      <div className="grid-4">
        <div className="stat">
          <span className="stat__label">{t('dashboard.statProjects')}</span>
          <span className="stat__value">{stats?.total ?? 0}</span>
        </div>
        <div className="stat">
          <span className="stat__label">{t('dashboard.statJobsActive')}</span>
          <span className="stat__value">{stats?.activeJobs ?? 0}</span>
        </div>
        <div className="stat">
          <span className="stat__label">{t('dashboard.statUnits')}</span>
          <span className="stat__value">{stats?.units ?? 0}</span>
        </div>
        <div className="stat">
          <span className="stat__label">{t('dashboard.statErrors')}</span>
          <span className="stat__value">{data?.errorCount ?? 0}</span>
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="stack stack-6">
          <Card
            title={t('dashboard.recentProjects')}
            actions={
              <Link className="btn btn--ghost btn--sm" to={ROUTES.projects}>
                {t('nav.projects')}
              </Link>
            }
          >
            {data && data.recent.length > 0 ? (
              <div className="project-list">
                {data.recent.map((project) => (
                  <ProjectRow key={project.id} project={project} />
                ))}
              </div>
            ) : (
              <EmptyState
                icon="folder"
                title={t('dashboard.noProjects')}
                body={t('dashboard.noProjectsHint')}
                action={
                  <ButtonLink to={ROUTES.projects} variant="primary" icon={<Icon name="plus" size={14} />}>
                    {t('projects.create')}
                  </ButtonLink>
                }
              />
            )}
          </Card>

          <Card title={t('workspace.queueTitle')}>
            <JobList jobs={jobs.slice(0, 6)} />
          </Card>
        </div>

        <div className="stack stack-6">
          <Card title={t('dashboard.systemStatus')}>
            <div className="kv">
              <span className="kv__key">{t('dashboard.providerConfigured')}</span>
              <span className="kv__value">
                {(data?.providerCount ?? 0) > 0
                  ? t('dashboard.providerConfiguredOk', { count: data?.providerCount ?? 0 })
                  : t('dashboard.providerConfiguredNone')}
              </span>
            </div>
            <div className="kv">
              <span className="kv__key">{t('dashboard.keysStored')}</span>
              <span className="kv__value">
                {(data?.keyCount ?? 0) > 0
                  ? t('dashboard.keysStoredOk', { count: data?.keyCount ?? 0 })
                  : t('dashboard.keysStoredNone')}
              </span>
            </div>
            <div className="kv">
              <span className="kv__key">{t('dashboard.engineStatus')}</span>
              <span className="kv__value">{t('dashboard.engineStatusPending')}</span>
            </div>
            <div className="kv">
              <span className="kv__key">{t('dashboard.lastActivity')}</span>
              <span className="kv__value">
                {jobs[0] ? formatRelativeTime(jobs[0].updatedAt) : t('common.never')}
              </span>
            </div>
          </Card>

          <Card title={t('dashboard.storageUsage')}>
            {storage ? (
              <div className="stack stack-2">
                <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100}>
                  <div
                    className="progress__bar"
                    style={{
                      width: `${Math.min(100, Math.round((storage.usage / Math.max(1, storage.quota)) * 100))}%`,
                    }}
                  />
                </div>
                <span className="text-xs muted">
                  {t('dashboard.storageUsed', {
                    used: formatBytes(storage.usage),
                    quota: formatBytes(storage.quota),
                  })}
                </span>
              </div>
            ) : (
              <span className="text-xs muted">{t('dashboard.storageUnknown')}</span>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
