import type { ReactNode } from 'react';

export interface PageHeaderProps {
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
}

/** Consistent page heading used by every routed view. */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div>
        <h1 className="page-header__title">{title}</h1>
        {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}
