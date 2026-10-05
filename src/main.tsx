import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/pages.css';
import { App } from './App';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { logger } from './core/logging/logger';
import { I18nProvider } from './i18n/I18nProvider';
import { bootstrapJobs } from './jobs/bootstrap';
import { errorLogService } from './services/errorLogService';
import { settingsService } from './services/settingsService';
import { keyVault } from './security/keyVault';
import { ToastProvider } from './state/ToastProvider';

// Diagnostics first: everything logged after this point is persisted (redacted).
errorLogService.start();

function reportGlobalError(event: ErrorEvent): void {
  logger.errorWith(event.error ?? event.message, 'Uncaught error', {
    filename: event.filename ?? null,
    lineno: event.lineno ?? null,
  });
}

function reportRejection(event: PromiseRejectionEvent): void {
  logger.errorWith(event.reason, 'Unhandled promise rejection');
}

window.addEventListener('error', reportGlobalError);
window.addEventListener('unhandledrejection', reportRejection);

/** Loads persisted settings and starts the persistent job queue. */
async function bootstrapApplication(): Promise<void> {
  try {
    const settings = await settingsService.load();
    keyVault.setAutoLock(settings.vaultAutoLockMs);
    await keyVault.ready();
    await bootstrapJobs();
  } catch (error) {
    logger.errorWith(error, 'Application bootstrap failed');
  }
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <ErrorBoundary scope="app">
        <ToastProvider>
          <App />
        </ToastProvider>
      </ErrorBoundary>
    </I18nProvider>
  </StrictMode>,
);

void bootstrapApplication();
