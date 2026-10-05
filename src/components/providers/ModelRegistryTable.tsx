import { useMemo } from 'react';
import { formatCount } from '../../core/utils/format';
import type { ProviderConfig } from '../../db/entities';
import { useT } from '../../i18n/I18nProvider';
import type { ModelSpec } from '../../providers/modelRegistry';
import { getProviderDescriptor } from '../../providers/registry';
import type { ProviderId } from '../../providers/types';
import { Button } from '../ui/Button';
import { Badge } from '../ui/StatusBadge';
import { PricingBadge } from './PricingBadge';

/**
 * The model registry as one table (all providers).
 *
 * Every fact comes from `modelRegistry` - components never hard-code pricing,
 * context windows or capabilities. PDF/image/vision badges only render when
 * the spec explicitly declares support, so an unsupported capability can
 * never be advertised by accident.
 */

const QUALITY_KEY = {
  high: 'registry.qualityHigh',
  medium: 'registry.qualityMedium',
  low: 'registry.qualityLow',
} as const;

const SPEED_KEY = {
  fast: 'registry.speedFast',
  medium: 'registry.speedMedium',
  slow: 'registry.speedSlow',
} as const;

interface ModelRegistryTableProps {
  readonly specs: readonly ModelSpec[];
  readonly configs: Readonly<Record<string, ProviderConfig>>;
  readonly onToggle: (spec: ModelSpec, enabled: boolean) => void;
}

function providerLabel(providerId: string): string {
  try {
    return getProviderDescriptor(providerId as ProviderId).label;
  } catch {
    return providerId;
  }
}

export function ModelRegistryTable({ specs, configs, onToggle }: ModelRegistryTableProps) {
  const t = useT();

  const enabledCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const spec of specs) {
      if (spec.enabled) counts.set(spec.providerId, (counts.get(spec.providerId) ?? 0) + 1);
    }
    return counts;
  }, [specs]);

  function capabilityChips(spec: ModelSpec): { readonly key: string; readonly label: string }[] {
    const chips: { key: string; label: string }[] = [];
    if (spec.supportsText) chips.push({ key: 'text', label: t('registry.capText') });
    if (spec.supportsPDF) chips.push({ key: 'pdf', label: t('registry.capPdf') });
    if (spec.supportsImage) chips.push({ key: 'image', label: t('registry.capImage') });
    if (spec.supportsVision) chips.push({ key: 'vision', label: t('registry.capVision') });
    if (spec.supportsStructuredOutput) chips.push({ key: 'json', label: t('registry.capJson') });
    return chips;
  }

  return (
    <div className="stack stack-4">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('registry.model')}</th>
              <th>{t('registry.provider')}</th>
              <th>{t('registry.pricing')}</th>
              <th className="num">{t('registry.context')}</th>
              <th>{t('registry.capabilities')}</th>
              <th>{t('registry.quality')}</th>
              <th>{t('registry.speed')}</th>
              <th>{t('registry.enabled')}</th>
            </tr>
          </thead>
          <tbody>
            {specs.map((spec) => {
              const config = configs[spec.providerId];
              const isDefault = config?.defaultModel === spec.modelId;
              const onlyEnabled = spec.enabled && (enabledCounts.get(spec.providerId) ?? 0) === 1;
              const locked = isDefault || onlyEnabled;
              const lockReason = isDefault ? t('registry.defaultLocked') : t('registry.lastEnabled');

              return (
                <tr key={`${spec.providerId}/${spec.modelId}`}>
                  <td>
                    <div className="stack stack-1">
                      <span className="row row-2">
                        <strong className="truncate">{spec.displayName}</strong>
                        {isDefault && (
                          <Badge tone="primary" dot={false}>
                            {t('registry.default')}
                          </Badge>
                        )}
                        {spec.source === 'catalog_update' && (
                          <Badge tone="info" dot={false}>
                            {t('registry.updated')}
                          </Badge>
                        )}
                      </span>
                      <span className="mono text-xs subtle">{spec.modelId}</span>
                    </div>
                  </td>
                  <td className="text-xs nowrap">{providerLabel(spec.providerId)}</td>
                  <td>
                    <PricingBadge pricing={spec.pricingType} />
                  </td>
                  <td className="num text-xs nowrap">{formatCount(spec.contextLength)}</td>
                  <td>
                    <div className="capabilities">
                      {capabilityChips(spec).map((chip) => (
                        <span key={chip.key} className="chip">
                          {chip.label}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="text-xs nowrap">{t(QUALITY_KEY[spec.qualityLevel])}</td>
                  <td className="text-xs nowrap">{t(SPEED_KEY[spec.speedLevel])}</td>
                  <td>
                    <Button
                      size="sm"
                      variant={spec.enabled ? 'primary' : 'ghost'}
                      disabled={locked}
                      title={locked ? lockReason : undefined}
                      onClick={() => onToggle(spec, !spec.enabled)}
                    >
                      {spec.enabled ? t('registry.on') : t('registry.off')}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs subtle">{t('registry.pricingDisclaimer')}</p>
    </div>
  );
}
