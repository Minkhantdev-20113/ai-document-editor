import { useMemo, useState } from 'react';
import { LANGUAGES, languageLabel } from '../config/languages';
import { JOB_STATES } from '../domain/jobStates';
import { LIMITS } from '../config/appConfig';
import type { Project } from '../db/entities';
import { projectService } from '../services/projectService';
import { useCollection } from '../hooks/useAsyncData';
import { useDocumentTitle } from '../hooks/useSystem';
import { useT } from '../i18n/I18nProvider';
import { useToast } from '../state/ToastProvider';
import { toAppError } from '../core/errors/appError';
import { formatBytes } from '../core/utils/format';
import { Button } from '../components/ui/Button';
import { ConfirmDialog, Modal } from '../components/ui/Modal';
import { Dropzone } from '../components/ui/Dropzone';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/Icon';
import { Input, Select, SearchInput, Textarea } from '../components/ui/Form';
import { LoadingBlock } from '../components/ui/Progress';
import { Notice } from '../components/ui/Notice';
import { PageHeader } from '../components/ui/PageHeader';
import { ProjectCard } from '../components/projects/ProjectCard';

const LANGUAGE_OPTIONS = LANGUAGES.map((language) => ({
  value: language.code,
  label: languageLabel(language.code),
}));

const STATUS_FILTERS: readonly string[] = ['all', ...JOB_STATES];

const ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.html,.htm,.json,.csv';

/** Project list: search, status filter, creation and cascade deletion. */
export function ProjectsPage() {
  const t = useT();
  const toast = useToast();
  useDocumentTitle(t('projects.title'));

  const { data: projects, loading, reload } = useCollection<Project[]>(
    () => projectService.list(),
    [],
    ['projects:changed'],
  );

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [sourceLanguage, setSourceLanguage] = useState('en');
  const [targetLanguage, setTargetLanguage] = useState('my');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (projects ?? []).filter((project) => {
      if (status !== 'all' && project.status !== status) return false;
      if (!needle) return true;
      return (
        project.name.toLowerCase().includes(needle) ||
        (project.sourceFile?.name.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [projects, query, status]);

  function openCreate() {
    setName('');
    setSourceLanguage('en');
    setTargetLanguage('my');
    setNotes('');
    setFile(null);
    setFormError(null);
    setCreating(true);
  }

  async function handleCreate() {
    if (!name.trim()) {
      setFormError(t('errors.validation'));
      return;
    }
    setSaving(true);
    try {
      const project = await projectService.create({
        name,
        sourceLanguage,
        targetLanguage,
        notes,
        file,
      });
      setCreating(false);
      toast.success(t('projects.createdToast', { name: project.name }));
    } catch (error) {
      setFormError(t(`errors.${toAppError(error).code}`));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await projectService.remove(pendingDelete.id);
      toast.success(t('projects.deletedToast'));
      setPendingDelete(null);
      reload();
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title={t('projects.title')}
        subtitle={t('projects.subtitle')}
        actions={
          <Button variant="primary" icon={<Icon name="plus" size={14} />} onClick={openCreate}>
            {t('projects.create')}
          </Button>
        }
      />

      <div className="toolbar">
        <div style={{ minWidth: 260, flex: '1 1 260px' }}>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('projects.searchPlaceholder')}
            ariaLabel={t('common.search')}
          />
        </div>
        <Select
          aria-label={t('projects.filterStatus')}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          options={STATUS_FILTERS.map((value) => ({
            value,
            label: value === 'all' ? t('common.all') : t(`status.${value}`),
          }))}
        />
      </div>

      {loading && !projects ? (
        <LoadingBlock>{t('common.loading')}</LoadingBlock>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="folder"
          title={projects && projects.length > 0 ? t('projects.emptySearch') : t('projects.empty')}
          body={projects && projects.length > 0 ? t('projects.emptySearchHint') : t('projects.emptyHint')}
          action={
            projects && projects.length === 0 ? (
              <Button variant="primary" icon={<Icon name="plus" size={14} />} onClick={openCreate}>
                {t('projects.create')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="projects-grid">
          {filtered.map((project) => (
            <ProjectCard key={project.id} project={project} onDelete={setPendingDelete} />
          ))}
        </div>
      )}

      <Modal
        open={creating}
        title={t('projects.createTitle')}
        description={t('projects.createHint')}
        onClose={() => setCreating(false)}
        wide
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void handleCreate()}>
              {t('common.create')}
            </Button>
          </>
        }
      >
        <div className="stack stack-4">
          {formError && <Notice tone="warning">{formError}</Notice>}
          <Dropzone
            accept={ACCEPT}
            onFile={setFile}
            hint={t('projects.dropFileHint', { size: formatBytes(LIMITS.maxSourceFileBytes, 0) })}
          />
          {file && (
            <div className="file-pill">
              <Icon name="fileText" size={16} />
              <span className="grow truncate">{file.name}</span>
              <span className="text-xs subtle">{formatBytes(file.size)}</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm btn--icon"
                aria-label={t('common.remove')}
                onClick={() => setFile(null)}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          )}
          <Input
            label={t('projects.projectName')}
            placeholder={t('projects.projectNamePlaceholder')}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="grid-2">
            <Select
              label={t('projects.sourceLanguage')}
              value={sourceLanguage}
              onChange={(event) => setSourceLanguage(event.target.value)}
              options={LANGUAGE_OPTIONS}
            />
            <Select
              label={t('projects.targetLanguage')}
              value={targetLanguage}
              onChange={(event) => setTargetLanguage(event.target.value)}
              options={LANGUAGE_OPTIONS}
            />
          </div>
          <Textarea
            label={t('projects.notes')}
            placeholder={t('projects.notesPlaceholder')}
            rows={3}
            optional
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('projects.deleteConfirmTitle')}
        body={t('projects.deleteConfirmBody', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
        destructive
        busy={deleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
