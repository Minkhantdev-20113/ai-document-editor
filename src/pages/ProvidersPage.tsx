import { useMemo, useState } from 'react';
import { toAppError } from '../core/errors/appError';
import type { ProviderConfig } from '../db/entities';
import { modelSpecs, type CatalogOverlayEntry, type ModelSpec } from '../providers/modelRegistry';
import { listProviderDescriptors } from '../providers/registry';
import type { ProviderDescriptor, ProviderId } from '../providers/types';
import { apiKeyService } from '../services/apiKeyService';
import { modelCatalogService } from '../services/modelCatalogService';
import { providerConfigService } from '../services/providerConfigService';
import { useCollection } from '../hooks/useAsyncData';
import { useDocumentTitle } from '../hooks/useSystem';
import { useT } from '../i18n/I18nProvider';
import { useToast } from '../state/ToastProvider';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Icon } from '../components/ui/Icon';
import { Input, Select, Switch } from '../components/ui/Form';
import { Notice } from '../components/ui/Notice';
import { PageHeader } from '../components/ui/PageHeader';
import { CatalogCard } from '../components/providers/CatalogCard';
import { ModelRegistryTable } from '../components/providers/ModelRegistryTable';

interface ProvidersData {
  readonly configs: ProviderConfig[];
  readonly keyCounts: Record<string, number>;
}

function capabilityKeys(descriptor: ProviderDescriptor): readonly string[] {
  const keys: string[] = [];
  if (descriptor.capabilities.chat) keys.push('providers.capabilityChat');
  if (descriptor.capabilities.vision) keys.push('providers.capabilityVision');
  if (descriptor.capabilities.jsonMode) keys.push('providers.capabilityJson');
  if (descriptor.capabilities.streaming) keys.push('providers.capabilityStreaming');
  return keys;
}

interface ProviderCardProps {
  readonly descriptor: ProviderDescriptor;
  readonly config: ProviderConfig | undefined;
  readonly keyCount: number;
  readonly onChanged: (providerId: ProviderId, patch: Partial<ProviderConfig>) => void;
  readonly onSave: (providerId: ProviderId) => void;
  readonly saving: ProviderId | null;
  readonly error: string | null;
}

/** Local editable view of one provider's configuration. */
function ProviderCard({ descriptor, config, keyCount, onChanged, onSave, saving, error }: ProviderCardProps) {
  const t = useT();
  const baseUrl = config?.baseUrl ?? '';
  const model = config?.defaultModel ?? descriptor.models[0]?.id ?? '';

  return (
    <article className="provider-card">
      <header className="provider-card__head">
        <div>
          <div className="provider-card__name">{descriptor.label}</div>
          <div className="provider-card__url">{baseUrl || t('providers.baseUrlHint')}</div>
        </div>
        <Switch
          checked={config?.enabled ?? false}
          onChange={(checked) => onChanged(descriptor.id, { enabled: checked })}
          label={t('providers.enabled')}
        />
      </header>

      <div className="stack stack-3">
        <Input
          label={t('providers.baseUrl')}
          hint={t('providers.baseUrlHint')}
          value={baseUrl}
          placeholder={descriptor.requiresBaseUrl ? 'https://api.example.com/v1' : ''}
          onChange={(event) => onChanged(descriptor.id, { baseUrl: event.target.value })}
        />
        <Select
          label={t('providers.defaultModel')}
          value={model}
          onChange={(event) => onChanged(descriptor.id, { defaultModel: event.target.value })}
          options={descriptor.models.map((entry) => ({ value: entry.id, label: entry.label }))}
        />
      </div>

      <div className="stack stack-2">
        <span className="text-xs muted">{t('providers.capabilities')}</span>
        <div className="capabilities">
          {capabilityKeys(descriptor).map((key) => (
            <span key={key} className="chip">
              {t(key)}
            </span>
          ))}
        </div>
      </div>

      <div className="stack stack-2">
        <span className="text-xs muted">{t('providers.rateLimit')}</span>
        <div className="text-xs">
          <span className="mono">{descriptor.rateLimit.basis}</span>
          {typeof descriptor.rateLimit.requestsPerMinute === 'number' && (
            <span> · {descriptor.rateLimit.requestsPerMinute} RPM</span>
          )}
        </div>
        <p className="text-xs subtle">{t('providers.rateLimitNote')}</p>
        <p className="text-xs subtle">{descriptor.rateLimit.notes}</p>
      </div>

      {keyCount === 0 && (
        <Notice tone="warning" icon="key">
          <div>{t('providers.noKeys')}</div>
          <div className="text-xs">{t('providers.noKeysHint')}</div>
        </Notice>
      )}

      {error && <Notice tone="warning">{error}</Notice>}

      <footer className="row row-between">
        <span className="row row-2 text-xs subtle">
          <a href={descriptor.docsUrl} target="_blank" rel="noreferrer noopener" className="row row-1">
            {t('providers.openDocs')} <Icon name="externalLink" size={12} />
          </a>
          <a href={descriptor.keyUrl} target="_blank" rel="noreferrer noopener" className="row row-1">
            {t('providers.getKey')} <Icon name="externalLink" size={12} />
          </a>
        </span>
        <Button
          variant="primary"
          size="sm"
          loading={saving === descriptor.id}
          onClick={() => onSave(descriptor.id)}
        >
          {t('common.save')}
        </Button>
      </footer>
    </article>
  );
}

/** Provider adapters: endpoint, default model, enablement and rate-limit policy. */
export function ProvidersPage() {
  const t = useT();
  const toast = useToast();
  useDocumentTitle(t('providers.title'));

  const { data, loading, reload } = useCollection<ProvidersData>(
    async () => {
      const descriptors = listProviderDescriptors();
      const configs: ProviderConfig[] = [];
      for (const descriptor of descriptors) {
        configs.push(await providerConfigService.ensure(descriptor.id));
      }
      const keyCounts: Record<string, number> = {};
      for (const descriptor of descriptors) {
        keyCounts[descriptor.id] = (await apiKeyService.listForProvider(descriptor.id)).length;
      }
      return { configs, keyCounts };
    },
    [],
    ['providers:changed', 'apiKeys:changed'],
  );

  const { data: overlay, reload: reloadCatalog } = useCollection<CatalogOverlayEntry[]>(
    () => modelCatalogService.load(),
    [],
    ['providers:changed'],
  );

  const [edits, setEdits] = useState<Record<string, Partial<ProviderConfig>>>({});
  const [saving, setSaving] = useState<ProviderId | null>(null);
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});

  const descriptors = listProviderDescriptors();

  // Drafts are derived: loaded config merged with the not-yet-saved edits, so
  // a background reload of the data never needs to overwrite local state.
  const drafts = useMemo(() => {
    const map: Record<string, ProviderConfig> = {};
    for (const config of data?.configs ?? []) {
      map[config.providerId] = { ...config, ...edits[config.providerId] };
    }
    return map;
  }, [data, edits]);

  // Registry rows: built-in facts + imported overlay + this provider's
  // enabled-model list, in catalog order.
  const registrySpecs = useMemo(
    () =>
      descriptors.flatMap((descriptor) =>
        modelSpecs(descriptor.id, {
          enabledModels: drafts[descriptor.id]?.enabledModels ?? null,
          overlay: overlay ?? [],
        }),
      ),
    [descriptors, drafts, overlay],
  );

  function resolveById(providerId: ProviderId): ProviderConfig | undefined {
    return drafts[providerId] ?? data?.configs.find((config) => config.providerId === providerId);
  }

  function handleChange(providerId: ProviderId, patch: Partial<ProviderConfig>) {
    setEdits((previous) => ({ ...previous, [providerId]: { ...previous[providerId], ...patch } }));
  }

  async function handleToggleModel(spec: ModelSpec, enabled: boolean) {
    const config = drafts[spec.providerId];
    const current =
      config?.enabledModels ?? modelSpecs(spec.providerId).map((entry) => entry.modelId);
    const next = enabled
      ? current.includes(spec.modelId)
        ? current
        : [...current, spec.modelId]
      : current.filter((modelId) => modelId !== spec.modelId);
    // The table already blocks emptying the list; this is the hard guard.
    if (next.length === 0) return;
    try {
      await providerConfigService.save(spec.providerId, { enabledModels: next });
      toast.success(t('registry.enabledToast'));
      reload();
    } catch (error) {
      const message = t(`errors.${toAppError(error).code}`);
      toast.error(t('toast.error'), message);
    }
  }

  async function handleSave(providerId: ProviderId) {
    const draft = resolveById(providerId);
    if (!draft) return;
    setSaving(providerId);
    setSaveErrors((previous) => ({ ...previous, [providerId]: '' }));
    try {
      await providerConfigService.save(providerId, {
        enabled: draft.enabled,
        baseUrl: draft.baseUrl,
        defaultModel: draft.defaultModel,
      });
      // The saved values are the new baseline; drop the local edit for this provider.
      setEdits((previous) => {
        const next = { ...previous };
        delete next[providerId];
        return next;
      });
      toast.success(t('providers.savedToast'));
    } catch (error) {
      const message = t(`errors.${toAppError(error).code}`);
      setSaveErrors((previous) => ({ ...previous, [providerId]: message }));
      toast.error(t('toast.error'), message);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="page page--wide">
      <PageHeader title={t('providers.title')} subtitle={t('providers.subtitle')} />

      <Notice tone="info" icon="cpu">
        {t('providers.phaseNote')}
      </Notice>

      {!loading && !data ? (
        <Notice tone="warning">{t('errors.db_unavailable')}</Notice>
      ) : (
        <>
          <div className="provider-grid">
            {descriptors.map((descriptor) => (
              <ProviderCard
                key={descriptor.id}
                descriptor={descriptor}
                config={resolveById(descriptor.id)}
                keyCount={data?.keyCounts[descriptor.id] ?? 0}
                onChanged={handleChange}
                onSave={(providerId) => void handleSave(providerId)}
                saving={saving}
                error={saveErrors[descriptor.id] || null}
              />
            ))}
          </div>

          <Card title={t('registry.title')} subtitle={t('registry.subtitle')}>
            <ModelRegistryTable
              specs={registrySpecs}
              configs={drafts}
              onToggle={(spec, enabled) => void handleToggleModel(spec, enabled)}
            />
          </Card>

          <CatalogCard
            onImported={() => {
              void reloadCatalog();
              void reload();
            }}
          />
        </>
      )}
    </div>
  );
}
