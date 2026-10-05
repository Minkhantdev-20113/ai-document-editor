import { useMemo } from 'react';
import { formatCount, formatTokens } from '../../core/utils/format';
import { formatDateTime } from '../../core/utils/time';
import type { UsageSnapshot } from '../../db/entities';
import { useCollection } from '../../hooks/useAsyncData';
import { useT } from '../../i18n/I18nProvider';
import { getProviderDescriptor } from '../../providers/registry';
import type { ProviderId } from '../../providers/types';
import { apiKeyService } from '../../services/apiKeyService';
import { keyPoolService } from '../../services/keyPoolService';
import type { UsageAggregate } from '../../services/usageService';
import { Badge } from '../ui/StatusBadge';
import { Notice } from '../ui/Notice';

function providerLabel(providerId: string): string {
  try {
    return getProviderDescriptor(providerId as ProviderId).label;
  } catch {
    return providerId;
  }
}

function emptyAggregate(): UsageAggregate {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimatedCostUsd: 0 };
}

function addAggregate(target: UsageAggregate, snapshot: UsageSnapshot): void {
  target.requests += snapshot.requests;
  target.inputTokens += snapshot.inputTokens;
  target.outputTokens += snapshot.outputTokens;
  target.cachedTokens += snapshot.cachedTokens;
  target.estimatedCostUsd += snapshot.estimatedCostUsd ?? 0;
}

interface ModelRow {
  readonly key: string;
  readonly providerId: string;
  readonly model: string;
  readonly aggregate: UsageAggregate;
}

interface BreakdownData {
  readonly totals: UsageAggregate;
  readonly byProvider: readonly (readonly [string, UsageAggregate])[];
  readonly byModel: readonly ModelRow[];
  readonly reportedTokens: number;
  readonly estimatedTokens: number;
}

/**
 * Usage dashboard body: totals, provider-reported vs locally-estimated split,
 * and the per-provider / per-model tables.
 *
 * The split is the honesty requirement: token counts that came from a
 * provider response are labelled provider-reported; everything else (local
 * estimates, costs, quota) is labelled estimated - provider quota simply
 * cannot be queried from the browser.
 */
export function UsageBreakdown({ snapshots }: { readonly snapshots: readonly UsageSnapshot[] }) {
  const t = useT();

  const data = useMemo<BreakdownData>(() => {
    const totals = emptyAggregate();
    const providers = new Map<string, UsageAggregate>();
    const models = new Map<string, ModelRow>();
    let reportedTokens = 0;
    let estimatedTokens = 0;

    for (const snapshot of snapshots) {
      addAggregate(totals, snapshot);

      const snapshotTokens = snapshot.inputTokens + snapshot.outputTokens;
      if (snapshot.basis === 'provider_reported') reportedTokens += snapshotTokens;
      else estimatedTokens += snapshotTokens;

      const providerBucket = providers.get(snapshot.providerId) ?? emptyAggregate();
      addAggregate(providerBucket, snapshot);
      providers.set(snapshot.providerId, providerBucket);

      const modelKey = `${snapshot.providerId}::${snapshot.model ?? 'unknown'}`;
      const row = models.get(modelKey) ?? {
        key: modelKey,
        providerId: snapshot.providerId,
        model: snapshot.model ?? t('common.unknown'),
        aggregate: emptyAggregate(),
      };
      addAggregate(row.aggregate, snapshot);
      models.set(modelKey, row);
    }

    return {
      totals,
      byProvider: [...providers.entries()],
      byModel: [...models.values()],
      reportedTokens,
      estimatedTokens,
    };
  }, [snapshots, t]);

  return (
    <div className="stack stack-6">
      <div className="grid-4">
        <div className="stat">
          <span className="stat__label">{t('usage.requests')}</span>
          <span className="stat__value">{formatCount(data.totals.requests)}</span>
        </div>
        <div className="stat">
          <span className="stat__label">{t('usage.inputTokens')}</span>
          <span className="stat__value">{formatTokens(data.totals.inputTokens)}</span>
        </div>
        <div className="stat">
          <span className="stat__label">{t('usage.outputTokens')}</span>
          <span className="stat__value">{formatTokens(data.totals.outputTokens)}</span>
        </div>
        <div className="stat">
          <span className="stat__label">{t('usage.estimatedCost')}</span>
          <span className="stat__value">${data.totals.estimatedCostUsd.toFixed(4)}</span>
        </div>
      </div>

      <div className="row row-2">
        <Badge tone="success" dot={false}>
          {t('usage.providerReported')}: {formatTokens(data.reportedTokens)}
        </Badge>
        <Badge tone="warning" dot={false}>
          {t('usage.locallyEstimated')}: {formatTokens(data.estimatedTokens)}
        </Badge>
      </div>

      <div className="dashboard-grid">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('apiKeys.provider')}</th>
                <th className="num">{t('usage.requests')}</th>
                <th className="num">{t('usage.inputTokens')}</th>
                <th className="num">{t('usage.outputTokens')}</th>
                <th className="num">{t('usage.cachedTokens')}</th>
                <th className="num">{t('usage.estimatedCost')}</th>
              </tr>
            </thead>
            <tbody>
              {data.byProvider.map(([providerId, aggregate]) => (
                <tr key={providerId}>
                  <td>{providerLabel(providerId)}</td>
                  <td className="num">{aggregate.requests}</td>
                  <td className="num">{formatTokens(aggregate.inputTokens)}</td>
                  <td className="num">{formatTokens(aggregate.outputTokens)}</td>
                  <td className="num">{formatTokens(aggregate.cachedTokens)}</td>
                  <td className="num">${aggregate.estimatedCostUsd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('providers.models')}</th>
                <th className="num">{t('usage.requests')}</th>
                <th className="num">{t('usage.inputTokens')}</th>
                <th className="num">{t('usage.outputTokens')}</th>
              </tr>
            </thead>
            <tbody>
              {data.byModel.map((row) => (
                <tr key={row.key}>
                  <td>
                    <div className="stack stack-1">
                      <span className="truncate">{row.model}</span>
                      <span className="text-xs subtle">{providerLabel(row.providerId)}</span>
                    </div>
                  </td>
                  <td className="num">{row.aggregate.requests}</td>
                  <td className="num">{formatTokens(row.aggregate.inputTokens)}</td>
                  <td className="num">{formatTokens(row.aggregate.outputTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Notice tone="info" icon="info">
        {t('usage.quotaHint')}
      </Notice>
    </div>
  );
}

interface KeyUsageData {
  readonly labels: Map<string, string>;
  readonly runtimes: Awaited<ReturnType<typeof keyPoolService.list>>;
  /** Captured in the loader (render must stay pure). */
  readonly now: number;
}

/**
 * Key usage: requests, errors, 429s and cooldowns per stored key.
 * Everything here is locally tracked - the label says so.
 */
export function KeyUsageTable() {
  const t = useT();

  const { data } = useCollection<KeyUsageData>(
    async () => {
      const [keys, runtimes] = await Promise.all([apiKeyService.list(), keyPoolService.list()]);
      const labels = new Map(keys.map((key) => [key.id, key.label || key.hint]));
      return { labels, runtimes, now: Date.now() };
    },
    [],
    ['apiKeys:changed', 'usage:changed'],
  );

  const runtimes = data?.runtimes ?? [];
  if (runtimes.length === 0) {
    return <p className="text-xs muted">{t('usage.noKeyData')}</p>;
  }

  const now = data?.now ?? 0;

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t('keyPool.key')}</th>
            <th>{t('apiKeys.provider')}</th>
            <th className="num">{t('usage.requests')}</th>
            <th className="num">{t('usage.inputTokens')}</th>
            <th className="num">{t('keyPool.errors')}</th>
            <th className="num">{t('keyPool.rateHits')}</th>
            <th>{t('keyPool.cooldown')}</th>
          </tr>
        </thead>
        <tbody>
          {runtimes.map((runtime) => (
            <tr key={runtime.id}>
              <td className="truncate">{data?.labels.get(runtime.id) ?? runtime.id}</td>
              <td className="text-xs">{providerLabel(runtime.providerId)}</td>
              <td className="num">{runtime.requestCount}</td>
              <td className="num" title={t('usage.locallyEstimated')}>
                {formatTokens(runtime.tokenEstimate)}
              </td>
              <td className="num">{runtime.failedRequests}</td>
              <td className="num">{runtime.rateLimitHits}</td>
              <td className="text-xs nowrap">
                {runtime.cooldownUntil > now
                  ? t('keyPool.cooldownUntil', { time: formatDateTime(runtime.cooldownUntil) })
                  : t('keyPool.cooldownNone')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs subtle">{t('keyPool.tokenEstimateHint')}</p>
    </div>
  );
}
