import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { CharacterCount, Placeholder, type CharacterCountStorage } from '@tiptap/extensions';
import { ROUTES } from '../config/appConfig';
import { toAppError } from '../core/errors/appError';
import type { EditorDocument, Project } from '../db/entities';
import { editorDocumentService } from '../services/editorDocumentService';
import { projectService } from '../services/projectService';
import { useCollection } from '../hooks/useAsyncData';
import { useDebouncedCallback } from '../hooks/useJobs';
import { useDocumentTitle } from '../hooks/useSystem';
import { useT } from '../i18n/I18nProvider';
import { useToast } from '../state/ToastProvider';
import { Button, ButtonLink } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog, Modal } from '../components/ui/Modal';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/Icon';
import { Input, Select } from '../components/ui/Form';
import { Notice } from '../components/ui/Notice';
import { PageHeader } from '../components/ui/PageHeader';

function ToolbarButton({
  editor,
  label,
  active,
  onClick,
  children,
}: {
  readonly editor: Editor;
  readonly label: string;
  readonly active?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={['editor-toolbar__btn', active ? 'is-active' : ''].filter(Boolean).join(' ')}
      aria-label={label}
      aria-pressed={active ?? false}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={!editor.isEditable}
    >
      {children}
    </button>
  );
}

/** Local rich-text editor backed by Tiptap and the editorDocuments store. */
export function EditorPage() {
  const t = useT();
  const toast = useToast();
  useDocumentTitle(t('editor.title'));

  const { data: documents, loading } = useCollection<EditorDocument[]>(
    () => editorDocumentService.list(),
    [],
    ['editor:changed'],
  );
  const { data: projects } = useCollection<Project[]>(() => projectService.list(), [], ['projects:changed']);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [titleEdit, setTitleEdit] = useState<{ id: string; value: string } | null>(null);
  const [dirtyId, setDirtyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const activeIdRef = useRef<string | null>(null);

  // Nothing explicitly selected yet: fall back to the most recent document.
  const activeId = selectedId ?? documents?.[0]?.id ?? null;
  const active = useMemo(
    () => (documents ?? []).find((document) => document.id === activeId) ?? null,
    [documents, activeId],
  );

  // Title edits are keyed to the document they belong to, so switching
  // documents never needs a synchronising effect.
  const title = titleEdit && titleEdit.id === active?.id ? titleEdit.value : (active?.title ?? '');
  const dirty = dirtyId !== null && dirtyId === active?.id;

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const saveContent = useDebouncedCallback((editor: Editor, id: string) => {
    void editorDocumentService
      .saveContent(id, { html: editor.getHTML() })
      .then(() => setDirtyId(null))
      .catch((error: unknown) => toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`)));
  }, 700);

  const editor = useEditor({
    extensions: [
      StarterKit,
      CharacterCount,
      Placeholder.configure({ placeholder: t('editor.startTyping') }),
    ],
    content: active?.html ?? '',
    onUpdate: ({ editor: current }) => {
      const id = activeIdRef.current;
      if (id) {
        setDirtyId(id);
        saveContent(current, id);
      }
    },
  });

  // Load the selected document into the editor without marking it as a change.
  useEffect(() => {
    if (!editor || !active) return;
    if (editor.getHTML() === active.html) return;
    editor.commands.setContent(active.html, { emitUpdate: false });
  }, [editor, active]);

  async function handleCreate() {
    if (!newProjectId) return;
    setBusy(true);
    try {
      const document = await editorDocumentService.create({
        projectId: newProjectId,
        title: newTitle.trim() || t('editor.untitled'),
      });
      setSelectedId(document.id);
      setTitleEdit(null);
      setCreating(false);
      setNewTitle('');
      toast.success(t('common.created'));
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveTitle() {
    if (!active) return;
    setBusy(true);
    try {
      await editorDocumentService.saveContent(active.id, { title });
      setTitleEdit(null);
      toast.success(t('common.saved'));
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!active) return;
    setBusy(true);
    try {
      await editorDocumentService.remove(active.id);
      setSelectedId(null);
      setTitleEdit(null);
      setConfirmDelete(false);
      toast.success(t('editor.deletedToast'));
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    } finally {
      setBusy(false);
    }
  }

  const counts = editor
    ? (editor.storage.characterCount as CharacterCountStorage | undefined)
    : undefined;

  if (!loading && (projects ?? []).length === 0) {
    return (
      <div className="page">
        <PageHeader title={t('editor.title')} subtitle={t('editor.subtitle')} />
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

  return (
    <div className="page page--wide">
      <PageHeader
        title={t('editor.title')}
        subtitle={t('editor.subtitle')}
        actions={
          <Button
            variant="primary"
            icon={<Icon name="plus" size={14} />}
            onClick={() => {
              setNewProjectId((projects ?? [])[0]?.id ?? '');
              setCreating(true);
            }}
          >
            {t('editor.newDocument')}
          </Button>
        }
      />

      <div className="editor-layout">
        <div className="stack stack-5">
          {editor && active ? (
            <div className="editor-shell">
              <div className="editor-toolbar">
                <ToolbarButton
                  editor={editor}
                  label={t('editor.bold')}
                  active={editor.isActive('bold')}
                  onClick={() => editor.chain().focus().toggleBold().run()}
                >
                  <strong>B</strong>
                </ToolbarButton>
                <ToolbarButton
                  editor={editor}
                  label={t('editor.italic')}
                  active={editor.isActive('italic')}
                  onClick={() => editor.chain().focus().toggleItalic().run()}
                >
                  <em>I</em>
                </ToolbarButton>
                <span className="editor-toolbar__sep" aria-hidden="true" />
                <ToolbarButton
                  editor={editor}
                  label={t('editor.heading1')}
                  active={editor.isActive('heading', { level: 1 })}
                  onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
                >
                  H1
                </ToolbarButton>
                <ToolbarButton
                  editor={editor}
                  label={t('editor.heading2')}
                  active={editor.isActive('heading', { level: 2 })}
                  onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                >
                  H2
                </ToolbarButton>
                <span className="editor-toolbar__sep" aria-hidden="true" />
                <ToolbarButton
                  editor={editor}
                  label={t('editor.bulletList')}
                  active={editor.isActive('bulletList')}
                  onClick={() => editor.chain().focus().toggleBulletList().run()}
                >
                  •
                </ToolbarButton>
                <ToolbarButton
                  editor={editor}
                  label={t('editor.orderedList')}
                  active={editor.isActive('orderedList')}
                  onClick={() => editor.chain().focus().toggleOrderedList().run()}
                >
                  1.
                </ToolbarButton>
                <ToolbarButton
                  editor={editor}
                  label={t('editor.blockquote')}
                  active={editor.isActive('blockquote')}
                  onClick={() => editor.chain().focus().toggleBlockquote().run()}
                >
                  ❝
                </ToolbarButton>
                <span className="editor-toolbar__sep" aria-hidden="true" />
                <ToolbarButton
                  editor={editor}
                  label={t('editor.undo')}
                  onClick={() => editor.chain().focus().undo().run()}
                >
                  <Icon name="refresh" size={14} />
                </ToolbarButton>
                <ToolbarButton
                  editor={editor}
                  label={t('editor.redo')}
                  onClick={() => editor.chain().focus().redo().run()}
                >
                  <Icon name="arrowRight" size={14} />
                </ToolbarButton>
              </div>

              <EditorContent editor={editor} />

              <div className="editor-status">
                <span>{dirty ? t('editor.unsaved') : t('editor.saved')}</span>
                <span>
                  {t('editor.wordCount', { words: counts?.words() ?? 0 })}
                  {' · '}
                  {t('editor.charCount', { chars: counts?.characters() ?? 0 })}
                </span>
              </div>
            </div>
          ) : (
            <EmptyState
              icon="pen"
              title={t('editor.empty')}
              body={t('editor.emptyHint')}
              action={
                <Button
                  variant="primary"
                  icon={<Icon name="plus" size={14} />}
                  onClick={() => {
                    setNewProjectId((projects ?? [])[0]?.id ?? '');
                    setCreating(true);
                  }}
                >
                  {t('editor.newDocument')}
                </Button>
              }
            />
          )}

          <div className="row row-3">
            <Input
              label={t('editor.titlePlaceholder')}
              value={title}
              disabled={!active}
              onChange={(event) => active && setTitleEdit({ id: active.id, value: event.target.value })}
            />
            <div className="row row-2" style={{ alignItems: 'flex-end' }}>
              <Button disabled={!active || title === active?.title} loading={busy} onClick={() => void handleSaveTitle()}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        </div>

        <div className="stack stack-5">
          <Card title={t('editor.document')} bodyClassName="card__body--tight">
            <div className="project-picker">
              {(documents ?? []).map((document) => (
                <button
                  key={document.id}
                  type="button"
                  className={['project-picker__item', document.id === activeId ? 'is-active' : '']
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => setSelectedId(document.id)}
                >
                  <span className="project-picker__name truncate">{document.title}</span>
                </button>
              ))}
              {(documents ?? []).length === 0 && !loading && (
                <p className="text-xs subtle" style={{ padding: 'var(--space-3)' }}>
                  {t('editor.emptyHint')}
                </p>
              )}
            </div>
            {active && (
              <div className="row row-2" style={{ marginTop: 'var(--space-3)' }}>
                <Button variant="danger" size="sm" icon={<Icon name="trash" size={13} />} onClick={() => setConfirmDelete(true)}>
                  {t('editor.deleteDocument')}
                </Button>
              </div>
            )}
          </Card>

          <Card title={t('editor.unitsPanel')}>
            <EmptyState icon="translate" title={t('editor.unitsEmpty')} body={t('editor.unitsEmptyHint')} plain />
          </Card>

          <Notice tone="info" icon="info">
            {t('workspace.resumeHint')}
          </Notice>
        </div>
      </div>

      <Modal
        open={creating}
        title={t('editor.newDocument')}
        onClose={() => setCreating(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} disabled={!newProjectId} onClick={() => void handleCreate()}>
              {t('common.create')}
            </Button>
          </>
        }
      >
        <div className="stack stack-4">
          <Select
            label={t('workspace.selectProject')}
            value={newProjectId}
            onChange={(event) => setNewProjectId(event.target.value)}
            options={(projects ?? []).map((project) => ({ value: project.id, label: project.name }))}
          />
          <Input
            label={t('editor.titlePlaceholder')}
            placeholder={t('editor.untitled')}
            value={newTitle}
            optional
            onChange={(event) => setNewTitle(event.target.value)}
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title={t('editor.deleteConfirmTitle')}
        body={t('editor.deleteConfirmBody')}
        confirmLabel={t('common.delete')}
        destructive
        busy={busy}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
