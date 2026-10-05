import { AppError, toAppError } from '../../core/errors/appError';
import { logger } from '../../core/logging/logger';
import { documentService } from '../../services/documentService';
import { projectService } from '../../services/projectService';
import { exportService, requireExportFormat } from '../../services/exportService';
import type { JobHandler } from '../jobQueue';

/**
 * Phase 5 job: export a stored document (default PDF).
 *
 * The service owns the pipeline (layout in the worker, checkpointed painting,
 * validation); this handler maps outcomes onto the queue's state machine:
 * - completed -> completed (findings ride in the result for the UI),
 * - aborted (cancel/pause/refresh) -> handled by the queue, with the last
 *   checkpoint persisted so a retry resumes from the failed page,
 * - failure -> checkpoint already saved, then throw so the queue retries.
 */
export const exportDocumentHandler: JobHandler = async (context) => {
  const documentId = String(context.payload['documentId'] ?? '');
  const projectId = context.payload['projectId'] ? String(context.payload['projectId']) : null;

  if (!documentId) {
    throw new AppError('Export job has no documentId', { code: 'validation', retryable: false });
  }

  const format = requireExportFormat(context.payload['format']);
  const keepLayout = context.payload['keepLayout'] !== false;
  const document = await documentService.require(documentId);

  if (projectId) {
    await projectService.setExportState(projectId, 'exporting').catch(() => undefined);
  }

  try {
    context.log('Exporting document', {
      documentId,
      fileName: document.fileName,
      format,
      keepLayout,
      targetLanguage: document.targetLanguage,
    });

    const outcome = await exportService.runExport({
      jobId: context.job.id,
      documentId,
      format,
      keepLayout,
      signal: context.signal,
      onProgress: (processed, total) => context.progress(processed, total),
    });

    if (outcome.aborted || context.signal.aborted) {
      // The checkpoint already holds every page finished so far.
      if (projectId) {
        await projectService.setExportState(projectId, 'cancelled').catch(() => undefined);
      }
      return {
        aborted: true,
        fileName: outcome.fileName,
        renderedPages: outcome.renderedPages,
        pageCount: outcome.pageCount,
      };
    }

    if (projectId) {
      await projectService.setExportState(projectId, 'completed').catch(() => undefined);
    }

    logger.info('Document export finished', {
      documentId,
      jobId: context.job.id,
      fileName: outcome.fileName,
      pageCount: outcome.pageCount,
      renderedPages: outcome.renderedPages,
      resumedFrom: outcome.resumedFrom,
      blocking: outcome.blocking,
    });

    return {
      pageCount: outcome.pageCount,
      charCount: document.charCount ?? undefined,
      fileName: outcome.fileName,
      format,
      findings: outcome.findings.length,
      blocking: outcome.blocking,
    };
  } catch (error) {
    const appError = toAppError(error, 'export_failed');
    if (projectId) {
      await projectService.setExportState(projectId, 'failed').catch(() => undefined);
    }
    throw appError;
  }
};
