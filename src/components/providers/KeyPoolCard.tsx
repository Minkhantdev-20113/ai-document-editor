import { formatDateTime } from '../../core/utils/time';
import { toAppError } from '../../core/errors/appError';
import type { ApiKeyMetadata, KeyRuntime } from '../../db/entities';
import { useCollection } from '../../hooks/useAsyncData';
import { useT } from '../../i18n/I18nProvider';
import type { RateLimitState } from '../../providers/aiProvider';
import { getProviderDescriptor } from '../../providers/registry';
import type { ProviderId } from '../../providers/types';
import { apiKeyService } from '../../services/apiKeyService';
import { keyPoolService } from '../../services/keyPoolService';
import { useToast } from '../../state/ToastProvider';
import { Button } from '../ui/Button';
import { Switch } from '../ui/Form';
import { Notice } from '../ui/Notice';
import { Badge } from '../ui/StatusBadge';

const HEALTH_KEY = {
  healthy: 'keyPool.healthy',
  degraded: 'keyPool.degraded',
  cooling: 'keyPool.cooling',
  invalid: 'keyPool.invalid',
} as const;

const HEALTH_TONE = {
  healthy: 'success',
  degraded: 'warning',
  cooling: 'info',
  invalid: 'danger',
} as const;

const COOLDOWN_KEY = {
  rate_limit: 'keyPool.cooldownRateLimit',
  quota: 'keyPool.cooldownQuota',
  server_error: 'keyPool.cooldownServer',
  auth: 'keyPool.cooldownAuth',
  manual: 'keyPool.cooldownManual',
} as const;

interface PoolData {
  readonly keys: ApiKeyMetadata[];
  readonly runtimes: KeyRuntime[];
  readonly state: RateLimitState;
  /** Captured in the loader (render must stay pure). */
  readonly now: number;
}

/**
 * One provider's failover pool: health, cooldowns and counters per key.
 *
 * This is the operational view of the weighted selector - the user sees
 * exactly why a key is (not) being used: cooling down after a 429, rejected,
 * or shared quota. Cooldown is reported as an absolute time ("until"), so
 * nothing here suggests a key is broken when it is merely resting.
 */
export function KeyPoolCard({ providerId }: { readonly providerId: ProviderId }) {
  const t = useT();
  const toast = useToast();

  const { data, reload } = useCollection<PoolData>(
    async () => {
      const [keys, runtimes, state] = await Promise.all([
        apiKeyService.listForProvider(providerId),
        keyPoolService.list(providerId),
        keyPoolService.rateLimitState(providerId),
      ]);
      return { keys, runtimes, state, now: Date.now() };
    },
    [providerId],
    ['apiKeys:changed', 'providers:changed'],
  );

  async function handleToggle(keyId: string, enabled: boolean) {
    try {
      await keyPoolService.setEnabled(keyId, enabled);
      reload();
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    }
  }

  async function handleReset(keyId: string) {
    try {
      await keyPoolService.reset(keyId);
      toast.success(t('keyPool.resetToast'));
      reload();
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    }
  }

  const keys = data?.keys ?? [];
  const runtimeById = new Map((data?.runtimes ?? []).map((runtime) => [runtime.id, runtime]));
  const state = data?.state;
  const now = data?.now ?? 0;

  if (keys.length === 0) return null;

  return (
    <section className="stack stack-3">
      <div className="row row-between">
        <strong>{getProviderDescriptor(providerId).label}</strong>
        {state && (
          <span className="text-xs subtle">
            {t('keyPool.poolSummary', {
              eligible: state.keys.eligible,
              cooling: state.keys.cooling,
              total: state.keys.total,
            })}
          </span>
        )}
      </div>

      {state?.exhaustion === 'quota' && (
        <Notice tone="warning" icon="alertTriangle">
          {t('keyPool.quotaNotice', { provider: providerId })}
        </Notice>
      )}
      {state?.exhaustion === 'rate_limited' && state.nextAvailableAt && (
        <Notice tone="info" icon="clock">
          {t('keyPool.rateNotice', { provider: providerId, time: formatDateTime(state.nextAvailableAt) })}
        </Notice>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('keyPool.useKey')}</th>
              <th>{t('keyPool.key')}</th>
              <th>{t('keyPool.health')}</th>
              <th>{t('keyPool.cooldown')}</th>
              <th className="num">{t('keyPool.requests')}</th>
              <th className="num">{t('keyPool.successes')}</th>
              <th className="num">{t('keyPool.errors')}</th>
              <th className="num">{t('keyPool.rateHits')}</th>
              <th className="num">{t('keyPool.tokenEstimate')}</th>
              <th>{t('keyPool.lastError')}</th>
              <th aria-label={t('common.actions')} />
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const runtime = runtimeById.get(key.id);
              const cooling = (runtime?.cooldownUntil ?? 0) > now;
              const health = runtime?.health ?? 'healthy';
              const cooldownReason = runtime?.cooldownReason;
              return (
                <tr key={key.id}>
                  <td>
                    <Switch
                      checked={runtime?.enabled ?? true}
                      label=""
                      onChange={(checked) => void handleToggle(key.id, checked)}
                    />
                  </td>
                  <td>
                    <div className="stack stack-1">
                      <span className="truncate">{key.label || key.hint}</span>
                      <span className="mono text-xs subtle">{key.hint}</span>
                    </div>
                  </td>
                  <td>
                    <Badge tone={HEALTH_TONE[health]}>{t(HEALTH_KEY[health])}</Badge>
                  </td>
                  <td className="text-xs nowrap">
                    {cooling ? (
                      <div className="stack stack-1">
                        <Badge tone="warning">
                          {cooldownReason ? t(COOLDOWN_KEY[cooldownReason]) : t('keyPool.cooldown')}
                        </Badge>
                        <span className="subtle">
                          {t('keyPool.cooldownUntil', { time: formatDateTime(runtime?.cooldownUntil ?? now) })}
                        </span>
                      </div>
                    ) : (
                      <span className="subtle">{t('keyPool.cooldownNone')}</span>
                    )}
                  </td>
                  <td className="num">{runtime?.requestCount ?? 0}</td>
                  <td className="num">{runtime?.successfulRequests ?? 0}</td>
                  <td className="num">{runtime?.failedRequests ?? 0}</td>
                  <td className="num">{runtime?.rateLimitHits ?? 0}</td>
                  <td className="num">{runtime?.tokenEstimate ?? 0}</td>
                  <td className="text-xs" title={runtime?.lastError?.message ?? undefined}>
                    <span className="truncate" style={{ maxWidth: 180, display: 'inline-block' }}>
                      {runtime?.lastError ? runtime.lastError.message : '—'}
                    </span>
                  </td>
                  <td>
                    <Button size="sm" variant="ghost" onClick={() => void handleReset(key.id)}>
                      {t('keyPool.reset')}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs subtle">{t('keyPool.tokenEstimateHint')}</p>
    </section>
  );
}
