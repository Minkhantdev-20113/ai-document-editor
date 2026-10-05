import { QUEUE_DEFAULTS, type ExportFormat } from '../config/appConfig';
import { AppError } from '../core/errors/appError';
import { logger } from '../core/logging/logger';
import { documentService } from '../services/documentService';
import { projectService } from '../services/projectService';
import {
  DEFAULT_STRATEGY,
  isTranslationStrategy,
  translationService,
  type TranslationStrategy,
} from '../services/translationService';
import type { JobRecord } from '../db/entities';
import type { Project } from '../db/entities';
import { jobQueue } from './jobQueue';

/**
 * UI-facing job actions.
 * These are the only entry points that enqueue work, so validation and
 * project/status bookkeeping stay in one place.
 */
export async function startInspection(project: Project): Promise<JobRecord> {
  if (!project.documentId) {
    throw new AppError('This project has no source document', { code: 'validation', retryable: false });
  }
  const document = await documentService.get(project.documentId);
  if (!document) {
    throw new AppError('Source document was not found', { code: 'not_found', retryable: false });
  }
  if (!document.payloadStored || !document.payload) {
    throw new AppError('Source file is not stored locally. Re-import it to run inspection.', {
      code: 'file_unreadable',
      retryable: false,
    });
  }

  // Prevent duplicate work while an inspection is already queued or running.
  const existing = await jobQueue.list({ projectId: project.id });
  const duplicate = existing.find(
    (job) =>
      job.type === 'inspect_document' &&
      (job.state === 'queued' ||
        job.state === 'analyzing' ||
        job.state === 'translating' ||
        job.state === 'retrying' ||
        job.state === 'paused'),
  );
  if (duplicate) {
    logger.info('Inspection already queued', { jobId: duplicate.id, projectId: project.id });
    return duplicate;
  }

  await documentService.update(document.id, { inspectionState: 'pending' });
  await projectService.setStatus(project.id, 'queued');

  try {
    return await jobQueue.enqueue({
      type: 'inspect_document',
      label: `${project.name} · inspect`,
      projectId: project.id,
      documentId: document.id,
      payload: {
        documentId: document.id,
        projectId: project.id,
        // Analysis persists page by page, so it gets a larger time window than
        // the queue default before being aborted and resumed.
        jobTimeoutMs: QUEUE_DEFAULTS.analysisJobTimeoutMs,
      },
      priority: 1,
    });
  } catch (error) {
    await projectService.setStatus(project.id, 'draft').catch(() => undefined);
    await documentService.update(document.id, { inspectionState: 'failed' }).catch(() => undefined);
    throw error;
  }
}

/** Convenience wrapper used by list/detail views. */
export async function startInspectionById(projectId: string): Promise<JobRecord> {
  const project = await projectService.require(projectId);
  return startInspection(project);
}

/**
 * Enqueues a translation job for a project's document (Phase 3).
 *
 * Validates up front (document stored, at least one enabled provider with
 * usable keys) so the user gets an immediate, typed error instead of a job
 * that fails a second later. An existing non-terminal job for the same
 * document is returned instead of a duplicate.
 */
export async function startTranslation(
  project: Project,
  options: { readonly strategy?: TranslationStrategy } = {},
): Promise<JobRecord> {
  if (!project.documentId) {
    throw new AppError('This project has no source document', { code: 'validation', retryable: false });
  }
  const document = await documentService.get(project.documentId);
  if (!document) {
    throw new AppError('Source document was not found', { code: 'not_found', retryable: false });
  }

  const candidates = await translationService.resolveCandidates();
  if (candidates.length === 0) {
    throw new AppError(
      'No enabled provider with usable API keys is configured. Add and verify a key first.',
      { code: 'provider_unavailable', retryable: false },
    );
  }

  const duplicate = (await jobQueue.listRecent(100)).find(
    (job) =>
      job.type === 'translate_document' &&
      job.documentId === document.id &&
      !['completed', 'failed', 'cancelled'].includes(job.state),
  );
  if (duplicate) {
    logger.info('Translation already queued', { jobId: duplicate.id, documentId: document.id });
    return duplicate;
  }

  // The workflow's strategy choice travels with the job so a resume after a
  // refresh keeps batching/sampling exactly as configured.
  const strategy = isTranslationStrategy(options.strategy) ? options.strategy : DEFAULT_STRATEGY;
  await projectService.setStatus(project.id, 'queued');
  try {
    return await jobQueue.enqueue({
      type: 'translate_document',
      label: `${project.name} · translate`,
      projectId: project.id,
      documentId: document.id,
      payload: {
        documentId: document.id,
        projectId: project.id,
        strategy,
        // Translation is a long, batched run with failover waits between
        // attempts, so it gets a much larger window than the queue default.
        jobTimeoutMs: QUEUE_DEFAULTS.translationJobTimeoutMs,
      },
      priority: 2,
    });
  } catch (error) {
    await projectService.setStatus(project.id, 'draft').catch(() => undefined);
    throw error;
  }
}

/** Convenience wrapper used by workspace/detail views. */
export async function startTranslationById(
  projectId: string,
  options: { readonly strategy?: TranslationStrategy } = {},
): Promise<JobRecord> {
  const project = await projectService.require(projectId);
  return startTranslation(project, options);
}

/**
 * Enqueues an export job for a project's document (Phase 5).
 *
 * The document must be analyzed (layout reconstruction needs blocks and page
 * geometry); missing translations are allowed - the planner falls back to the
 * source text and the pre-download validation reports every untranslated block
 * instead of silently producing a partial file.
 *
 * Returns whether a *new* job was enqueued: an export already queued or
 * running for the same document is returned unchanged (`created: false`) so
 * callers can report it honestly instead of pretending they queued a second
 * copy.
 */
export async function startExport(
  project: Project,
  options: { readonly format?: ExportFormat; readonly keepLayout?: boolean } = {},
): Promise<{ readonly job: JobRecord; readonly created: boolean }> {
  if (!project.documentId) {
    throw new AppError('This project has no source document', { code: 'validation', retryable: false });
  }
  const document = await documentService.get(project.documentId);
  if (!document) {
    throw new AppError('Source document was not found', { code: 'not_found', retryable: false });
  }
  if (document.inspectionState !== 'ready') {
    throw new AppError('Analyze the document before exporting it', {
      code: 'validation',
      retryable: false,
    });
  }

  // Prevent duplicate work while an export is already queued or running.
  const existing = await jobQueue.listRecent(100);
  const duplicate = existing.find(
    (job) =>
      job.type === 'export_document' &&
      job.documentId === document.id &&
      (job.state === 'queued' ||
        job.state === 'exporting' ||
        job.state === 'retrying' ||
        job.state === 'paused'),
  );
  if (duplicate) {
    logger.info('Export already queued', { jobId: duplicate.id, projectId: project.id });
    return { job: duplicate, created: false };
  }

  const format = options.format ?? 'pdf';
  const keepLayout = options.keepLayout ?? true;
  await projectService.setExportState(project.id, 'queued');

  try {
    const job = await jobQueue.enqueue({
      type: 'export_document',
      label: `${project.name} · export`,
      projectId: project.id,
      documentId: document.id,
      payload: {
        documentId: document.id,
        projectId: project.id,
        format,
        keepLayout,
        jobTimeoutMs: QUEUE_DEFAULTS.exportJobTimeoutMs,
      },
      priority: 2,
    });
    return { job, created: true };
  } catch (error) {
    await projectService.setExportState(project.id, 'not_started').catch(() => undefined);
    throw error;
  }
}
