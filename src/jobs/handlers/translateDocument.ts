import { appEvents } from '../../core/events/eventBus';
import { AppError, toAppError } from '../../core/errors/appError';
import { logger } from '../../core/logging/logger';
import { documentService } from '../../services/documentService';
import { projectService } from '../../services/projectService';
import { isTranslationStrategy, translationService } from '../../services/translationService';
import { jobQueue } from '../jobQueue';
import type { JobHandler } from '../jobQueue';

/**
 * Phase 3 job: translate a stored document through the failover pool.
 *
 * Outcomes map onto the queue's state machine:
 * - completed / nothing_to_do -> completed,
 * - aborted (user pause/cancel/refresh) -> handled by the queue; all units
 *   translated so far are already persisted, so resume continues cleanly,
 * - paused_quota -> pause the job with `Provider quota exhausted` as the
 *   reason (a legal `translating -> paused` transition; resumable),
 * - failed -> throw so the queue applies its normal retry/failure handling.
 */
export const translateDocumentHandler: JobHandler = async (context) => {
  const documentId = String(context.payload['documentId'] ?? '');
  const projectId = context.payload['projectId'] ? String(context.payload['projectId']) : null;

  if (!documentId) {
    throw new AppError('Translation job has no documentId', { code: 'validation', retryable: false });
  }

  const document = await documentService.require(documentId);
  if (projectId) {
    await projectService.setStatus(projectId, 'translating');
  }

  try {
    context.log('Translating document', {
      documentId,
      fileName: document.fileName,
      targetLanguage: document.targetLanguage,
    });

    // The workflow's strategy choice (draft/standard/precise) rides in the
    // payload so a resume after refresh keeps the same batching/sampling.
    const rawStrategy = context.payload['strategy'];
    const result = await translationService.translateDocument({
      documentId,
      signal: context.signal,
      strategy: isTranslationStrategy(rawStrategy) ? rawStrategy : undefined,
      onProgress: (progress) => {
        context.progress(progress.processed, progress.total);
        // Bridge to the app event bus so the workspace can show page/unit
        // x-y, provider/model and the masked key id while the job runs.
        appEvents.emit('translation:progress', {
          documentId: progress.documentId,
          projectId,
          processed: progress.processed,
          total: progress.total,
          batchIndex: progress.batchIndex,
          batchCount: progress.batchCount,
          providerId: progress.providerId,
          model: progress.model,
          keyId: progress.keyId,
          completedPages: progress.completedPages,
          totalPages: progress.totalPages,
        });
      },
    });

    if (result.status === 'aborted' || context.signal.aborted) {
      // Pause/cancel/refresh: per-unit persistence already saved the work.
      return { translated: result.translated, failed: result.failed, aborted: true };
    }

    if (result.status === 'paused_quota') {
      logger.warn('Translation paused: provider quota exhausted', {
        documentId,
        providerId: result.providerId,
      });
      if (projectId) {
        await projectService.setStatus(projectId, 'paused').catch(() => undefined);
      }
      await jobQueue.pause(context.job.id, {
        code: 'provider_quota_exceeded',
        message:
          'Provider quota exhausted. Wait for the quota to reset (or add keys for another provider), then resume.',
        at: Date.now(),
        retryable: true,
      });
      // Returning lets the queue observe the pause abort and settle on `paused`.
      return;
    }

    if (result.status === 'failed') {
      throw (
        result.error ??
        new AppError('Translation failed before any unit could be translated', {
          code: 'provider_unavailable',
          retryable: false,
        })
      );
    }

    if (projectId) {
      await projectService.setStatus(projectId, 'completed').catch(() => undefined);
    }

    logger.info('Document translation finished', {
      documentId,
      status: result.status,
      translated: result.translated,
      skipped: result.skipped,
      failed: result.failed,
      memoryFilled: result.memoryFilled,
      providerId: result.providerId,
      model: result.model,
      oversizedUnits: result.oversizedUnitIds.length,
    });

    return {
      translated: result.translated,
      skipped: result.skipped,
      failed: result.failed,
      memoryFilled: result.memoryFilled,
      provider: result.providerId,
      model: result.model,
      oversizedUnits: result.oversizedUnitIds.length,
    };
  } catch (error) {
    const appError = toAppError(error, 'analysis_failed');
    if (projectId) {
      await projectService.setStatus(projectId, 'failed', {
        code: appError.code,
        message: appError.message,
        at: Date.now(),
        retryable: appError.retryable,
      }).catch(() => undefined);
    }
    throw appError;
  }
};
