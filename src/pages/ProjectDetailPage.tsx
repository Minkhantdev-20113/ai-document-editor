import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ROUTES } from '../config/appConfig';
import { languageLabel } from '../config/languages';
import { toAppError } from '../core/errors/appError';
import { formatBytes } from '../core/utils/format';
import { formatDateTime } from '../core/utils/time';
import type { DocumentRecord, Project } from '../db/entities';
import { startInspectionById, startTranslationById } from '../jobs/actions';
import { useCollection } from '../hooks/useAsyncData';
import { useDocumentTitle } from '../hooks/useSystem';
import { useJobs } from '../hooks/useJobs';
import { useT } from '../i18n/I18nProvider';
import { documentService } from '../services/documentService';
import { projectService } from '../services/projectService';
import type { TranslationStrategy } from '../services/translationService';
import { useToast } from '../state/ToastProvider';
import { Button, ButtonLink } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/Modal';
import { Icon } from '../components/ui/Icon';
import { Notice } from '../components/ui/Notice';
import { PageHeader } from '../components/ui/PageHeader';
import { Textarea } from '../components/ui/Form';
import { InspectionBadge, StatusBadge, ExportStateBadge } from '../components/ui/StatusBadge';
import { ProgressBar } from '../components/ui/Progress';
import { JobList } from '../components/jobs/JobList';
import { GlossaryCard } from '../components/translation/GlossaryCard';
import { WorkflowCard } from '../components/translation/WorkflowCard';

interface DetailData {
  readonly project: Project | undefined;
  readonly document: DocumentRecord | undefined;
}

/** Single project: metadata, source document state, notes and its job queue. */
export function ProjectDetailPage() {
  const { projectId = '' } = useParams();
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  // Local note edits are keyed to the project they belong to, so switching
  // projects (or reloading the record) never clobbers what is typed.
  const [notesEdit, setNotesEdit] = useState<{ id: string; value: string } | null>(null);

  const { data, loading } = useCollection<DetailData>(
    async () => {
      const project = await projectService.get(projectId);
      const document = project?.documentId ? await documentService.get(project.documentId) : undefined;
      return { project, document };
    },
    [projectId],
    ['projects:changed', 'documents:changed'],
  );

  const { data: jobs } = useJobs({ projectId });
  const project = data?.project;
  const document = data?.document;

  useDocumentTitle(project?.name ?? t('projects.title'));

  const notesDirty = notesEdit !== null && notesEdit.id === project?.id;
  const notes = notesEdit && notesEdit.id === project?.id ? notesEdit.value : (project?.notes ?? '');

  async function handleInspect() {
    setBusy(true);
    try {
      await startInspectionById(projectId);
      toast.info(t('workspace.inspect'));
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    } finally {
      setBusy(false);
    }
  }

  async function handleTranslate(strategy?: TranslationStrategy) {
    setBusy(true);
    try {
      await startTranslationById(projectId, strategy ? { strategy } : {});
      toast.info(t('translation.queued'));
    } catch (error) {
      const appError = toAppError(error);
      // Preflight failures are actionable ("no usable key…"), so show the
      // specific message instead of a generic code label.
      toast.error(t('toast.error'), appError.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveNotes() {
    setBusy(true);
    try {
      await projectService.update(projectId, { notes });
      setNotesEdit(null);
      toast.success(t('common.saved'));
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await projectService.remove(projectId);
      toast.success(t('projects.deletedToast'));
      navigate(ROUTES.projects);
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
      setBusy(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="page">
        <PageHeader title={t('projects.title')} />
        <p className="muted">{t('common.loading')}</p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="page">
        <PageHeader title={t('projects.title')} />
        <Notice tone="warning" icon="alertTriangle">
          {t('errors.not_found')}
        </Notice>
        <div className="row row-2">
          <ButtonLink to={ROUTES.projects}>{t('common.back')}</ButtonLink>
        </div>
      </div>
    );
  }

  const percent = project.progress.percent;

  return (
    <div className="page">
      <PageHeader
        title={project.name}
        subtitle={
          <span className="row row-2">
            <StatusBadge state={project.status} />
            <span>{languageLabel(project.sourceLanguage)} → {languageLabel(project.targetLanguage)}</span>
          </span>
        }
        actions={
          <>
            <ButtonLink to={ROUTES.workspaceProject(project.id)} icon={<Icon name="layers" size={14} />}>
              {t('projects.openWorkspace')}
            </ButtonLink>
            <Button
              variant="primary"
              icon={<Icon name="play" size={14} />}
              loading={busy}
              disabled={!project.documentId}
              onClick={() => void handleInspect()}
            >
              {t('workspace.inspect')}
            </Button>
          </>
        }
      />

      <div className="dashboard-grid">
        <div className="stack stack-6">
          <Card title={t('common.details')}>
            <div className="kv">
              <span className="kv__key">{t('projects.sourceFile')}</span>
              <span className="kv__value">
                {project.sourceFile ? (
                  <>
                    <span className="truncate">{project.sourceFile.name}</span>
                    <span className="subtle"> · {formatBytes(project.sourceFile.size)}</span>
                  </>
                ) : (
                  t('projects.noFile')
                )}
              </span>
            </div>
            <div className="kv">
              <span className="kv__key">{t('common.status')}</span>
              <span className="kv__value">
                {document ? <InspectionBadge state={document.inspectionState} /> : t('projects.noFile')}
              </span>
            </div>
            <div className="kv">
              <span className="kv__key">{t('common.pages')}</span>
              <span className="kv__value">{document?.pageCount ?? '—'}</span>
            </div>
            <div className="kv">
              <span className="kv__key">{t('projects.lastUnit')}</span>
              <span className="kv__value">{project.lastProcessedUnit}</span>
            </div>
            <div className="kv">
              <span className="kv__key">{t('projects.exportState')}</span>
              <span className="kv__value"><ExportStateBadge state={project.exportState} /></span>
            </div>
            <div className="kv">
              <span className="kv__key">{t('common.created')}</span>
              <span className="kv__value">{formatDateTime(project.createdAt)}</span>
            </div>
            <div className="kv">
              <span className="kv__key">{t('common.updated')}</span>
              <span className="kv__value">{formatDateTime(project.updatedAt)}</span>
            </div>
          </Card>

          <WorkflowCard
            project={project}
            document={document}
            jobs={jobs ?? []}
            busy={busy}
            onTranslate={(strategy) => void handleTranslate(strategy)}
          />

          <GlossaryCard projectId={project.id} />

          <Card title={t('workspace.queueTitle')}>
            <JobList jobs={jobs ?? []} />
          </Card>
        </div>

        <div className="stack stack-6">
          <Card title={t('common.progress')}>
            <div className="stack stack-2">
              <ProgressBar
                value={percent}
                label={percent > 0 ? t('projects.progressValue', { percent }) : t('projects.noProgress')}
              />
              <span className="text-sm muted">
                {percent > 0
                  ? t('projects.progressValue', { percent })
                  : t('projects.noProgress')}
              </span>
              <span className="text-xs subtle">
                {project.progress.processed} {t('common.of')} {project.progress.total}
              </span>
              <p className="text-xs subtle">{t('workspace.resumeHint')}</p>
            </div>
          </Card>

          <Card title={t('projects.notes')}>
            <div className="stack stack-3">
              <Textarea
                rows={5}
                value={notes}
                placeholder={t('projects.notesPlaceholder')}
                onChange={(event) => project && setNotesEdit({ id: project.id, value: event.target.value })}
              />
              <div className="row row-2">
                <Button
                  variant="primary"
                  disabled={!notesDirty}
                  loading={busy}
                  onClick={() => void handleSaveNotes()}
                >
                  {notesDirty ? t('common.save') : t('common.saved')}
                </Button>
                <Link className="btn btn--ghost" to={ROUTES.projects}>
                  {t('common.back')}
                </Link>
              </div>
            </div>
          </Card>

          <Card title={t('common.dangerZone')}>
            <div className="stack stack-3">
              <p className="text-sm muted">{t('projects.deleteConfirmBody', { name: project.name })}</p>
              <div>
                <Button variant="danger" icon={<Icon name="trash" size={14} />} onClick={() => setConfirmDelete(true)}>
                  {t('common.delete')}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={t('projects.deleteConfirmTitle')}
        body={t('projects.deleteConfirmBody', { name: project.name })}
        confirmLabel={t('common.delete')}
        destructive
        busy={busy}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
      />

      {!busy && !project.documentId && (
        <Notice tone="info" icon="info">
          {t('workspace.fileNotStored')}
        </Notice>
      )}
    </div>
  );
}
