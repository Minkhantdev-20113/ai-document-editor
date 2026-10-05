import { useEffect, useRef, useState, type ReactNode } from 'react';
import { APP_PHASE, APP_PHASE_TOTAL, APP_VERSION } from '../config/appConfig';
import { LANGUAGES, languageLabel } from '../config/languages';
import { toAppError } from '../core/errors/appError';
import { formatDateTime } from '../core/utils/time';
import type { ErrorLogRecord } from '../db/entities';
import { BURMESE_FONTS, FONT_LABELS, LATIN_FONTS } from '../domain/export/fonts';
import { dataPortabilityService } from '../services/dataPortabilityService';
import { errorLogService } from '../services/errorLogService';
import { settingsService, type AppSettings } from '../services/settingsService';
import { syncService, type SyncStatusInfo } from '../services/syncService';
import { keyVault } from '../security/keyVault';
import { useCollection } from '../hooks/useAsyncData';
import { useDocumentTitle } from '../hooks/useSystem';
import { useSettings } from '../hooks/useSettings';
import { useT } from '../i18n/I18nProvider';
import { useToast } from '../state/ToastProvider';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/Modal';
import { Icon } from '../components/ui/Icon';
import { Input, Select, Switch } from '../components/ui/Form';
import { Notice } from '../components/ui/Notice';
import { PageHeader } from '../components/ui/PageHeader';
import { LoadingBlock } from '../components/ui/Progress';

type SectionId = 'appearance' | 'language' | 'behavior' | 'data' | 'sync' | 'diagnostics';

const SECTIONS: readonly { id: SectionId; labelKey: string }[] = [
  { id: 'appearance', labelKey: 'settings.appearance' },
  { id: 'language', labelKey: 'settings.languageSection' },
  { id: 'behavior', labelKey: 'settings.behavior' },
  { id: 'data', labelKey: 'settings.data' },
  { id: 'sync', labelKey: 'settings.sync' },
  { id: 'diagnostics', labelKey: 'settings.diagnostics' },
];

const AUTO_LOCK_OPTIONS = [5, 15, 30, 60, 240].map((minutes) => ({
  value: minutes,
  label: `${minutes}`,
}));

const LANGUAGE_OPTIONS = LANGUAGES.map((language) => ({
  value: language.code,
  label: languageLabel(language.code),
}));

function SettingRow({
  label,
  hint,
  control,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly control: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div>
        <div className="setting-row__label">{label}</div>
        {hint && <div className="setting-row__hint">{hint}</div>}
      </div>
      <div className="setting-row__control">{control}</div>
    </div>
  );
}

/** Application preferences, local data tools and diagnostics. */
export function SettingsPage() {
  const t = useT();
  const toast = useToast();
  useDocumentTitle(t('settings.title'));
  const { settings, set } = useSettings();
  const [section, setSection] = useState<SectionId>('appearance');
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const { data: errors, reload: reloadErrors } = useCollection<ErrorLogRecord[]>(
    () => errorLogService.list(25),
    [],
    ['errors:changed'],
  );
  const { data: syncStatus, reload: reloadSync } = useCollection<SyncStatusInfo>(
    () => syncService.status(),
    [],
    ['sync:changed', 'settings:changed'],
  );

  useEffect(() => {
    keyVault.setAutoLock(settings.vaultAutoLockMs);
  }, [settings.vaultAutoLockMs]);

  async function run(task: () => Promise<void>, successTitle?: string) {
    setBusy(true);
    try {
      await task();
      if (successTitle) toast.success(successTitle);
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    } finally {
      setBusy(false);
    }
  }

  async function handleImport(file: File) {
    try {
      const text = await file.text();
      const result = await dataPortabilityService.importBundle(text);
      toast.success(t('settings.importedToast'), `${result.records}`);
    } catch {
      toast.error(t('toast.error'), t('settings.importFailed'));
    }
  }

  async function handleClearAll() {
    await run(async () => {
      await dataPortabilityService.clearAllLocalData();
      setConfirmClear(false);
      toast.success(t('settings.clearedToast'));
      reloadErrors();
      reloadSync();
    });
  }

  return (
    <div className="page">
      <PageHeader
        title={t('settings.title')}
        subtitle={t('settings.subtitle')}
        actions={
          <span className="text-xs subtle">
            {t('settings.version')} {APP_VERSION} · {t('app.phase', { phase: APP_PHASE, total: APP_PHASE_TOTAL })}
          </span>
        }
      />

      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('settings.title')}>
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={['settings-nav__item', section === item.id ? 'is-active' : ''].filter(Boolean).join(' ')}
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => setSection(item.id)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </nav>

        <div className="stack stack-6">
          {section === 'appearance' && (
            <Card title={t('settings.appearance')}>
              <SettingRow
                label={t('theme.label')}
                control={
                  <div className="segmented" role="group" aria-label={t('theme.label')}>
                    {(['light', 'dark', 'system'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={['segmented__item', settings.theme === mode ? 'is-active' : '']
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() => set('theme', mode)}
                      >
                        {t(`theme.${mode}`)}
                      </button>
                    ))}
                  </div>
                }
              />
              <SettingRow
                label={t('common.language')}
                hint={t('settings.languageHint')}
                control={
                  <div className="segmented" role="group" aria-label={t('common.language')}>
                    <button
                      type="button"
                      lang="my"
                      className={['segmented__item', settings.language === 'my' ? 'is-active' : '']
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => set('language', 'my')}
                    >
                      မြန်မာ
                    </button>
                    <button
                      type="button"
                      lang="en"
                      className={['segmented__item', settings.language === 'en' ? 'is-active' : '']
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => set('language', 'en')}
                    >
                      EN
                    </button>
                  </div>
                }
              />
            </Card>
          )}

          {section === 'language' && (
            <Card title={t('settings.languages')}>
              <SettingRow
                label={t('projects.sourceLanguage')}
                control={
                  <Select
                    value={settings.defaultSourceLanguage}
                    onChange={(event) => set('defaultSourceLanguage', event.target.value)}
                    options={LANGUAGE_OPTIONS}
                    aria-label={t('projects.sourceLanguage')}
                  />
                }
              />
              <SettingRow
                label={t('projects.targetLanguage')}
                hint={t('settings.languageHint')}
                control={
                  <Select
                    value={settings.defaultTargetLanguage}
                    onChange={(event) => set('defaultTargetLanguage', event.target.value)}
                    options={LANGUAGE_OPTIONS}
                    aria-label={t('projects.targetLanguage')}
                  />
                }
              />
            </Card>
          )}

          {section === 'behavior' && (
            <Card title={t('settings.behavior')}>
              <SettingRow
                label={t('settings.queueConcurrency')}
                hint={t('settings.queueConcurrencyHint')}
                control={
                  <Input
                    type="number"
                    min={1}
                    max={8}
                    value={settings.queueConcurrency}
                    onChange={(event) => set('queueConcurrency', clampNumber(event.target.value, 1, 8))}
                    aria-label={t('settings.queueConcurrency')}
                  />
                }
              />
              <SettingRow
                label={t('settings.jobMaxAttempts')}
                control={
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={settings.jobMaxAttempts}
                    onChange={(event) => set('jobMaxAttempts', clampNumber(event.target.value, 1, 10))}
                    aria-label={t('settings.jobMaxAttempts')}
                  />
                }
              />
              <SettingRow
                label={t('settings.autoLock')}
                hint={t('settings.autoLockHint')}
                control={
                  <div className="row row-2">
                    <Select
                      value={String(Math.round(settings.vaultAutoLockMs / 60_000))}
                      onChange={(event) => set('vaultAutoLockMs', Number(event.target.value) * 60_000)}
                      options={AUTO_LOCK_OPTIONS.map((option) => ({
                        value: String(option.value),
                        label: `${option.value} ${t('settings.minutesShort')}`,
                      }))}
                      aria-label={t('settings.autoLock')}
                    />
                  </div>
                }
              />
              <SettingRow
                label={t('settings.retainErrors')}
                hint={t('settings.retainErrorsHint')}
                control={
                  <Switch
                    checked={settings.retainErrorLogs}
                    onChange={(checked) => set('retainErrorLogs', checked)}
                    label={t('common.enabled')}
                  />
                }
              />
              <SettingRow
                label={t('settings.usageTracking')}
                hint={t('settings.usageTrackingHint')}
                control={
                  <Switch
                    checked={settings.usageTrackingEnabled}
                    onChange={(checked) => set('usageTrackingEnabled', checked)}
                    label={t('common.enabled')}
                  />
                }
              />
            </Card>
          )}

          {section === 'behavior' && (
            <Card title={t('settings.exportFonts')}>
              <SettingRow
                label={t('settings.exportLatinFont')}
                hint={t('settings.exportFontsHint')}
                control={
                  <Select
                    value={settings.exportLatinFont}
                    onChange={(event) =>
                      set('exportLatinFont', event.target.value as AppSettings['exportLatinFont'])
                    }
                    options={LATIN_FONTS.map((id) => ({ value: id, label: FONT_LABELS[id] }))}
                    aria-label={t('settings.exportLatinFont')}
                  />
                }
              />
              <SettingRow
                label={t('settings.exportBurmeseFont')}
                control={
                  <Select
                    value={settings.exportBurmeseFont}
                    onChange={(event) =>
                      set('exportBurmeseFont', event.target.value as AppSettings['exportBurmeseFont'])
                    }
                    options={BURMESE_FONTS.map((id) => ({ value: id, label: FONT_LABELS[id] }))}
                    aria-label={t('settings.exportBurmeseFont')}
                  />
                }
              />
            </Card>
          )}

          {section === 'data' && (
            <>
              <Card title={t('settings.data')}>
                <SettingRow
                  label={t('settings.exportData')}
                  hint={t('settings.exportDataHint')}
                  control={
                    <Button
                      icon={<Icon name="download" size={14} />}
                      loading={busy}
                      onClick={() => void run(() => dataPortabilityService.downloadExport(), t('settings.exportedToast'))}
                    >
                      {t('common.export')}
                    </Button>
                  }
                />
                <SettingRow
                  label={t('settings.importData')}
                  hint={t('settings.importDataHint')}
                  control={
                    <>
                      <input
                        ref={fileRef}
                        type="file"
                        accept="application/json,.json"
                        className="sr-only"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void handleImport(file);
                          event.target.value = '';
                        }}
                      />
                      <Button icon={<Icon name="download" size={14} />} onClick={() => fileRef.current?.click()}>
                        {t('common.import')}
                      </Button>
                    </>
                  }
                />
                <SettingRow
                  label={t('settings.resetSettings')}
                  hint={t('settings.resetSettingsHint')}
                  control={
                    <Button
                      loading={busy}
                      onClick={() => void run(async () => {
                        await settingsService.reset();
                      }, t('common.saved'))}
                    >
                      {t('common.reset')}
                    </Button>
                  }
                />
                <div className="setting-row">
                  <div>
                    <div className="setting-row__label">{t('settings.clearData')}</div>
                    <div className="setting-row__hint">{t('settings.clearDataHint')}</div>
                  </div>
                  <div className="setting-row__control">
                    <Button variant="danger" icon={<Icon name="trash" size={14} />} onClick={() => setConfirmClear(true)}>
                      {t('common.clear')}
                    </Button>
                  </div>
                </div>
              </Card>
            </>
          )}

          {section === 'sync' && (
            <Card title={t('settings.sync')}>
              <div className="stack stack-4">
                <Notice tone="info" icon="database">
                  {t('settings.syncHint')}
                </Notice>
                <Input
                  label={t('settings.syncEndpoint')}
                  placeholder={t('settings.syncEndpointPlaceholder')}
                  value={settings.syncEndpoint ?? ''}
                  optional
                  onChange={(event) => set('syncEndpoint', event.target.value.trim() || null)}
                />
                <Switch
                  checked={settings.syncEnabled}
                  onChange={(checked) => set('syncEnabled', checked)}
                  label={t('settings.syncEnabled')}
                />
                <div className="row row-2">
                  <Button
                    loading={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await syncService.flush();
                        reloadSync();
                        toast.success(t('settings.syncStatus'), String(result.sent));
                      })
                    }
                  >
                    {t('settings.syncRun')}
                  </Button>
                  <span className="text-xs muted">
                    {t('settings.syncStatus')}:{' '}
                    {!syncStatus?.configured
                      ? t('settings.syncUnconfigured')
                      : `${syncStatus.pending} · ${t('settings.syncLocalOnly')}`}
                  </span>
                </div>
              </div>
            </Card>
          )}

          {section === 'diagnostics' && (
            <Card
              title={t('settings.recentErrors')}
              actions={
                <Button size="sm" variant="ghost" onClick={() => void run(() => errorLogService.clear())}>
                  {t('common.clear')}
                </Button>
              }
            >
              {!errors ? (
                <LoadingBlock>{t('common.loading')}</LoadingBlock>
              ) : errors.length === 0 ? (
                <p className="muted">{t('settings.noErrors')}</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('common.created')}</th>
                        <th>{t('errors.code')}</th>
                        <th>{t('common.details')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {errors.map((record) => (
                        <tr key={record.id}>
                          <td className="text-xs nowrap">{formatDateTime(record.occurredAt)}</td>
                          <td className="mono text-xs">{record.code ?? record.level}</td>
                          <td className="text-xs">{record.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title={t('settings.clearConfirmTitle')}
        body={t('settings.clearConfirmBody')}
        confirmLabel={t('common.clear')}
        destructive
        busy={busy}
        onConfirm={() => void handleClearAll()}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}

function clampNumber(raw: string, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}
