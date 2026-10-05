import { useState } from 'react';
import { SUPPORTED_EXPORT_FORMATS, type ExportFormat } from '../../config/appConfig';
import { toAppError } from '../../core/errors/appError';
import type { Project } from '../../db/entities';
import { useT } from '../../i18n/I18nProvider';
import { startExport } from '../../jobs/actions';
import { useToast } from '../../state/ToastProvider';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Select, Switch } from '../ui/Form';

export interface ExportStartFormProps {
  readonly projects: readonly Project[];
}

/**
 * Format/option picker plus the button that queues an export job.
 *
 * The job (layout + rendering) runs in the queue and the background worker;
 * this form only validates the selection and enqueues, so the UI stays
 * responsive for a 500-page document.
 */
export function ExportStartForm({ projects }: ExportStartFormProps) {
  const t = useT();
  const toast = useToast();
  const [projectId, setProjectId] = useState('');
  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [keepLayout, setKeepLayout] = useState(true);
  const [busy, setBusy] = useState(false);

  const exportable = projects.filter((project) => project.documentId !== null);
  const selected =
    exportable.find((project) => project.id === projectId) ?? exportable[0] ?? null;

  async function handleStart() {
    if (!selected) return;
    setBusy(true);
    try {
      const { created } = await startExport(selected, { format, keepLayout });
      const detail = `${selected.name} · ${format.toUpperCase()}`;
      if (created) {
        toast.success(t('exportCenter.queued'), detail);
      } else {
        // A job for this document is already queued or running: say so
        // instead of pretending a second one was added.
        toast.info(t('exportCenter.alreadyRunning'), detail);
      }
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack stack-4">
      <Select
        label={t('exportCenter.project')}
        placeholder={t('exportCenter.selectProject')}
        value={selected?.id ?? ''}
        onChange={(event) => setProjectId(event.target.value)}
        options={exportable.map((project) => ({ value: project.id, label: project.name }))}
        disabled={exportable.length === 0}
      />
      <Select
        label={t('exportCenter.format')}
        value={format}
        onChange={(event) => setFormat(event.target.value as ExportFormat)}
        options={SUPPORTED_EXPORT_FORMATS.map((item) => ({ value: item, label: item.toUpperCase() }))}
        hint={t('exportCenter.formatHint')}
      />
      <Switch
        checked={keepLayout}
        onChange={setKeepLayout}
        label={t('exportCenter.keepLayout')}
        hint={keepLayout ? t('exportCenter.keepLayoutHint') : t('exportCenter.reflowHint')}
        // The layout plan only applies to PDF; the reflowed formats ignore it.
        disabled={format !== 'pdf'}
      />
      <Button
        variant="primary"
        icon={<Icon name="download" size={14} />}
        loading={busy}
        disabled={!selected}
        onClick={() => void handleStart()}
      >
        {t('exportCenter.startExport')}
      </Button>
      <p className="text-xs subtle">{t('exportCenter.resumeNote')}</p>
    </div>
  );
}
