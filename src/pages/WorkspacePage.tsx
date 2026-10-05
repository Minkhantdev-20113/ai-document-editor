import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ROUTES } from '../config/appConfig';
import { toAppError } from '../core/errors/appError';
import { formatDateTime } from '../core/utils/time';
import type { DocumentPage, DocumentRecord, Project } from '../db/entities';
import { startInspectionById } from '../jobs/actions';
import { useCollection } from '../hooks/useAsyncData';
import { useDocumentTitle } from '../hooks/useSystem';
import { useJobs } from '../hooks/useJobs';
import { useT } from '../i18n/I18nProvider';
import { documentService } from '../services/documentService';
import { projectService } from '../services/projectService';
import { useToast } from '../state/ToastProvider';
import { Button, ButtonLink } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/Icon';
import { Notice } from '../components/ui/Notice';
import { PageHeader } from '../components/ui/PageHeader';
import { JobList } from '../components/jobs/JobList';
import { InspectionBadge, StatusBadge } from '../components/ui/StatusBadge';
import { ProgressBar } from '../components/ui/Progress';

interface WorkspaceData {
  readonly projects: Project[];
  readonly project: Project | undefined;
  readonly document: DocumentRecord | undefined;
  readonly pages: DocumentPage[];
}

/** Document structure, inspection control and the live job queue. */
export function WorkspacePage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const t = useT();
  const toast = useToast();
  useDocumentTitle(t('workspace.title'));

  const { data, loading } = useCollection<WorkspaceData>(
    async () => {
      const projects = await projectService.list();
      const selectedId = projectId ?? projects[0]?.id;
      const project = selectedId ? projects.find((item) => item.id === selectedId) : undefined;
      const document = project?.documentId ? await documentService.get(project.documentId) : undefined;
      const pages = document ? await documentService.pages(document.id) : [];
      return { projects, project, document, pages };
    },
    [projectId],
    ['projects:changed', 'documents:changed', 'pages:changed', 'analysis:progress', 'units:changed'],
  );

  const { data: jobs } = useJobs(projectId ? { projectId } : {});
  const activeStates = useMemo(
    () => new Set(['analyzing', 'translating', 'exporting', 'retrying', 'queued']),
    [],
  );
  const running = (jobs ?? []).filter((job) => activeStates.has(job.state)).length;

  async function handleInspect() {
    if (!data?.project) return;
    try {
      await startInspectionById(data.project.id);
      toast.info(t('workspace.inspecting'));
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    }
  }

  const projects = data?.projects ?? [];
  const project = data?.project;
  const document = data?.document;
  const pages = data?.pages ?? [];

  if (loading && !data) {
    return (
      <div className="page">
        <PageHeader title={t('workspace.title')} subtitle={t('workspace.subtitle')} />
        <p className="muted">{t('common.loading')}</p>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="page">
        <PageHeader title={t('workspace.title')} subtitle={t('workspace.subtitle')} />
        <EmptyState
          icon="folder"
          title={t('projects.empty')}
          body={t('projects.emptyHint')}
          action={
            <ButtonLink to={ROUTES.projects} variant="primary" icon={<Icon name="plus" size={14} />}>
              {t('projects.create')}
            </ButtonLink>
          }
        />
      </div>
    );
  }

  const percent = project?.progress.percent ?? 0;
  const inspectBusy = project ? (jobs ?? []).some((job) => job.type === 'inspect_document' && activeStates.has(job.state)) : false;

  return (
    <div className="page page--wide">
      <PageHeader
        title={t('workspace.title')}
        subtitle={t('workspace.subtitle')}
        actions={
          <span className={['worker-indicator', inspectBusy ? 'worker-indicator--busy' : ''].filter(Boolean).join(' ')}>
            <span className="worker-indicator__dot" aria-hidden="true" />
            {t('workspace.workerStatus')}: {inspectBusy ? t('workspace.workerBusy') : t('workspace.workerIdle')}
          </span>
        }
      />

      <div className="workspace-layout">
        <Card title={t('workspace.selectProject')} bodyClassName="card__body--tight">
          <div className="project-picker">
            {projects.map((item) => (
              <button
                key={item.id}
                type="button"
                className={['project-picker__item', item.id === project?.id ? 'is-active' : '']
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => navigate(ROUTES.workspaceProject(item.id))}
              >
                <span className="project-picker__name truncate">{item.name}</span>
                <span className="text-xs subtle">
                  {item.sourceFile?.name ?? t('projects.noFile')}
                </span>
              </button>
            ))}
          </div>
        </Card>

        <div className="stack stack-6">
          <Card
            title={t('workspace.overview')}
            subtitle={project ? project.name : t('workspace.selectProjectHint')}
            actions={
              project ? (
                <div className="row row-2">
                  <Button
                    variant="primary"
                    icon={<Icon name="play" size={14} />}
                    loading={inspectBusy}
                    disabled={!document?.payloadStored}
                    onClick={() => void handleInspect()}
                  >
                    {document?.inspectionState === 'ready' ? t('workspace.reinspect') : t('workspace.inspect')}
                  </Button>
                  <ButtonLink to={ROUTES.analysis(project.id)} variant="ghost" icon={<Icon name="layers" size={14} />}>
                    {t('analysis.title')}
                  </ButtonLink>
                  <ButtonLink to={ROUTES.project(project.id)} variant="ghost">
                    {t('projects.viewProject')}
                  </ButtonLink>
                </div>
              ) : undefined
            }
          >
            {project ? (
              <div className="stack stack-4">
                <div className="overview-grid">
                  <div className="stat">
                    <span className="stat__label">{t('common.status')}</span>
                    <span className="stat__value" style={{ fontSize: 'var(--text-md)' }}>
                      <StatusBadge state={project.status} />
                    </span>
                  </div>
                  <div className="stat">
                    <span className="stat__label">{t('workspace.documentState')}</span>
                    <span className="stat__value" style={{ fontSize: 'var(--text-md)' }}>
                      {document ? <InspectionBadge state={document.inspectionState} /> : t('projects.noFile')}
                    </span>
                  </div>
                  <div className="stat">
                    <span className="stat__label">{t('common.pages')}</span>
                    <span className="stat__value">{document?.pageCount ?? 0}</span>
                  </div>
                  <div className="stat">
                    <span className="stat__label">{t('workspace.chars')}</span>
                    <span className="stat__value">{document?.charCount ?? 0}</span>
                  </div>
                </div>

                <div className="stack stack-2">
                  <ProgressBar value={percent} label={t('projects.progressValue', { percent })} />
                  <span className="text-xs muted">
                    {percent > 0 ? t('projects.progressValue', { percent }) : t('projects.noProgress')}
                    {' · '}
                    {t('workspace.resumeHint')}
                  </span>
                </div>

                <p className="text-xs subtle">{t('workspace.inspectHint')}</p>
                {document && !document.payloadStored && (
                  <Notice tone="warning">{t('workspace.fileNotStored')}</Notice>
                )}
              </div>
            ) : (
              <p className="muted">{t('workspace.selectProjectHint')}</p>
            )}
          </Card>

          <Card
            title={t('workspace.pagesTitle')}
            subtitle={project?.documentId ? undefined : t('workspace.pagesEmptyHint')}
          >
            {pages.length === 0 ? (
              <EmptyState
                icon="fileText"
                title={t('workspace.pagesEmpty')}
                body={t('workspace.pagesEmptyHint')}
              />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="num">{t('workspace.pageIndex')}</th>
                      <th>{t('workspace.dimensions')}</th>
                      <th className="num">{t('workspace.chars')}</th>
                      <th className="num">{t('workspace.units')}</th>
                      <th>{t('common.status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pages.map((page) => (
                      <tr key={page.id}>
                        <td className="num">{page.pageIndex + 1}</td>
                        <td className="mono text-xs">
                          {page.width} × {page.height}
                        </td>
                        <td className="num">{page.charCount}</td>
                        <td className="num">{page.unitCount}</td>
                        <td>
                          <span className="badge badge--no-dot">
                            {page.status === 'ready'
                              ? t('status.ready')
                              : page.status === 'failed'
                                ? t('status.failed')
                                : page.status === 'needs_ocr'
                                  ? t('status.needsOcr')
                                  : t('status.pending')}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card
            title={t('workspace.queueTitle')}
            subtitle={running > 0 ? t('status.running') : t('workspace.workerIdle')}
          >
            <JobList jobs={jobs ?? []} />
          </Card>

          {project && (
            <p className="text-xs subtle">
              {t('common.updated')}: {formatDateTime(project.updatedAt)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
