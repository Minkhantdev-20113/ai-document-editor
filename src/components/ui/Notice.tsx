import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export type NoticeTone = 'neutral' | 'info' | 'warning';

export interface NoticeProps {
  readonly tone?: NoticeTone;
  readonly icon?: IconName;
  readonly children: ReactNode;
}

export function Notice({ tone = 'neutral', icon, children }: NoticeProps) {
  const defaultIcon: IconName = tone === 'info' ? 'info' : tone === 'warning' ? 'alertTriangle' : 'info';
  return (
    <div className={['notice', tone === 'neutral' ? '' : `notice--${tone}`].filter(Boolean).join(' ')}>
      <Icon name={icon ?? defaultIcon} size={16} />
      <div>{children}</div>
    </div>
  );
}
