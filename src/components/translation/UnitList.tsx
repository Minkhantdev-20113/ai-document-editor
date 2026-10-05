import { formatDateTime } from '../../core/utils/time';
import type { TranslationUnit } from '../../db/entities';
import { useT } from '../../i18n/I18nProvider';
import { Textarea } from '../ui/Form';
import { EmptyState } from '../ui/EmptyState';
import { Badge, UnitStatusBadge } from '../ui/StatusBadge';
import type { EditorViewMode } from './WorkspaceToolbar';

interface UnitListProps {
  readonly units: readonly TranslationUnit[];
  /** Per-unit unsaved text keyed by unit id (autosaved by the page). */
  readonly drafts: Readonly<Record<string, string>>;
  readonly viewMode: EditorViewMode;
  readonly query: string;
  readonly selectedUnitId: string | null;
  readonly onSelect: (unitId: string) => void;
  readonly onDraftChange: (unitId: string, text: string) => void;
}

/**
 * Center column (Phase 4): the editable translation. Each row shows the
 * original, the translation (inline editing with drafts), unit status,
 * unresolved warnings and honest provenance - AI text vs manual edit.
 */
export function UnitList({
  units,
  drafts,
  viewMode,
  query,
  selectedUnitId,
  onSelect,
  onDraftChange,
}: UnitListProps) {
  const t = useT();

  if (units.length === 0) {
    return (
      <EmptyState
        icon="fileText"
        title={query.trim() !== '' ? t('editor.noSearchResults') : t('editor.unitsEmpty')}
        body={query.trim() !== '' ? undefined : t('editor.unitsEmptyHint')}
      />
    );
  }

  return (
    <div className="stack stack-3" role="list">
      {units.map((unit) => {
        const draft = drafts[unit.id];
        const current = draft ?? unit.translatedText ?? '';
        const provenance = unit.editedAt
          ? `${t('editor.manualEdit')} · ${formatDateTime(unit.editedAt)}`
          : unit.provider
            ? `${t('editor.aiProduced')} · ${unit.model ?? unit.provider}`
            : null;
        return (
          <div
            key={unit.id}
            role="listitem"
            className="unit-row"
            data-selected={unit.id === selectedUnitId}
            onClick={() => onSelect(unit.id)}
          >
            <div className="row row-between">
              <div className="row row-2">
                <span className="mono text-xs subtle">#{unit.orderIndex + 1}</span>
                <UnitStatusBadge status={unit.status} />
                {(unit.warnings ?? []).map((warning) => (
                  <Badge key={warning.code} tone="warning" title={warning.detail}>
                    {t(`validation.${warning.code}`)}
                  </Badge>
                ))}
              </div>
              {provenance && <span className="text-xs subtle">{provenance}</span>}
            </div>

            {viewMode !== 'translation' && (
              <div className="stack stack-1">
                <span className="text-xs subtle">{t('editor.original')}</span>
                <p className="text-sm unit-source">{unit.sourceText}</p>
              </div>
            )}

            {viewMode !== 'source' && (
              <Textarea
                aria-label={`${t('editor.translation')} #${unit.orderIndex + 1}`}
                value={current}
                placeholder={t('editor.notTranslated')}
                rows={3}
                onFocus={() => onSelect(unit.id)}
                onChange={(event) => onDraftChange(unit.id, event.target.value)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
