import { AppError, toAppError } from '../../core/errors/appError';
import { logger } from '../../core/logging/logger';
import { analyzeDocument } from '../../services/documentAnalysisService';
import { documentService } from '../../services/documentService';
import { projectService } from '../../services/projectService';
import type { JobHandler } from '../jobQueue';

function errorStateOf(error: unknown): { code: string; message: string; at: number; retryable: boolean } {
  const appError = toAppError(error);
  return {
    code: appError.code,
    message: appError.message,
    at: Date.now(),
    retryable: appError.retryable,
  };
}

/**
 * Phase 2 job: drive the full analysis pipeline for a stored document
 * (PDF, text, Markdown, HTML, CSV, or DOCX).
 *
 * All formats flow through one AnalysisSource; pages are analyzed one at a
 * time with real progress (page x/y, stage, block count), failures are
 * isolated per page, and results persist after every page so an interrupted
 * run resumes from the last completed page.
 */
export const inspectDocumentHandler: JobHandler = async (context) => {
  const documentId = String(context.payload['documentId'] ?? '');
  const projectId = context.payload['projectId'] ? String(context.payload['projectId']) : null;

  if (!documentId) {
    throw new AppError('Analysis job has no documentId', { code: 'validation', retryable: false });
  }

  const document = await documentService.require(documentId);
  if (projectId) {
    await projectService.setStatus(projectId, 'analyzing');
  }

  try {
    context.log('Analyzing document', { documentId, fileName: document.fileName, kind: document.kind });
    context.progress(0, document.pageCount ?? 1);

    const result = await analyzeDocument({
      documentId,
      signal: context.signal,
      onPage: ({ page, totalPages, blocks }) => {
        // page is the 1-based position just handled, so progress stays monotonic
        // across skipped (already analyzed) pages.
        context.progress(page, totalPages);
        if (page % 25 === 0 || page === totalPages) {
          context.log('Pages analyzed', { page, totalPages, blocks });
        }
      },
    });

    if (context.signal.aborted && result.aborted) {
      // Graceful stop between pages: persisted work is kept and the next
      // attempt resumes from the first unanalyzed page.
      return { pageCount: result.totalPages, inspectedPages: result.processedPages, aborted: true };
    }

    const finalDocument = await documentService.require(documentId);
    if (projectId) {
      await projectService.setStatus(projectId, 'completed');
    }

    logger.info('Document analysis finished', {
      documentId,
      pageCount: result.totalPages,
      processed: result.processedPages,
      analyzedThisRun: result.analyzedThisRun,
      skipped: result.skipped,
      failedPages: result.failedPages,
      detectedLanguage: result.detection?.code ?? null,
    });

    return {
      pageCount: result.totalPages,
      inspectedPages: result.processedPages,
      charCount: finalDocument.charCount ?? 0,
      analyzedPages: result.analyzedThisRun,
      skippedPages: result.skipped,
      failedPages: result.failedPages,
      blockCount: result.blocks,
      detectedLanguage: result.detection?.code ?? 'unknown',
      confidence: result.detection?.confidence ?? 0,
    };
  } catch (error) {
    const appError = toAppError(error, 'analysis_failed');
    await documentService.failAnalysis(documentId, appError).catch(() => undefined);
    if (projectId) {
      await projectService.setStatus(projectId, 'failed', errorStateOf(appError)).catch(() => undefined);
    }
    throw appError;
  }
};
