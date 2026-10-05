import { useState } from 'react';
import { toAppError } from '../../core/errors/appError';
import { useT } from '../../i18n/I18nProvider';
import { serializeOverlay, type CatalogOverlayEntry } from '../../providers/modelRegistry';
import { modelCatalogService } from '../../services/modelCatalogService';
import { useCollection } from '../../hooks/useAsyncData';
import { useToast } from '../../state/ToastProvider';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Icon } from '../ui/Icon';
import { Modal } from '../ui/Modal';
import { Notice } from '../ui/Notice';
import { Textarea } from '../ui/Form';

/**
 * Model-catalog import/export: the registry is data, so it stays updateable.
 *
 * Imports go through `validateOverlay` - unknown providers, unknown models or
 * unknown fields are rejected with the exact reason before anything persists.
 */
export function CatalogCard({ onImported }: { readonly onImported: () => void }) {
  const t = useT();
  const toast = useToast();
  const { data: entries, reload } = useCollection<CatalogOverlayEntry[]>(
    () => modelCatalogService.load(),
    [],
    ['providers:changed'],
  );

  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleExport() {
    const blob = new Blob([serializeOverlay(entries ?? [])], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'model-catalog.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function handleImport() {
    setBusy(true);
    setError(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        setError(t('registry.catalogInvalid'));
        return;
      }
      const count = await modelCatalogService.importJson(parsed);
      toast.success(t('registry.catalogImported', { count }));
      setOpen(false);
      setText('');
      reload();
      onImported();
    } catch (caught) {
      const appError = toAppError(caught);
      // Validation failures carry the exact reason (entry index + field).
      setError(appError.code === 'import_invalid' ? appError.message : t(`errors.${appError.code}`));
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    setBusy(true);
    try {
      await modelCatalogService.clear();
      toast.success(t('registry.catalogResetToast'));
      reload();
      onImported();
    } catch (caught) {
      toast.error(t('toast.error'), t(`errors.${toAppError(caught).code}`));
    } finally {
      setBusy(false);
    }
  }

  const count = entries?.length ?? 0;

  return (
    <Card title={t('registry.catalogTitle')} subtitle={t('registry.catalogEntries', { count })}>
      <div className="stack stack-4">
        <p className="text-xs muted">{t('registry.catalogHint')}</p>
        <div className="row row-2">
          <Button icon={<Icon name="download" size={14} />} onClick={handleExport} disabled={busy}>
            {t('registry.catalogExport')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setError(null);
              setOpen(true);
            }}
            disabled={busy}
          >
            {t('registry.catalogImport')}
          </Button>
          <Button variant="danger" loading={busy} disabled={count === 0} onClick={() => void handleReset()}>
            {t('registry.catalogReset')}
          </Button>
        </div>
      </div>

      <Modal
        open={open}
        title={t('registry.catalogImport')}
        description={t('registry.catalogHint')}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={() => void handleImport()}>
              {t('registry.catalogImport')}
            </Button>
          </>
        }
      >
        <div className="stack stack-4">
          {error && <Notice tone="warning">{error}</Notice>}
          <Textarea
            rows={10}
            value={text}
            placeholder={t('registry.catalogPlaceholder')}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
      </Modal>
    </Card>
  );
}
