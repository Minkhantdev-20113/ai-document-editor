import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  readonly icon?: IconName;
  readonly title: string;
  readonly body?: ReactNode;
  readonly action?: ReactNode;
  readonly plain?: boolean;
}

export function EmptyState({ icon = 'file', title, body, action, plain }: EmptyStateProps) {
  return (
    <div className={['empty', plain ? 'empty--plain' : ''].filter(Boolean).join(' ')}>
      {!plain && (
        <span className="empty__icon">
          <Icon name={icon} size={18} />
        </span>
      )}
      <p className="empty__title">{title}</p>
      {body && <p className="empty__body">{body}</p>}
      {action}
    </div>
  );
}
