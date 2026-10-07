import { useState } from 'react';
import { formatDateTime } from '../../core/utils/time';
import type { GlossaryEntry, TranslationUnit } from '../../db/entities';
import { useCollection } from '../../hooks/useAsyncData';
import { useT } from '../../i18n/I18nProvider';
import { MEMORY_THRESHOLDS } from '../../domain/translationMemory';
import { translationMemoryService } from '../../services/translationMemoryService';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/Modal';
import { EmptyState } from '../ui/EmptyState';
import { Badge, UnitStatusBadge } from '../ui/StatusBadge';

interface ContextPanelProps {
  readonly unit: TranslationUnit | null;
  readonly projectId: string;
  readonly glossary: readonly GlossaryEntry[];
  readonly onApplyAi: () => void;
  readonly onApplyMemory: (text: string) => void;
  readonly onToggleReviewed: (reviewed: boolean) => void;
  readonly onRetranslate: () => void;
}

/**
 * Right rail (Phase 4): context for the selected unit - original text,
 * unresolved warnings, terminology (glossary rules that match this text),
 * AI suggestion (kept even after manual edits) and translation memory, plus
 * reviewed/retranslate actions. Suggestions apply only on explicit click.
 */
export function ContextPanel({
  unit,
  projectId,
  glossary,
  onApplyAi,
  onApplyMemory,
  onToggleReviewed,
  onRetranslate,
}: ContextPanelProps) {
  const t = useT();
  const [confirmRetranslate, setConfirmRetranslate] = useState(false);

  const { data: memory } = useCollection(
    async () =>
      unit
        ? translationMemoryService.suggest({
            projectId,
            sourceText: unit.sourceText,
            targetLanguage: unit.targetLanguage,
            excludeUnitId: unit.id,
            limit: 1,
            minScore: MEMORY_THRESHOLDS.suggest,
          })
        : [],
    [unit?.id, projectId],
    ['units:changed'],
  );

  if (!unit) {
    return <EmptyState icon="fileText" title={t('editor.selectUnit')} plain />;
  }

  const warnings = unit.warnings ?? [];
  const current = unit.translatedText ?? '';
  const aiDiffers = Boolean(unit.aiText) && (unit.aiText ?? '') !== current;
  const memoryMatch = (memory ?? [])[0];
  const memoryDiffers = memoryMatch !== undefined && memoryMatch.translation !== current;
  const terms = glossary.filter(
    (entry) =>
      entry.sourceTerm.trim() !== '' &&
      unit.sourceText.toLowerCase().includes(entry.sourceTerm.toLowerCase()),
  );

  return (
    <div className="stack stack-4">
      <div className="row row-2">
        <UnitStatusBadge status={unit.status} />
        {unit.editedAt && (
          <Badge tone="info">
            {`${t('editor.manualEdit')} · ${formatDateTime(unit.editedAt)}`}
          </Badge>
        )}
      </div>

      <div className="stack stack-2">
        <span className="text-xs subtle">{t('editor.original')}</span>
        <p className="text-sm">{unit.sourceText}</p>
      </div>

      {unit.error && (
        <div className="stack stack-2">
          <span className="text-xs subtle">{t('editor.failureReason')}</span>
          <p className="text-sm unit-failure__detail" title={unit.error.message}>
            {unit.error.message}
          </p>
        </div>
      )}

      <div className="stack stack-2">
        <span className="text-xs subtle">{t('editor.warnings')}</span>
        {warnings.length === 0 ? (
          <span className="text-sm muted">{t('editor.noWarnings')}</span>
        ) : (
          <div className="row row-2" style={{ flexWrap: 'wrap' }}>
            {warnings.map((warning) => (
              <Badge key={warning.code} tone="warning" title={warning.detail}>
                {t(`validation.${warning.code}`)}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {unit.aiText && (
        <div className="stack stack-2">
          <span className="text-xs subtle">
            {t('editor.aiSuggestion')}
            {unit.model ? ` · ${unit.model}` : ''}
          </span>
          <p className="text-sm">{unit.aiText}</p>
          {aiDiffers && (
            <Button size="sm" onClick={onApplyAi}>
              {t('editor.useAi')}
            </Button>
          )}
        </div>
      )}

      {memoryMatch && (
        <div className="stack stack-2">
          <span className="text-xs subtle">
            {t('editor.memorySuggestion')} ·{' '}
            {t('editor.memoryScore', { percent: Math.round(memoryMatch.score * 100) })}
          </span>
          <p className="text-sm">{memoryMatch.translation}</p>
          {memoryDiffers && (
            <Button size="sm" onClick={() => onApplyMemory(memoryMatch.translation)}>
              {t('editor.useMemory')}
            </Button>
          )}
        </div>
      )}

      <div className="stack stack-2">
        <span className="text-xs subtle">{t('editor.terminology')}</span>
        {terms.length === 0 ? (
          <span className="text-sm muted">{t('editor.terminologyEmpty')}</span>
        ) : (
          <ul className="stack stack-1" style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {terms.map((entry) => (
              <li key={entry.id} className="text-sm">
                <span className="mono text-xs">{entry.sourceTerm}</span> →{' '}
                <span>{entry.preferredTranslation}</span>
                {entry.forbiddenTranslation && (
                  <span className="text-xs subtle">
                    {' '}
                    ({t('editor.forbidden')}: {entry.forbiddenTranslation})
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="row row-2">
        <Button size="sm" onClick={() => onToggleReviewed(unit.status !== 'reviewed')}>
          {unit.status === 'reviewed' ? t('editor.unmarkReviewed') : t('editor.markReviewed')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirmRetranslate(true)}>
          {t('editor.retranslate')}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmRetranslate}
        title={t('editor.retranslateConfirmTitle')}
        body={t('editor.retranslateConfirmBody')}
        destructive
        confirmLabel={t('editor.retranslate')}
        onConfirm={() => {
          setConfirmRetranslate(false);
          onRetranslate();
        }}
        onCancel={() => setConfirmRetranslate(false)}
      />
    </div>
  );
}
