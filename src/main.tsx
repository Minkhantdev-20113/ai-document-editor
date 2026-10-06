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
import { ocrRegistry } from './services/ocrRegistry';
import { settingsService } from './services/settingsService';
import { keyVault } from './security/keyVault';
import { ToastProvider } from './state/ToastProvider';

// Diagnostics first: everything logged after this point is persisted (redacted).
errorLogService.start();

/**
 * Loads the on-device OCR engine before any analysis can start. Failure is
 * not fatal: the engine is a lazy chunk, and without it image-only pages keep
 * reporting `needs_ocr` exactly as they do today.
 */
async function registerOcrEngine(): Promise<void> {
  try {
    const { tesseractOcrProvider } = await import('./services/ocr/tesseractOcr');
    ocrRegistry.register(tesseractOcrProvider);
  } catch (error) {
    logger.warn('OCR engine unavailable; image-only pages stay empty', { error: String(error) });
  }
}

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
    await registerOcrEngine();
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
