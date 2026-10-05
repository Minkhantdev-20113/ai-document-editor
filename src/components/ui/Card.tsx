import type { ReactNode } from 'react';

export interface CardProps {
  readonly title?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
  readonly flat?: boolean;
}

export function Card({ title, subtitle, actions, footer, children, className, bodyClassName, flat }: CardProps) {
  return (
    <section className={['card', flat ? 'card--flat' : '', className].filter(Boolean).join(' ')}>
      {(title || actions) && (
        <header className="card__header">
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {subtitle && <p className="card__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="row row-2">{actions}</div>}
        </header>
      )}
      <div className={['card__body', bodyClassName].filter(Boolean).join(' ')}>{children}</div>
      {footer && <footer className="card__footer">{footer}</footer>}
    </section>
  );
}
