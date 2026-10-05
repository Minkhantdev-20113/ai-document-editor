import { useState } from 'react';
import { ROUTES } from '../../config/appConfig';
import { availableTargetLanguages, languageLabel } from '../../config/languages';
import { toAppError } from '../../core/errors/appError';
import type { DocumentRecord, JobRecord, Project } from '../../db/entities';
import { useCollection } from '../../hooks/useAsyncData';
import { useSettings } from '../../hooks/useSettings';
import { useT } from '../../i18n/I18nProvider';
import { documentService } from '../../services/documentService';
import { projectService } from '../../services/projectService';
import {
  DEFAULT_STRATEGY,
  translationService,
  type TranslationStrategy,
} from '../../services/translationService';
import { validationService } from '../../services/validationService';
import { useToast } from '../../state/ToastProvider';
import { Button, ButtonLink } from '../ui/Button';
import { Card } from '../ui/Card';
import { Segmented, Select } from '../ui/Form';
import { Icon } from '../ui/Icon';
import { TranslationProgressPanel } from './TranslationProgressPanel';

interface WorkflowCardProps {
  readonly project: Project;
  readonly document: DocumentRecord | undefined;
  readonly jobs: readonly JobRecord[];
  readonly busy: boolean;
  readonly onTranslate: (strategy: TranslationStrategy) => void;
}

interface WorkflowStep {
  readonly label: string;
  readonly state: 'done' | 'active' | 'pending';
  readonly detail?: string;
}

const ACTIVE_JOB_STATES = new Set(['queued', 'retrying', 'translating']);

function strategyLabelKey(strategy: TranslationStrategy): string {
  if (strategy === 'draft') return 'workflow.strategyDraft';
  if (strategy === 'precise') return 'workflow.strategyPrecise';
  return 'workflow.strategyStandard';
}

function strategyHintKey(strategy: TranslationStrategy): string {
  if (strategy === 'draft') return 'workflow.strategyDraftHint';
  if (strategy === 'precise') return 'workflow.strategyPreciseHint';
  return 'workflow.strategyStandardHint';
}

/**
 * Guided translation workflow (Phase 4): Project -> Analyze -> confirm
 * source -> pick target -> provider/model -> strategy -> start -> progress
 * (batching, incremental saves) -> validation -> editor. Each step reflects
 * real persisted state; nothing here fabricates readiness.
 */
export function WorkflowCard({ project, document, jobs, busy, onTranslate }: WorkflowCardProps) {
  const t = useT();
  const toast = useToast();
  const { settings } = useSettings();
  const [strategy, setStrategy] = useState<TranslationStrategy>(DEFAULT_STRATEGY);

  const { data: candidates } = useCollection(
    () => translationService.resolveCandidates(),
    [],
    ['providers:changed', 'apiKeys:changed'],
  );
  const { data: validation } = useCollection(
    async () => (document ? validationService.storedSummary(document.id) : null),
    [document?.id],
    ['units:changed'],
  );

  const ready = document?.inspectionState === 'ready';
  const provider = candidates?.[0];

  // Latest translate job for this project (list order is not assumed).
  let translateJob: JobRecord | undefined;
  for (const job of jobs) {
    if (job.type !== 'translate_document') continue;
    if (!translateJob || job.queuedAt >= translateJob.queuedAt) translateJob = job;
  }
  const jobRunning = translateJob !== undefined && ACTIVE_JOB_STATES.has(translateJob.state);

  const targetOptions = availableTargetLanguages(settings.targetLanguages).map((language) => ({
    value: language.code,
    label: `${language.nativeName} (${language.englishName})`,
  }));

  async function handleTargetLanguage(code: string): Promise<void> {
    if (!document || !code) return;
    try {
      await documentService.setTargetLanguage(document.id, code);
      await projectService.update(project.id, { targetLanguage: code });
      toast.success(t('common.saved'));
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    }
  }

  const canStart = Boolean(ready && provider && !jobRunning);
  const startDisabledReason = !document
    ? t('projects.noFile')
    : !ready
      ? t('translation.needsInspection')
      : !provider
        ? t('workflow.providerNone')
        : jobRunning
          ? t('workflow.jobRunning')
          : undefined;

  const steps: WorkflowStep[] = [
    {
      label: t('workflow.stepProject'),
      state: 'done',
      detail: project.name,
    },
    {
      label: t('workflow.stepAnalyze'),
      state: ready ? 'done' : document ? 'active' : 'pending',
      detail: document
        ? `${document.pageCount ?? '—'} ${t('common.pages')}`
        : t('projects.noFile'),
    },
    {
      label: t('workflow.stepSourceLanguage'),
      state: ready ? 'done' : 'pending',
      detail: document ? languageLabel(document.sourceLanguage) : undefined,
    },
    {
      label: t('workflow.stepTargetLanguage'),
      state: ready ? 'done' : 'pending',
      detail: document ? languageLabel(document.targetLanguage) : undefined,
    },
    {
      label: t('workflow.stepProvider'),
      state: provider ? 'done' : 'active',
      detail: provider ? `${provider.providerId} · ${provider.model}` : t('workflow.providerNone'),
    },
    {
      label: t('workflow.stepStrategy'),
      state: 'done',
      detail: t(strategyLabelKey(strategy)),
    },
    {
      label: t('workflow.stepStart'),
      state: translateJob ? 'done' : canStart ? 'active' : 'pending',
    },
    {
      label: t('workflow.stepProgress'),
      state:
        translateJob?.state === 'completed'
          ? 'done'
          : translateJob
            ? 'active'
            : 'pending',
      detail: translateJob ? t(`status.${translateJob.state}`) : undefined,
    },
    {
      label: t('workflow.stepValidation'),
      state:
        validation && validation.units > 0
          ? validation.unitsWithWarnings > 0
            ? 'active'
            : 'done'
          : 'pending',
      detail:
        validation && validation.unitsWithWarnings > 0
          ? t('workflow.validationWarnings', { count: validation.totalWarnings })
          : validation && validation.units > 0
            ? t('workflow.validationClean')
            : undefined,
    },
    {
      label: t('workflow.stepEditor'),
      state: validation && validation.translated > 0 ? 'done' : 'pending',
      detail:
        validation && validation.units > 0
          ? `${validation.translated} ${t('common.of')} ${validation.units}`
          : undefined,
    },
  ];

  return (
    <Card title={t('workflow.title')}>
      <div className="stack stack-4">
        <ol className="workflow-steps">
          {steps.map((step) => (
            <li key={step.label} data-state={step.state}>
              <span className="workflow-steps__marker" aria-hidden="true">
                {step.state === 'done' ? <Icon name="check" size={10} /> : ''}
              </span>
              <span className="text-sm">{step.label}</span>
              {step.detail && (
                <span className="workflow-steps__detail text-xs subtle">{step.detail}</span>
              )}
            </li>
          ))}
        </ol>

        <Select
          label={t('workflow.fieldTargetLanguage')}
          options={targetOptions}
          value={document?.targetLanguage ?? ''}
          disabled={!document}
          onChange={(event) => void handleTargetLanguage(event.target.value)}
        />

        <div className="stack stack-2">
          <span className="text-sm">{t('workflow.strategy')}</span>
          <Segmented<TranslationStrategy>
            ariaLabel={t('workflow.strategy')}
            value={strategy}
            options={[
              { value: 'draft', label: t(strategyLabelKey('draft')) },
              { value: 'standard', label: t(strategyLabelKey('standard')) },
              { value: 'precise', label: t(strategyLabelKey('precise')) },
            ]}
            onChange={setStrategy}
          />
          <p className="text-xs muted">{t(strategyHintKey(strategy))}</p>
        </div>

        <div className="row row-2">
          <Button
            variant="primary"
            icon={<Icon name="translate" size={14} />}
            loading={busy}
            disabled={!canStart}
            title={startDisabledReason}
            onClick={() => onTranslate(strategy)}
          >
            {t('workflow.start')}
          </Button>
          {!provider && (
            <ButtonLink to={ROUTES.providers} icon={<Icon name="key" size={14} />}>
              {t('workflow.configureProviders')}
            </ButtonLink>
          )}
          <ButtonLink to={ROUTES.analysis(project.id)} icon={<Icon name="layers" size={14} />}>
            {t('workflow.openAnalysis')}
          </ButtonLink>
        </div>

        {document && (
          <TranslationProgressPanel documentId={document.id} jobState={translateJob?.state ?? null} />
        )}

        <div className="row row-2">
          {validation && validation.translated > 0 ? (
            <ButtonLink
              to={ROUTES.workspaceEditor(project.id)}
              icon={<Icon name="pen" size={14} />}
              variant="primary"
            >
              {t('workflow.openEditor')}
            </ButtonLink>
          ) : (
            <Button disabled title={t('workflow.editorNotReady')}>
              {t('workflow.openEditor')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
