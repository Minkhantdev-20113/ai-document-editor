import type { ReactNode } from 'react';

export interface ProgressBarProps {
  /** 0-100. Omit for an indeterminate bar. */
  readonly value?: number;
  readonly tone?: 'primary' | 'success' | 'danger';
  readonly label?: string;
}

export function ProgressBar({ value, tone = 'primary', label }: ProgressBarProps) {
  const indeterminate = value === undefined;
  const width = indeterminate ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div
      className={[
        'progress',
        tone !== 'primary' ? `progress--${tone}` : '',
        indeterminate ? 'progress--indeterminate' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : width}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className="progress__bar" style={{ width: `${width}%` }} />
    </div>
  );
}

export function Spinner({ large, label }: { readonly large?: boolean; readonly label?: string }) {
  return (
    <span
      className={['spinner', large ? 'spinner--lg' : ''].filter(Boolean).join(' ')}
      role="status"
      aria-label={label}
    />
  );
}

export function LoadingBlock({ children }: { readonly children: ReactNode }) {
  return (
    <div className="loading-block" role="status">
      <Spinner large />
      <span>{children}</span>
    </div>
  );
}

export function Skeleton({ height = 14, width = '100%' }: { readonly height?: number; readonly width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden="true" />;
}
