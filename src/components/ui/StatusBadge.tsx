import type { ReactNode } from 'react';
import { useT } from '../../i18n/I18nProvider';
import type { JobState } from '../../domain/jobStates';
import type { ProjectStatus, UnitStatus, ExportState } from '../../domain/types';
import type { ApiKeyStatus, InspectionState } from '../../db/entities';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly dot?: boolean;
  readonly children: ReactNode;
  readonly title?: string;
}

export function Badge({ tone = 'neutral', dot = true, children, title }: BadgeProps) {
  return (
    <span
      className={['badge', tone === 'neutral' ? '' : `badge--${tone}`, dot ? '' : 'badge--no-dot']
        .filter(Boolean)
        .join(' ')}
      title={title}
    >
      {children}
    </span>
  );
}

const JOB_TONE: Record<JobState, BadgeTone> = {
  queued: 'neutral',
  analyzing: 'info',
  translating: 'primary',
  paused: 'warning',
  retrying: 'warning',
  exporting: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

const UNIT_TONE: Record<UnitStatus, BadgeTone> = {
  pending: 'neutral',
  in_progress: 'info',
  translated: 'primary',
  reviewed: 'success',
  failed: 'danger',
};

const EXPORT_TONE: Record<ExportState, BadgeTone> = {
  not_started: 'neutral',
  queued: 'neutral',
  exporting: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

const KEY_TONE: Record<ApiKeyStatus, BadgeTone> = {
  unverified: 'neutral',
  valid: 'success',
  invalid: 'danger',
  revoked: 'neutral',
};

const INSPECT_TONE: Record<InspectionState, BadgeTone> = {
  pending: 'neutral',
  running: 'info',
  ready: 'success',
  failed: 'danger',
  unsupported: 'warning',
};

/** Job/project state badge: color + localized label in one place. */
export function StatusBadge({ state }: { readonly state: ProjectStatus }) {
  const t = useT();
  const tone: BadgeTone = state === 'draft' ? 'neutral' : (JOB_TONE[state] ?? 'neutral');
  return <Badge tone={tone}>{t(`status.${state}`)}</Badge>;
}

export function UnitStatusBadge({ status }: { readonly status: UnitStatus }) {
  const t = useT();
  return <Badge tone={UNIT_TONE[status]}>{t(`status.${status}`)}</Badge>;
}

export function ExportStateBadge({ state }: { readonly state: ExportState }) {
  const t = useT();
  return <Badge tone={EXPORT_TONE[state]}>{t(`status.${state}`)}</Badge>;
}

export function ApiKeyStatusBadge({ status }: { readonly status: ApiKeyStatus }) {
  const t = useT();
  return <Badge tone={KEY_TONE[status]}>{t(`status.${status}`)}</Badge>;
}

export function InspectionBadge({ state }: { readonly state: InspectionState }) {
  const t = useT();
  return <Badge tone={INSPECT_TONE[state]}>{t(`status.${state}`)}</Badge>;
}
