import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ROUTES } from '../config/appConfig';
import { toAppError } from '../core/errors/appError';
import type {
  DocumentPage,
  DocumentRecord,
  Project,
  TranslationUnit,
} from '../db/entities';
import { useCollection } from '../hooks/useAsyncData';
import { useDocumentTitle } from '../hooks/useSystem';
import { useT } from '../i18n/I18nProvider';
import { documentService } from '../services/documentService';
import { glossaryService } from '../services/glossaryService';
import { projectService } from '../services/projectService';
import { unitsService } from '../services/unitsService';
import { useToast } from '../state/ToastProvider';
import { ButtonLink } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ConfirmDialog } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { ContextPanel } from '../components/translation/ContextPanel';
import { PageNavPanel, type PageNavStat } from '../components/translation/PageNavPanel';
import { UnitList } from '../components/translation/UnitList';
import {
  WorkspaceToolbar,
  type EditorSaveStatus,
  type EditorViewMode,
} from '../components/translation/WorkspaceToolbar';

interface WorkspaceData {
  readonly project: Project | undefined;
  readonly document: DocumentRecord | undefined;
  readonly pages: DocumentPage[];
  readonly units: TranslationUnit[];
}

/** One undo/redo step: restoring `before` undoes, re-applying `after` redoes. */
interface HistoryEntry {
  readonly unitId: string;
  readonly before: string | null;
  readonly after: string;
}

const HISTORY_LIMIT = 100;
const AUTOSAVE_DELAY_MS = 700;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDone(unit: TranslationUnit): boolean {
  return unit.status === 'translated' || unit.status === 'reviewed';
}

/**
 * Phase 4 translation workspace: page navigation (left), editable
 * translation with search/replace, undo/redo and autosave (center), and
 * context with terminology, AI/memory suggestions and warnings (right).
 *
 * Manual edits always win: every human write goes through
 * `unitsService.updateTranslation`, which stamps `editedAt` so later
 * reprocessing can never overwrite them.
 */
export function TranslationEditorPage() {
  const { projectId } = useParams();
  const t = useT();
  const toast = useToast();
  useDocumentTitle(t('editor.workspaceTitle'));

  const { data, loading } = useCollection<WorkspaceData>(
    async () => {
      const project = projectId ? await projectService.get(projectId) : undefined;
      const document = project?.documentId ? await documentService.get(project.documentId) : undefined;
      const pages = document ? await documentService.pages(document.id) : [];
      const units = document ? await unitsService.listByDocument(document.id) : [];
      return { project, document, pages, units };
    },
    [projectId],
    ['projects:changed', 'documents:changed', 'pages:changed', 'units:changed'],
  );
  const { data: glossary } = useCollection(
    async () => (projectId ? glossaryService.list(projectId) : []),
    [projectId],
    ['glossary:changed'],
  );

  const project = data?.project;
  const document = data?.document;
  const pages = useMemo(() => data?.pages ?? [], [data]);
  const units = useMemo(() => data?.units ?? [], [data]);

  // --- view/search state -------------------------------------------------
  const [viewMode, setViewMode] = useState<EditorViewMode>('both');
  const [query, setQuery] = useState('');
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceValue, setReplaceValue] = useState('');
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<EditorSaveStatus>('saved');
  const [confirmReplace, setConfirmReplace] = useState(false);

  // --- drafts + history --------------------------------------------------
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef<Record<string, string>>({});
  const unitsRef = useRef<TranslationUnit[]>(units);
  useEffect(() => {
    unitsRef.current = units;
  }, [units]);

  const [undoState, setUndoState] = useState<HistoryEntry[]>([]);
  const [redoState, setRedoState] = useState<HistoryEntry[]>([]);
  const undoRef = useRef<HistoryEntry[]>([]);
  const redoRef = useRef<HistoryEntry[]>([]);
  const setHistory = useCallback((undo: HistoryEntry[], redo: HistoryEntry[]) => {
    undoRef.current = undo;
    redoRef.current = redo;
    setUndoState(undo);
    setRedoState(redo);
  }, []);

  const updateDraft = (unitId: string, text: string): void => {
    const next = { ...draftsRef.current, [unitId]: text };
    draftsRef.current = next;
    setDrafts(next);
    setSaveStatus('unsaved');
  };

  const clearDrafts = useCallback((unitIds: readonly string[]) => {
    const next = { ...draftsRef.current };
    let changed = false;
    for (const unitId of unitIds) {
      if (unitId in next) {
        delete next[unitId];
        changed = true;
      }
    }
    if (changed) {
      draftsRef.current = next;
      setDrafts(next);
    }
  }, []);

  /** Persists every dirty draft; serialized so callers can safely await it. */
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const flush = useCallback((): Promise<void> => {
    const run = async (): Promise<void> => {
      const entries = Object.entries(draftsRef.current);
      if (entries.length === 0) return;
      setSaveStatus('saving');
      const added: HistoryEntry[] = [];
      try {
        for (const [unitId, text] of entries) {
          const before = unitsRef.current.find((unit) => unit.id === unitId)?.translatedText ?? null;
          const persisted = text.trim() === '' ? null : text;
          if (before === persisted) {
            clearDrafts([unitId]);
            continue;
          }
          await unitsService.updateTranslation(unitId, text);
          clearDrafts([unitId]);
          added.push({ unitId, before, after: text });
        }
        if (added.length > 0) {
          setHistory(
            [...undoRef.current, ...added].slice(-HISTORY_LIMIT),
            [],
          );
        }
        setSaveStatus('saved');
      } catch (error) {
        if (added.length > 0) {
          setHistory([...undoRef.current, ...added].slice(-HISTORY_LIMIT), []);
        }
        setSaveStatus('error');
        toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
      }
    };
    const next = chainRef.current.then(run, run);
    chainRef.current = next;
    return next;
  }, [clearDrafts, setHistory, t, toast]);

  const applyImmediate = useCallback(
    async (unitId: string, text: string): Promise<void> => {
      setSaveStatus('saving');
      try {
        await unitsService.updateTranslation(unitId, text);
        clearDrafts([unitId]);
        setSaveStatus('saved');
      } catch (error) {
        setSaveStatus('error');
        toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
      }
    },
    [clearDrafts, t, toast],
  );

  // Autosave: schedule a flush whenever drafts change (no work when clean).
  useEffect(() => {
    if (Object.keys(drafts).length === 0) return;
    const timer = setTimeout(() => {
      void flush();
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [drafts, flush]);

  // Never lose unsaved work on navigation away from the workspace.
  useEffect(() => {
    return () => {
      if (Object.keys(draftsRef.current).length > 0) void flush();
    };
  }, [flush]);

  // Browser close/refresh with unsaved edits: warn before leaving.
  useEffect(() => {
    if (Object.keys(drafts).length === 0) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [drafts]);

  // --- filtering ----------------------------------------------------------
  const needle = query.trim().toLowerCase();
  const searching = needle !== '';
  const matchesQuery = useCallback(
    (unit: TranslationUnit): boolean => {
      if (!searching) return false;
      const draft = drafts[unit.id] ?? '';
      return (
        unit.sourceText.toLowerCase().includes(needle) ||
        (unit.translatedText ?? '').toLowerCase().includes(needle) ||
        draft.toLowerCase().includes(needle)
      );
    },
    [drafts, needle, searching],
  );

  const searchMatches = useMemo(
    () => (searching ? units.filter(matchesQuery) : []),
    [matchesQuery, searching, units],
  );
  // Replace only touches translation text, so its count is narrower than the
  // search scope (which also matches on source).
  const replaceCount = useMemo(
    () =>
      searching
        ? searchMatches.filter((unit) =>
            (unit.translatedText ?? '').toLowerCase().includes(needle),
          ).length
        : 0,
    [needle, searchMatches, searching],
  );
  const filteredUnits = useMemo(() => {
    if (searching) return searchMatches;
    if (selectedPageId) return units.filter((unit) => unit.pageId === selectedPageId);
    return units;
  }, [searchMatches, selectedPageId, searching, units]);

  const pageStats = useMemo(() => {
    const map = new Map<string, PageNavStat>();
    for (const unit of units) {
      const stat = map.get(unit.pageId) ?? { total: 0, translated: 0, warnings: 0 };
      map.set(unit.pageId, {
        total: stat.total + 1,
        translated: stat.translated + (isDone(unit) ? 1 : 0),
        warnings: stat.warnings + ((unit.warnings?.length ?? 0) > 0 ? 1 : 0),
      });
    }
    return map;
  }, [units]);

  const selectedUnit =
    units.find((unit) => unit.id === selectedUnitId) ?? filteredUnits[0] ?? null;

  const dirty = Object.keys(drafts).length > 0;

  // --- actions ------------------------------------------------------------
  async function handleUndo(): Promise<void> {
    await flush();
    const entry = undoRef.current[undoRef.current.length - 1];
    if (!entry) return;
    setHistory(undoRef.current.slice(0, -1), [...redoRef.current, entry]);
    await applyImmediate(entry.unitId, entry.before ?? '');
  }

  async function handleRedo(): Promise<void> {
    await flush();
    const entry = redoRef.current[redoRef.current.length - 1];
    if (!entry) return;
    setHistory([...undoRef.current, entry].slice(-HISTORY_LIMIT), redoRef.current.slice(0, -1));
    await applyImmediate(entry.unitId, entry.after);
  }

  async function handleReplace(): Promise<void> {
    setConfirmReplace(false);
    const activeNeedle = query.trim();
    if (activeNeedle === '') return;
    await flush();
    const changed: HistoryEntry[] = [];
    for (const unit of unitsRef.current) {
      const before = unit.translatedText ?? '';
      if (!before.toLowerCase().includes(activeNeedle.toLowerCase())) continue;
      const after = before.replace(
        new RegExp(escapeRegExp(activeNeedle), 'gi'),
        () => replaceValue,
      );
      if (after === before) continue;
      changed.push({ unitId: unit.id, before: unit.translatedText, after });
    }
    if (changed.length === 0) {
      toast.info(t('editor.replaceDone', { count: 0 }));
      setReplaceOpen(false);
      return;
    }
    setSaveStatus('saving');
    try {
      for (const entry of changed) {
        await unitsService.updateTranslation(entry.unitId, entry.after);
        clearDrafts([entry.unitId]);
      }
      setHistory(
        [...undoRef.current, ...changed].slice(-HISTORY_LIMIT),
        [],
      );
      setSaveStatus('saved');
      toast.success(t('editor.replaceDone', { count: changed.length }));
      setReplaceOpen(false);
    } catch (error) {
      setSaveStatus('error');
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    }
  }

  async function handleApplyText(text: string): Promise<void> {
    if (!selectedUnit || text.trim() === '') return;
    await flush();
    const before =
      unitsRef.current.find((unit) => unit.id === selectedUnit.id)?.translatedText ?? null;
    if (before === text) return;
    setHistory(
      [...undoRef.current, { unitId: selectedUnit.id, before, after: text }].slice(
        -HISTORY_LIMIT,
      ),
      [],
    );
    await applyImmediate(selectedUnit.id, text);
  }

  async function handleToggleReviewed(reviewed: boolean): Promise<void> {
    if (!selectedUnit) return;
    await flush();
    try {
      await unitsService.setReviewed(selectedUnit.id, reviewed);
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    }
  }

  async function handleRetranslate(): Promise<void> {
    if (!selectedUnit) return;
    await flush();
    try {
      await unitsService.requestRetranslation(selectedUnit.id);
      toast.info(t('editor.retranslateQueued'));
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    }
  }

  // --- render -------------------------------------------------------------
  if (loading && !data) {
    return (
      <div className="page">
        <PageHeader title={t('editor.workspaceTitle')} subtitle={t('editor.workspaceSubtitle')} />
        <p className="muted">{t('common.loading')}</p>
      </div>
    );
  }

  if (!project || !document) {
    return (
      <div className="page">
        <PageHeader title={t('editor.workspaceTitle')} subtitle={t('editor.workspaceSubtitle')} />
        <EmptyState
          icon="fileText"
          title={t('editor.workspaceEmptyTitle')}
          body={t('editor.workspaceEmptyHint')}
          action={
            <ButtonLink to={ROUTES.workspace} variant="primary">
              {t('nav.workspace')}
            </ButtonLink>
          }
        />
      </div>
    );
  }

  if (units.length === 0) {
    return (
      <div className="page">
        <PageHeader title={t('editor.workspaceTitle')} subtitle={t('editor.workspaceSubtitle')} />
        <EmptyState
          icon="fileText"
          title={t('editor.unitsEmpty')}
          body={t('editor.unitsEmptyHint')}
          action={
            <ButtonLink to={ROUTES.project(project.id)} variant="primary">
              {t('workflow.title')}
            </ButtonLink>
          }
        />
      </div>
    );
  }

  return (
    <div className="page page--wide">
      <PageHeader
        title={t('editor.workspaceTitle')}
        subtitle={t('editor.workspaceSubtitle')}
        actions={
          <ButtonLink to={ROUTES.project(project.id)} variant="ghost">
            {t('projects.title')}
          </ButtonLink>
        }
      />

      <div className="stack stack-4">
        <WorkspaceToolbar
          viewMode={viewMode}
          onViewMode={setViewMode}
          query={query}
          onQuery={setQuery}
          replaceOpen={replaceOpen}
          onReplaceToggle={() => setReplaceOpen((open) => !open)}
          replaceValue={replaceValue}
          onReplaceValue={setReplaceValue}
          onReplaceApply={() => setConfirmReplace(true)}
          matchCount={searchMatches.length}
          replaceCount={replaceCount}
          canUndo={undoState.length > 0}
          canRedo={redoState.length > 0}
          onUndo={() => void handleUndo()}
          onRedo={() => void handleRedo()}
          saveStatus={saveStatus}
        />

        <div className="translation-editor">
          <Card title={t('workspace.pagesTitle')}>
            <PageNavPanel
              pages={pages}
              stats={pageStats}
              selectedPageId={selectedPageId}
              onSelect={(pageId) => {
                setSelectedPageId(pageId);
                if (searching) setQuery('');
              }}
            />
          </Card>

          <Card title={t('editor.unitsPanel')} subtitle={dirty ? t('editor.unsavedHint') : undefined}>
            <UnitList
              units={filteredUnits}
              drafts={drafts}
              viewMode={viewMode}
              query={query}
              selectedUnitId={selectedUnit?.id ?? null}
              onSelect={setSelectedUnitId}
              onDraftChange={updateDraft}
            />
          </Card>

          <Card title={t('editor.context')}>
            <ContextPanel
              unit={selectedUnit}
              projectId={project.id}
              glossary={glossary ?? []}
              onApplyAi={() => void handleApplyText(selectedUnit?.aiText ?? '')}
              onApplyMemory={(text) => void handleApplyText(text)}
              onToggleReviewed={(reviewed) => void handleToggleReviewed(reviewed)}
              onRetranslate={() => void handleRetranslate()}
            />
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={confirmReplace}
        title={t('editor.replaceConfirmTitle')}
        body={t('editor.replaceConfirmBody', { count: replaceCount })}
        confirmLabel={t('editor.replaceAll')}
        onConfirm={() => void handleReplace()}
        onCancel={() => setConfirmReplace(false)}
      />
    </div>
  );
}
