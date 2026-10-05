import type { AnalysisStage, AnalysisTask } from '../../domain/analysis/ir';
import { useT } from '../../i18n/I18nProvider';
import { Icon } from '../ui/Icon';

/**
 * Stages the pipeline actually persists, in execution order. Stages that are
 * folded into other steps (validation happens at import, units are written
 * with their page) are not listed, so every row can honestly reach "done".
 */
const FLOW: readonly AnalysisStage[] = ['parsing', 'page_analysis', 'language', 'done'];

/** Pipeline stage checklist with the current stage and task highlighted. */
export function AnalysisStageList({
  stage,
  task,
}: {
  readonly stage: AnalysisStage | undefined;
  readonly task: AnalysisTask | undefined;
}) {
  const t = useT();
  const current = stage ?? null;
  const currentIndex = current === null ? -1 : FLOW.indexOf(current);
  const failed = current === 'failed';

  return (
    <ol className="stage-list" data-stage={current ?? 'none'}>
      {FLOW.map((item, index) => {
        const isCurrent = index === currentIndex;
        const isDone = currentIndex >= 0 && index < currentIndex;
        const state = isCurrent ? 'current' : isDone ? 'done' : 'pending';
        return (
          <li key={item} className={`stage-list__item stage-list__item--${state}`}>
            <span className="stage-list__marker" aria-hidden="true">
              {state === 'done' ? (
                <Icon name="check" size={14} />
              ) : state === 'current' ? (
                <Icon name="activity" size={14} />
              ) : (
                <Icon name="chevronRight" size={14} />
              )}
            </span>
            <span className="stage-list__label">{t(`analysis.stageNames.${item}`)}</span>
            {isCurrent && task && <span className="stage-list__task">{t(`analysis.taskNames.${task}`)}</span>}
          </li>
        );
      })}
      {failed && (
        <li className="stage-list__item stage-list__item--failed">
          <span className="stage-list__marker" aria-hidden="true">
            <Icon name="alertTriangle" size={14} />
          </span>
          <span className="stage-list__label">{t('analysis.stageNames.failed')}</span>
        </li>
      )}
    </ol>
  );
}
