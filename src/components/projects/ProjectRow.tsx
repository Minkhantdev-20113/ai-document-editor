import { Link } from 'react-router-dom';
import { ROUTES } from '../../config/appConfig';
import { useT } from '../../i18n/I18nProvider';
import type { Project } from '../../db/entities';
import { formatRelativeTime } from '../../core/utils/time';
import { StatusBadge } from '../ui/StatusBadge';
import { ProgressBar } from '../ui/Progress';

export interface ProjectRowProps {
  readonly project: Project;
}

/** Compact project line used by dashboard and detail lists. */
export function ProjectRow({ project }: ProjectRowProps) {
  const t = useT();
  const percent = project.progress.percent;

  return (
    <Link className="project-row" to={ROUTES.project(project.id)}>
      <div>
        <div className="project-row__name truncate">{project.name}</div>
        <div className="project-row__meta">
          <StatusBadge state={project.status} />
          <span>{project.sourceFile?.name ?? t('projects.noFile')}</span>
          <span>{formatRelativeTime(project.updatedAt)}</span>
        </div>
      </div>
      <div className="project-row__progress">
        <ProgressBar value={percent} label={t('projects.progressValue', { percent })} />
        <span className="text-xs subtle nowrap">{percent}%</span>
      </div>
    </Link>
  );
}
