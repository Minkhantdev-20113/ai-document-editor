import { Component, type ErrorInfo, type ReactNode } from 'react';
import { toAppError, type AppError } from '../../core/errors/appError';
import { logger } from '../../core/logging/logger';
import { useT } from '../../i18n/I18nProvider';
import { Button } from './Button';
import { Icon } from './Icon';

interface Props {
  readonly children: ReactNode;
  /** Changing this value resets the boundary (e.g. the route pathname). */
  readonly resetKey?: string;
  readonly scope?: string;
}

interface State {
  error: AppError | null;
  resetKey: string | undefined;
}

function Fallback({ error, onReset }: { error: AppError; onReset: () => void }) {
  const t = useT();
  const message = t(`errors.${error.code}`);
  return (
    <div className="error-page">
      <span className="empty__icon">
        <Icon name="alertTriangle" size={20} />
      </span>
      <h1 className="page-header__title">{t('errors.boundaryTitle')}</h1>
      <p className="muted">{t('errors.boundaryBody')}</p>
      <p className="text-sm" style={{ color: 'var(--color-danger)' }}>
        {message}
      </p>
      <div className="row row-2">
        <Button variant="primary" onClick={onReset}>
          {t('errors.boundaryReload')}
        </Button>
      </div>
      {import.meta.env.DEV && (
        <details>
          <summary className="text-sm muted">{t('errors.detailsToggle')}</summary>
          <pre>
            {error.message}
            {'\n'}
            {String(error.details?.['stack'] ?? '')}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * Route/component error boundary.
 * Errors are logged centrally (redacted) and rendered as a recoverable view
 * instead of a blank page.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): State {
    return { error: toAppError(error), resetKey: undefined };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const appError = toAppError(error);
    logger.errorWith(appError, `Uncaught error in ${this.props.scope ?? 'component'}`, {
      componentStack: info.componentStack ?? null,
    });
  }

  override componentDidUpdate(previous: Props): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    if (this.state.error) {
      return <Fallback error={this.state.error} onReset={this.reset} />;
    }
    return this.props.children;
  }
}
