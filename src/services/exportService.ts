/**
 * Export service (Phase 5): drives one export job end to end.
 *
 * Pipeline (all heavy work stays in the export worker): translated document
 * model -> layout -> page painting -> validation -> PDF bytes. This module only
 * fetches records, persists crash-recovery checkpoints (a snapshot of every
 * page finished so far, so a retry resumes from the failed page), reports
 * progress and stores the validated result for download.
 *
 * It never downloads anything itself: artifacts are persisted with their
 * validation findings and the UI decides whether a blocking finding must be
 * shown first.
 */
import type { ExportFormat } from '../config/appConfig';
import { AppError, toAppError } from '../core/errors/appError';
import { logger } from '../core/logging/logger';
import type { ExportArtifact, DocumentRecord } from '../db/entities';
import {
  documentBlocksRepo,
  documentPagesRepo,
  exportArtifactsRepo,
  jobsRepo,
  translationUnitsRepo,
} from '../db/repositories';
import {
  DEFAULT_EXPORT_FONTS,
  isBurmeseFontId,
  isLatinFontId,
  type ExportFontSelection,
} from '../domain/export/fonts';
import type { SecondaryFormat } from '../domain/export/secondaryFormats';
import {
  hasBlockingFindings,
  validateSecondaryArtifact,
  type ExportFinding,
} from '../domain/export/validateExport';
import type { ExportDocumentInput } from '../domain/export/types';
import { createExportWorkerSession, type ExportWorkerSession } from '../workers/exportClient';
import { documentService } from './documentService';
import { buildExportDocument } from './exportDocumentBuilder';
import { settingsService } from './settingsService';

/** Pages between crash-recovery checkpoints (each is a full PDF snapshot). */
const CHECKPOINT_EVERY = 10;

export interface ExportRunOptions {
  readonly jobId: string;
  readonly documentId: string;
  readonly format: ExportFormat;
  readonly keepLayout: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (processed: number, total: number) => void;
  /**
   * Overrides the export worker session. Tests inject a scripted session; in
   * production this stays unset and a fresh worker session is created per job.
   */
  readonly session?: ExportWorkerSession;
}

export interface ExportOutcome {
  readonly jobId: string;
  readonly fileName: string;
  /** Pages in the produced file. */
  readonly pageCount: number;
  readonly renderedPages: number;
  /** Pages that were already done by a previous attempt (resume point). */
  readonly resumedFrom: number;
  readonly findings: readonly ExportFinding[];
  /** True when an `error` finding must block the download. */
  readonly blocking: boolean;
  readonly aborted: boolean;
}

class ExportService {
  /**
   * Renders, validates and persists one export. On failure the last
   * checkpoint is stored as `failed` so the queue's retry resumes from the
   * page that failed instead of page 1.
   */
  async runExport(options: ExportRunOptions): Promise<ExportOutcome> {
    const document = await documentService.require(options.documentId);
    const [pages, blocks, units] = await Promise.all([
      documentPagesRepo.queryByIndex('by_document', options.documentId),
      documentBlocksRepo.queryByIndex('by_document', options.documentId),
      translationUnitsRepo.queryByIndex('by_document', options.documentId),
    ]);

    const fileName = outputFileName(document.fileName, document.targetLanguage, options.format);
    const model = buildExportDocument({ document, pages, blocks, units, fileName });
    if (options.format !== 'pdf') {
      // Secondary formats need no layout plan: one worker call renders them.
      return this.runSecondaryFormat(options, document, model, fileName, options.format);
    }
    const previous = await this.readCheckpoint(options.jobId);
    await this.pruneFinishedArtifacts(options.documentId, options.jobId);

    const session = options.session ?? createExportWorkerSession();
    const createdAt = previous?.createdAt ?? Date.now();
    let signature = '';
    let painted = 0;
    try {
      const prepared = await session.prepare({
        document: model,
        fonts: exportFontSelection(),
        keepLayout: options.keepLayout,
        ...(previous ? { resume: { bytes: previous.bytes, signature: previous.signature } } : {}),
      });
      signature = prepared.signature;

      const total = prepared.pages;
      painted = prepared.resumedFrom;
      if (painted > 0) {
        logger.info('Export resumed from checkpoint', { jobId: options.jobId, painted, total });
      }
      options.onProgress?.(painted, total);

      for (let index = painted; index < total; index += 1) {
        if (options.signal?.aborted) {
          // Persist what is done so a later retry continues from here.
          await this.persistCheckpoint(options, document.projectId, session, {
            pageCount: total,
            renderedPages: painted,
            signature,
            fileName,
            state: 'rendering',
            createdAt,
          });
          return {
            jobId: options.jobId,
            fileName,
            pageCount: total,
            renderedPages: painted,
            resumedFrom: prepared.resumedFrom,
            findings: [],
            blocking: false,
            aborted: true,
          };
        }

        await session.paint(index);
        painted += 1;
        options.onProgress?.(painted, total);

        if (painted % CHECKPOINT_EVERY === 0 && painted < total) {
          await this.persistCheckpoint(options, document.projectId, session, {
            pageCount: total,
            renderedPages: painted,
            signature,
            fileName,
            state: 'rendering',
            createdAt,
          });
        }
      }

      const bytes = await session.finish({
        title: model.title,
        subject: `Translation ${document.sourceLanguage} -> ${document.targetLanguage}`,
        keywords: ['translation', document.targetLanguage],
      });

      // Persist first (IndexedDB clones the buffer), then let validation take
      // ownership of the in-memory copy for its structural probe.
      const base: ExportArtifact = {
        jobId: options.jobId,
        projectId: document.projectId,
        documentId: options.documentId,
        format: options.format,
        fileName,
        signature: prepared.signature,
        pageCount: total,
        renderedPages: total,
        state: 'ready',
        bytes,
        findings: null,
        createdAt,
        updatedAt: Date.now(),
      };
      await exportArtifactsRepo.put(base);

      const validation = await session.validate({
        bytes,
        targetLanguage: document.targetLanguage,
        expectedTargetLanguage: model.targetLanguage,
        title: model.title,
      });
      const stored = await exportArtifactsRepo.get(options.jobId);
      if (stored) {
        await exportArtifactsRepo.put({ ...stored, findings: validation.findings, updatedAt: Date.now() });
      }

      logger.info('Export finished', {
        jobId: options.jobId,
        fileName,
        pageCount: validation.pageCount,
        renderedPages: total,
        resumedFrom: prepared.resumedFrom,
        findings: validation.findings.length,
        blocking: validation.blocking,
      });

      return {
        jobId: options.jobId,
        fileName,
        pageCount: validation.pageCount,
        renderedPages: total,
        resumedFrom: prepared.resumedFrom,
        findings: validation.findings,
        blocking: validation.blocking,
        aborted: false,
      };
    } catch (error) {
      // Save the job state + completed pages before the queue sees the error.
      if (painted > 0) {
        await this.persistCheckpoint(options, document.projectId, session, {
          pageCount: painted,
          renderedPages: painted,
          signature,
          fileName,
          state: 'failed',
          createdAt,
        }).catch(() => undefined);
      }
      logger.warn('Export failed', {
        jobId: options.jobId,
        documentId: options.documentId,
        painted,
        error: toAppError(error, 'export_failed').message,
      });
      throw error;
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  /**
   * TXT/Markdown/HTML/JSON/DOCX: one worker call renders the container (no
   * page layout involved), then the same pre-download validation gates the
   * artifact. There is nothing to resume - these formats render as a unit.
   */
  private async runSecondaryFormat(
    options: ExportRunOptions,
    document: DocumentRecord,
    model: ExportDocumentInput,
    fileName: string,
    format: SecondaryFormat,
  ): Promise<ExportOutcome> {
    const session = options.session ?? createExportWorkerSession();
    const total = model.pages.length;
    try {
      options.onProgress?.(0, total);
      if (options.signal?.aborted) {
        return {
          jobId: options.jobId,
          fileName,
          pageCount: total,
          renderedPages: 0,
          resumedFrom: 0,
          findings: [],
          blocking: false,
          aborted: true,
        };
      }

      const result = await session.format({ document: model, format });
      const findings = validateSecondaryArtifact({
        targetLanguage: document.targetLanguage,
        expectedTargetLanguage: model.targetLanguage,
        title: model.title,
        pages: model.pages,
        artifact: {
          byteLength: result.bytes.byteLength,
          structurallyValid: result.structurallyValid,
        },
      });
      const blocking = hasBlockingFindings(findings);

      await exportArtifactsRepo.put({
        jobId: options.jobId,
        projectId: document.projectId,
        documentId: options.documentId,
        format,
        fileName,
        signature: '',
        pageCount: total,
        renderedPages: total,
        state: 'ready',
        bytes: result.bytes,
        findings,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      options.onProgress?.(total, total);
      logger.info('Secondary export finished', {
        jobId: options.jobId,
        fileName,
        format,
        byteLength: result.bytes.byteLength,
        blocking,
      });

      return {
        jobId: options.jobId,
        fileName,
        pageCount: total,
        renderedPages: total,
        resumedFrom: 0,
        findings,
        blocking,
        aborted: false,
      };
    } catch (error) {
      logger.warn('Secondary export failed', {
        jobId: options.jobId,
        format,
        error: toAppError(error, 'export_failed').message,
      });
      throw error;
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  /** Stored artifact for one export job (checkpoint or finished file). */
  getArtifact(jobId: string): Promise<ExportArtifact | undefined> {
    return exportArtifactsRepo.get(jobId);
  }

  /** Artifacts of the given jobs, in the order the ids were given. */
  async listByJobIds(jobIds: readonly string[]): Promise<ExportArtifact[]> {
    const records = await Promise.all(jobIds.map((jobId) => exportArtifactsRepo.get(jobId)));
    return records.filter((artifact): artifact is ExportArtifact => artifact !== undefined);
  }

  /** Newest finished artifact of a document (the UI's download entry point). */
  async latestReady(documentId: string): Promise<ExportArtifact | undefined> {
    const artifacts = await exportArtifactsRepo.queryByIndex('by_document', documentId);
    const ready = artifacts
      .filter((artifact) => artifact.state === 'ready' && artifact.bytes)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return ready[0];
  }

  private async readCheckpoint(
    jobId: string,
  ): Promise<{ bytes: ArrayBuffer; signature: string; createdAt: number } | undefined> {
    const artifact = await exportArtifactsRepo.get(jobId);
    if (!artifact?.bytes || artifact.state === 'ready') return undefined;
    if (artifact.signature === '') return undefined;
    return { bytes: artifact.bytes, signature: artifact.signature, createdAt: artifact.createdAt };
  }

  private async persistCheckpoint(
    options: ExportRunOptions,
    projectId: string,
    session: ExportWorkerSession,
    meta: {
      pageCount: number;
      renderedPages: number;
      signature: string;
      fileName: string;
      state: ExportArtifact['state'];
      createdAt: number;
    },
  ): Promise<ExportArtifact | undefined> {
    if (meta.signature === '') return undefined;
    try {
      const bytes = await session.checkpoint();
      const existing = await exportArtifactsRepo.get(options.jobId);
      const artifact: ExportArtifact = {
        jobId: options.jobId,
        projectId,
        documentId: options.documentId,
        format: options.format,
        fileName: meta.fileName,
        signature: meta.signature,
        pageCount: meta.pageCount,
        renderedPages: meta.renderedPages,
        state: meta.state,
        bytes,
        findings: existing?.findings ?? null,
        createdAt: meta.createdAt,
        updatedAt: Date.now(),
      };
      await exportArtifactsRepo.put(artifact);
      return artifact;
    } catch (error) {
      logger.warn('Export checkpoint could not be persisted', {
        jobId: options.jobId,
        error: toAppError(error, 'export_failed').message,
      });
      return undefined;
    }
  }

  /** Drops artifacts of jobs that already finished for good. */
  private async pruneFinishedArtifacts(documentId: string, currentJobId: string): Promise<void> {
    try {
      const artifacts = await exportArtifactsRepo.queryByIndex('by_document', documentId);
      for (const artifact of artifacts) {
        if (artifact.jobId === currentJobId) continue;
        const job = await jobsRepo.get(artifact.jobId);
        if (job && job.state !== 'completed' && job.state !== 'cancelled') continue;
        await exportArtifactsRepo.delete(artifact.jobId);
      }
    } catch (error) {
      logger.warn('Stale export artifacts could not be pruned', {
        documentId,
        error: toAppError(error, 'export_failed').message,
      });
    }
  }
}

/** `report.pdf` + `my` + `pdf` -> `report-my.pdf`. */
export function outputFileName(sourceFileName: string, targetLanguage: string, format: ExportFormat): string {
  const dot = sourceFileName.lastIndexOf('.');
  const base = dot > 0 ? sourceFileName.slice(0, dot) : sourceFileName;
  return `${base}-${targetLanguage}.${format}`;
}

/** User-selected export fonts, validated against the bundled catalog. */
export function exportFontSelection(): ExportFontSelection {
  const settings = settingsService.get();
  return {
    latin: isLatinFontId(settings.exportLatinFont) ? settings.exportLatinFont : DEFAULT_EXPORT_FONTS.latin,
    burmese: isBurmeseFontId(settings.exportBurmeseFont)
      ? settings.exportBurmeseFont
      : DEFAULT_EXPORT_FONTS.burmese,
  };
}

export function requireExportFormat(value: unknown): ExportFormat {
  if (value === undefined || value === null || value === '') return 'pdf';
  if (
    value === 'pdf' ||
    value === 'docx' ||
    value === 'html' ||
    value === 'txt' ||
    value === 'md' ||
    value === 'json'
  ) {
    return value;
  }
  throw new AppError(`Unsupported export format: ${String(value)}`, {
    code: 'unsupported',
    retryable: false,
  });
}

export const exportService = new ExportService();
