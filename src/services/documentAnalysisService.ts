import { appEvents } from '../core/events/eventBus';
import { toAppError } from '../core/errors/appError';
import { logger } from '../core/logging/logger';
import type { AnalysisSource, OpenedDocumentInfo } from '../domain/analysis/source';
import type { DocumentMetadata, LanguageDetection } from '../domain/analysis/ir';
import { detectLanguage } from '../domain/languageDetect';
import { createWorkerAnalysisSession } from '../workers/analysisClient';
import { documentService } from './documentService';

/** Transient page failures get one immediate retry before the page is marked failed. */
const PAGE_RETRIES = 1;

export interface AnalyzeProgressInfo {
  /** 1-based index of the page just handled (skipped or processed). */
  readonly page: number;
  readonly totalPages: number;
  readonly analyzed: number;
  readonly blocks: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface AnalyzeDocumentOptions {
  readonly documentId: string;
  /** Aborted on job timeout/cancel; the run then stops between pages and resumes later. */
  readonly signal?: AbortSignal;
  /** Called after every handled page (drives job progress). */
  readonly onPage?: (info: AnalyzeProgressInfo) => void;
  /** Source factory; tests/Node inject the in-process session instead of a worker. */
  readonly createSource?: () => AnalysisSource;
}

export interface AnalyzeDocumentResult {
  readonly totalPages: number;
  readonly processedPages: number;
  readonly failedPages: number;
  readonly blocks: number;
  readonly analyzedThisRun: number;
  readonly skipped: number;
  readonly detection: LanguageDetection | null;
  /** True when the signal stopped the run early (resumable on the next attempt). */
  readonly aborted: boolean;
}

async function withRetry<T>(run: () => Promise<T>, retries: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        logger.warn('Retrying analysis operation', { attempt: attempt + 1, code: toAppError(error).code });
      }
    }
  }
  throw lastError;
}

/** Folds the title hint into the metadata record (text sources have no metadata of their own). */
function composeMetadata(info: OpenedDocumentInfo): DocumentMetadata | null {
  const metadata = info.metadata;
  if (!info.title || metadata?.title) return metadata;
  return {
    title: info.title,
    author: metadata?.author ?? null,
    subject: metadata?.subject ?? null,
    producer: metadata?.producer ?? null,
    creator: metadata?.creator ?? null,
    creationDate: metadata?.creationDate ?? null,
    format: metadata?.format ?? null,
  };
}

/**
 * Phase 2 pipeline driver (File Picker → … → Local Persistence).
 *
 * - parses the source via an AnalysisSource (Web Worker in the browser),
 * - skips pages already analyzed so interrupted runs resume instead of redoing work,
 * - persists every page/block through documentService (per-page commit),
 * - isolates page failures: one retry, then `failed` is recorded and the run continues,
 * - ends with language detection over persisted text and a recount of the counters.
 */
export async function analyzeDocument(options: AnalyzeDocumentOptions): Promise<AnalyzeDocumentResult> {
  const { documentId, signal } = options;
  const document = await documentService.require(documentId);
  const createSource = options.createSource ?? createWorkerAnalysisSession;
  const source = createSource();

  try {
    // Transient "parsing" signal; the persisted record starts once open succeeds.
    appEvents.emit('analysis:progress', {
      documentId,
      projectId: document.projectId,
      stage: 'parsing',
      task: 'open_document',
      page: 0,
      pageCount: document.pageCount ?? 0,
      analyzed: 0,
      blocks: 0,
      failed: 0,
    });

    const bytes = await documentService.readPayload(documentId);
    const info = await source.open(bytes, { documentId, fileName: document.fileName });
    const metadata = composeMetadata(info);
    const seeded = await documentService.beginAnalysis(documentId, { pageCount: info.pageCount, metadata });

    const existingByIndex = new Map(
      (await documentService.pages(documentId)).map((page) => [page.pageIndex, page]),
    );
    let processed = seeded.analysis?.processedPages ?? 0;
    let blocks = seeded.analysis?.blocks ?? 0;
    let failed = 0;
    let skipped = 0;
    let analyzedThisRun = 0;
    let aborted = false;

    const report = (index: number): void => {
      options.onPage?.({
        page: index + 1,
        totalPages: info.pageCount,
        analyzed: processed,
        blocks,
        failed,
        skipped,
      });
    };

    for (let index = 0; index < info.pageCount; index += 1) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }

      const existing = existingByIndex.get(index);
      const alreadyAnalyzed =
        existing?.analyzedAt !== undefined && (existing.status === 'ready' || existing.status === 'needs_ocr');
      if (alreadyAnalyzed) {
        skipped += 1;
        report(index);
        continue;
      }

      let page;
      try {
        page = await withRetry(() => source.page(index), PAGE_RETRIES);
      } catch (error) {
        const appError = toAppError(error, 'analysis_failed');
        await documentService.markPageFailed(documentId, index, appError);
        failed += 1;
        logger.warn('Page analysis failed', { documentId, pageIndex: index, code: appError.code });
        report(index);
        continue;
      }

      await documentService.applyPageAnalysis(documentId, page);
      analyzedThisRun += 1;
      processed += 1;
      blocks += page.blocks.length;
      report(index);
    }

    let detection: LanguageDetection | null = null;
    if (!aborted) {
      const sample = await documentService.sampleText(documentId);
      if (sample.trim().length > 0) {
        detection = detectLanguage(sample);
        await documentService.setLanguageDetection(documentId, detection);
      }
      await documentService.finishAnalysis(documentId);
    }

    const finalRecord = await documentService.require(documentId);
    const analysis = finalRecord.analysis;
    return {
      totalPages: info.pageCount,
      processedPages: analysis?.processedPages ?? processed,
      failedPages: analysis?.failedPages ?? failed,
      blocks: analysis?.blocks ?? blocks,
      analyzedThisRun,
      skipped,
      detection,
      aborted,
    };
  } finally {
    await source.close().catch(() => undefined);
  }
}
