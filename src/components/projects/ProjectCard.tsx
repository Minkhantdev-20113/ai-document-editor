import { Link } from 'react-router-dom';
import { ROUTES } from '../../config/appConfig';
import { useT } from '../../i18n/I18nProvider';
import type { Project } from '../../db/entities';
import { languageLabel } from '../../config/languages';
import { formatBytes } from '../../core/utils/format';
import { formatRelativeTime } from '../../core/utils/time';
import { StatusBadge } from '../ui/StatusBadge';
import { ProgressBar } from '../ui/Progress';
import { Icon } from '../ui/Icon';

export interface ProjectCardProps {
  readonly project: Project;
  readonly onDelete?: (project: Project) => void;
}

/** Project tile used by the projects grid. */
export function ProjectCard({ project, onDelete }: ProjectCardProps) {
  const t = useT();
  const percent = project.progress.percent;

  return (
    <article className="project-card">
      <div className="stack stack-1">
        <Link className="project-card__title" to={ROUTES.project(project.id)}>
          {project.name}
        </Link>
        <div className="row row-2">
          <StatusBadge state={project.status} />
          <span className="text-xs subtle">{formatRelativeTime(project.updatedAt)}</span>
        </div>
      </div>

      <p className="project-card__file">
        {project.sourceFile ? `${project.sourceFile.name} · ${formatBytes(project.sourceFile.size)}` : t('projects.noFile')}
      </p>

      <div className="stack stack-1">
        <span className="text-xs muted">
          {languageLabel(project.sourceLanguage)} → {languageLabel(project.targetLanguage)}
        </span>
        <ProgressBar value={percent} label={t('projects.progressValue', { percent })} />
        <span className="text-xs subtle">
          {percent > 0 ? t('projects.progressValue', { percent }) : t('projects.noProgress')}
        </span>
      </div>

      <div className="project-card__footer">
        <Link className="btn btn--secondary btn--sm" to={ROUTES.workspaceProject(project.id)}>
          <Icon name="layers" size={13} />
          {t('projects.openWorkspace')}
        </Link>
        <div className="row row-2">
          <Link className="btn btn--ghost btn--sm" to={ROUTES.project(project.id)}>
            {t('projects.viewProject')}
          </Link>
          {onDelete && (
            <button
              type="button"
              className="btn btn--ghost btn--sm btn--icon"
              aria-label={t('common.delete')}
              title={t('common.delete')}
              onClick={() => onDelete(project)}
            >
              <Icon name="trash" size={14} />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
