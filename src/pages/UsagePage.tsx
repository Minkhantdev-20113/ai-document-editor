import { formatDateTime } from '../core/utils/time';
import type { UsageSnapshot } from '../db/entities';
import { getProviderDescriptor } from '../providers/registry';
import type { ProviderId } from '../providers/types';
import { usageService } from '../services/usageService';
import { useCollection } from '../hooks/useAsyncData';
import { useDocumentTitle } from '../hooks/useSystem';
import { useT } from '../i18n/I18nProvider';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Notice } from '../components/ui/Notice';
import { PageHeader } from '../components/ui/PageHeader';
import { KeyUsageTable, UsageBreakdown } from '../components/usage/UsageBreakdown';

function providerLabel(providerId: string): string {
  try {
    return getProviderDescriptor(providerId as ProviderId).label;
  } catch {
    return providerId;
  }
}

/** Usage dashboard: provider/model accounting, key usage, recent windows. */
export function UsagePage() {
  const t = useT();
  useDocumentTitle(t('usage.title'));

  const { data: snapshots, loading } = useCollection<UsageSnapshot[]>(
    () => usageService.list(),
    [],
    ['usage:changed', 'providers:changed'],
  );

  const isEmpty = (snapshots ?? []).length === 0;

  return (
    <div className="page">
      <PageHeader title={t('usage.title')} subtitle={t('usage.subtitle')} />

      {loading && !snapshots ? (
        <p className="muted">{t('common.loading')}</p>
      ) : isEmpty ? (
        <EmptyState icon="chart" title={t('usage.empty')} body={t('usage.emptyHint')} />
      ) : (
        <UsageBreakdown snapshots={snapshots ?? []} />
      )}

      {!isEmpty && (
        <div className="dashboard-grid">
          <Card title={t('usage.keyUsage')} subtitle={t('usage.keyUsageHint')}>
            <KeyUsageTable />
          </Card>

          <Card title={t('usage.window')}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('usage.window')}</th>
                    <th>{t('apiKeys.provider')}</th>
                    <th>{t('usage.source')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(snapshots ?? []).slice(0, 8).map((snapshot) => (
                    <tr key={snapshot.id}>
                      <td className="text-xs nowrap">{formatDateTime(snapshot.windowStart)}</td>
                      <td>{providerLabel(snapshot.providerId)}</td>
                      <td className="text-xs">
                        {snapshot.source === 'manual' ? t('usage.manual') : t('usage.engine')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      <Notice tone="info" icon="info">
        {t('usage.note')}
      </Notice>
    </div>
  );
}
