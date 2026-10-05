import { jobQueue } from './jobQueue';
import { exportDocumentHandler } from './handlers/exportDocument';
import { inspectDocumentHandler } from './handlers/inspectDocument';
import { translateDocumentHandler } from './handlers/translateDocument';
import { logger } from '../core/logging/logger';

let bootstrapped: Promise<void> | null = null;

/**
 * Wires job handlers and starts the queue exactly once per app session.
 * Called during application bootstrap (before routes render work).
 */
export function bootstrapJobs(): Promise<void> {
  if (!bootstrapped) {
    bootstrapped = (async () => {
      jobQueue.registerHandler('inspect_document', inspectDocumentHandler);
      jobQueue.registerHandler('translate_document', translateDocumentHandler);
      jobQueue.registerHandler('export_document', exportDocumentHandler);
      const { recovered } = await jobQueue.init();
      if (recovered > 0) {
        logger.info('Queue recovered after reload', { recovered });
      }
    })().catch((error: unknown) => {
      bootstrapped = null;
      logger.errorWith(error, 'Job system bootstrap failed');
      throw error;
    });
  }
  return bootstrapped;
}
