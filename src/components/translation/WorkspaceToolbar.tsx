import { useT } from '../../i18n/I18nProvider';
import { Button } from '../ui/Button';
import { Input, SearchInput, Segmented } from '../ui/Form';
import { Badge, type BadgeTone } from '../ui/StatusBadge';

export type EditorViewMode = 'translation' | 'source' | 'both';
export type EditorSaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';

const STATUS_TEXT: Record<EditorSaveStatus, string> = {
  saved: 'editor.saved',
  unsaved: 'editor.unsaved',
  saving: 'editor.saving',
  error: 'editor.saveFailed',
};

const STATUS_TONE: Record<EditorSaveStatus, BadgeTone> = {
  saved: 'success',
  unsaved: 'warning',
  saving: 'info',
  error: 'danger',
};

interface WorkspaceToolbarProps {
  readonly viewMode: EditorViewMode;
  readonly onViewMode: (mode: EditorViewMode) => void;
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly replaceOpen: boolean;
  readonly onReplaceToggle: () => void;
  readonly replaceValue: string;
  readonly onReplaceValue: (value: string) => void;
  readonly onReplaceApply: () => void;
  readonly matchCount: number;
  /** Units whose translation text actually contains the search string. */
  readonly replaceCount: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly saveStatus: EditorSaveStatus;
}

/**
 * Editor toolbar (Phase 4): source/translation view toggle (incl.
 * side-by-side), search, replace, undo/redo and the live autosave status.
 */
export function WorkspaceToolbar({
  viewMode,
  onViewMode,
  query,
  onQuery,
  replaceOpen,
  onReplaceToggle,
  replaceValue,
  onReplaceValue,
  onReplaceApply,
  matchCount,
  replaceCount,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  saveStatus,
}: WorkspaceToolbarProps) {
  const t = useT();
  return (
    <div className="stack stack-2">
      <div className="row row-between editor-toolbar">
        <div className="row row-2">
          <Segmented<EditorViewMode>
            ariaLabel={t('editor.viewMode')}
            value={viewMode}
            options={[
              { value: 'translation', label: t('editor.viewTranslation') },
              { value: 'source', label: t('editor.viewSource') },
              { value: 'both', label: t('editor.viewBoth') },
            ]}
            onChange={onViewMode}
          />
          <SearchInput
            value={query}
            onChange={onQuery}
            placeholder={t('editor.searchPlaceholder')}
            ariaLabel={t('common.search')}
          />
        </div>
        <div className="row row-2">
          <Button size="sm" disabled={!canUndo} onClick={onUndo} title={t('editor.undo')}>
            {t('editor.undo')}
          </Button>
          <Button size="sm" disabled={!canRedo} onClick={onRedo} title={t('editor.redo')}>
            {t('editor.redo')}
          </Button>
          <Button
            size="sm"
            variant={replaceOpen ? 'secondary' : 'ghost'}
            onClick={onReplaceToggle}
          >
            {t('editor.replace')}
          </Button>
          <Badge tone={STATUS_TONE[saveStatus]}>{t(STATUS_TEXT[saveStatus])}</Badge>
        </div>
      </div>

      {replaceOpen && (
        <div className="row row-2">
          <label className="text-xs subtle" htmlFor="editor-replace-input">
            {t('editor.replaceWith')}
          </label>
          <Input
            id="editor-replace-input"
            value={replaceValue}
            onChange={(event) => onReplaceValue(event.target.value)}
            placeholder={query}
          />
          <Button
            variant="primary"
            size="sm"
            disabled={replaceCount === 0}
            onClick={onReplaceApply}
          >
            {t('editor.replaceAll')} ({replaceCount})
          </Button>
        </div>
      )}

      {query.trim() !== '' && (
        <span className="text-xs subtle">{t('editor.matchCount', { count: matchCount })}</span>
      )}
    </div>
  );
}
