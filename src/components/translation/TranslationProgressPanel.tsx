import type { ProjectStatus } from '../../domain/types';
import { useCollection } from '../../hooks/useAsyncData';
import { useT } from '../../i18n/I18nProvider';
import { apiKeyService } from '../../services/apiKeyService';
import { ProgressBar } from '../ui/Progress';
import { StatusBadge } from '../ui/StatusBadge';
import { useTranslationProgress } from './useTranslationProgress';

export interface TranslationProgressPanelProps {
  readonly documentId: string;
  /** Latest translate job state for the status row (null = never started). */
  readonly jobState: ProjectStatus | null;
}

/**
 * Live translation progress (Phase 4): page x/y, unit x/y, current
 * provider/model and the MASKED key hint. The key itself never leaves the
 * vault/provider layer - only its stored hint (`AIza••••…`) is shown.
 */
export function TranslationProgressPanel({ documentId, jobState }: TranslationProgressPanelProps) {
  const t = useT();
  const progress = useTranslationProgress(documentId);
  const { data: keys } = useCollection(() => apiKeyService.list(), [], ['apiKeys:changed']);

  const keyHint =
    progress?.keyId != null
      ? (keys?.find((key) => key.id === progress.keyId)?.hint ?? null)
      : null;
  const percent =
    progress && progress.total > 0
      ? Math.round((progress.processed / progress.total) * 100)
      : 0;

  return (
    <div className="stack stack-3">
      {jobState && <StatusBadge state={jobState} />}
      {progress ? (
        <>
          <ProgressBar
            value={percent}
            label={t('workflow.unitsProgress', {
              processed: progress.processed,
              total: progress.total,
            })}
          />
          <div className="kv">
            <span className="kv__key">{t('common.pages')}</span>
            <span className="kv__value">
              {progress.completedPages} {t('common.of')} {progress.totalPages}
            </span>
          </div>
          <div className="kv">
            <span className="kv__key">{t('workflow.units')}</span>
            <span className="kv__value">
              {progress.processed} {t('common.of')} {progress.total}
            </span>
          </div>
          <div className="kv">
            <span className="kv__key">{t('workflow.batch')}</span>
            <span className="kv__value">
              {progress.batchCount > 0
                ? `${progress.batchIndex} ${t('common.of')} ${progress.batchCount}`
                : t('workflow.batchMemory')}
            </span>
          </div>
          <div className="kv">
            <span className="kv__key">{t('workflow.providerModel')}</span>
            <span className="kv__value mono text-xs">
              {progress.providerId
                ? `${progress.providerId}${progress.model ? ` · ${progress.model}` : ''}`
                : t('workflow.providerNone')}
            </span>
          </div>
          <div className="kv">
            <span className="kv__key">{t('workflow.key')}</span>
            <span className="kv__value mono text-xs">{keyHint ?? t('workflow.keyNone')}</span>
          </div>
        </>
      ) : (
        <p className="text-sm muted">{t('workflow.progressWaiting')}</p>
      )}
    </div>
  );
}
