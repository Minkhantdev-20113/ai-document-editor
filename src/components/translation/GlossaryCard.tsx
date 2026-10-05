import { useState } from 'react';
import type { GlossaryEntry } from '../../db/entities';
import { toAppError } from '../../core/errors/appError';
import { useCollection } from '../../hooks/useAsyncData';
import { useT } from '../../i18n/I18nProvider';
import { glossaryService } from '../../services/glossaryService';
import { useToast } from '../../state/ToastProvider';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Field, Input, Textarea } from '../ui/Form';
import { EmptyState } from '../ui/EmptyState';
import { ConfirmDialog } from '../ui/Modal';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/StatusBadge';

interface GlossaryCardProps {
  readonly projectId: string;
}

/**
 * Terminology glossary CRUD (Phase 4): English source term -> preferred
 * Burmese translation (+ optional forbidden wording and notes). Rules ride
 * along in every translation prompt and drive the glossary-violation check.
 */
export function GlossaryCard({ projectId }: GlossaryCardProps) {
  const t = useT();
  const toast = useToast();

  const { data: entries } = useCollection(
    () => glossaryService.list(projectId),
    [projectId],
    ['glossary:changed'],
  );

  const [sourceTerm, setSourceTerm] = useState('');
  const [preferred, setPreferred] = useState('');
  const [forbidden, setForbidden] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<GlossaryEntry | null>(null);

  const canAdd = sourceTerm.trim() !== '' && preferred.trim() !== '' && !busy;

  async function handleAdd(): Promise<void> {
    if (!canAdd) return;
    setBusy(true);
    try {
      await glossaryService.create(projectId, {
        sourceTerm: sourceTerm.trim(),
        preferredTranslation: preferred.trim(),
        forbiddenTranslation: forbidden.trim() || null,
        notes: notes.trim() || null,
      });
      setSourceTerm('');
      setPreferred('');
      setForbidden('');
      setNotes('');
      toast.success(t('glossary.added'));
    } catch (error) {
      // Validation/duplicate messages are specific - show them verbatim.
      toast.error(t('toast.error'), toAppError(error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(entry: GlossaryEntry): Promise<void> {
    setPendingRemove(null);
    try {
      await glossaryService.remove(entry.id);
      toast.success(t('glossary.removed'));
    } catch (error) {
      toast.error(t('toast.error'), toAppError(error).message);
    }
  }

  const list = entries ?? [];

  return (
    <Card
      title={t('glossary.title')}
      subtitle={t('glossary.subtitle', { count: list.length })}
    >
      <div className="stack stack-4">
        <div className="stack stack-2">
          <Field label={t('glossary.sourceTerm')}>
            <Input
              value={sourceTerm}
              onChange={(event) => setSourceTerm(event.target.value)}
              placeholder="API"
            />
          </Field>
          <Field label={t('glossary.preferred')}>
            <Input
              value={preferred}
              onChange={(event) => setPreferred(event.target.value)}
              placeholder={t('glossary.preferredPlaceholder')}
            />
          </Field>
          <Field label={t('glossary.forbidden')} optional>
            <Input
              value={forbidden}
              onChange={(event) => setForbidden(event.target.value)}
              placeholder={t('glossary.forbiddenPlaceholder')}
            />
          </Field>
          <Field label={t('glossary.notes')} optional>
            <Textarea
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
          <div className="row row-2">
            <Button
              variant="primary"
              icon={<Icon name="plus" size={14} />}
              loading={busy}
              disabled={!canAdd}
              onClick={() => void handleAdd()}
            >
              {t('glossary.add')}
            </Button>
          </div>
        </div>

        {list.length === 0 ? (
          <EmptyState icon="fileText" title={t('glossary.empty')} body={t('glossary.emptyHint')} plain />
        ) : (
          <ul className="stack stack-2" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {list.map((entry) => (
              <li key={entry.id} className="row row-between" style={{ gap: 'var(--space-2)' }}>
                <div className="stack stack-1">
                  <span className="text-sm">
                    <span className="mono text-xs">{entry.sourceTerm}</span> →{' '}
                    <strong>{entry.preferredTranslation}</strong>
                  </span>
                  <span className="row row-2" style={{ flexWrap: 'wrap' }}>
                    {entry.forbiddenTranslation && (
                      <Badge tone="warning">
                        {t('glossary.forbidden')}: {entry.forbiddenTranslation}
                      </Badge>
                    )}
                    {entry.notes && <span className="text-xs subtle">{entry.notes}</span>}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="trash" size={14} />}
                  aria-label={t('glossary.remove')}
                  title={t('glossary.remove')}
                  onClick={() => setPendingRemove(entry)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={pendingRemove !== null}
        title={t('glossary.removeTitle')}
        body={t('glossary.removeBody', { term: pendingRemove?.sourceTerm ?? '' })}
        destructive
        confirmLabel={t('glossary.remove')}
        onConfirm={() => {
          if (pendingRemove) void handleRemove(pendingRemove);
        }}
        onCancel={() => setPendingRemove(null)}
      />
    </Card>
  );
}
