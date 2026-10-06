import { LIMITS } from '../config/appConfig';
import { appEvents } from '../core/events/eventBus';
import { AppError, toAppError } from '../core/errors/appError';
import { logger } from '../core/logging/logger';
import { newId } from '../core/utils/id';
import { documentBlocksRepo, documentPagesRepo, documentsRepo, translationUnitsRepo } from '../db/repositories';
import type { DocumentBlock, DocumentKind, DocumentRecord, DocumentPage, InspectionState, TranslationUnit } from '../db/entities';
import type { AnalysisProgress, DocumentMetadata, LanguageDetection, PageIR } from '../domain/analysis/ir';

export interface CreateDocumentInput {
  readonly projectId: string;
  readonly file: File;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}

/** Block/unit reading-order stride inside a page (`orderIndex = pageIndex * stride + readingOrder`). */
const ORDER_STRIDE = 100_000;

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'html', 'htm', 'json', 'csv']);
/** Everything the file picker accepts; each format has a Phase 2 extraction path. */
const ALLOWED_EXTENSIONS = new Set(['pdf', 'docx', ...TEXT_EXTENSIONS]);
const MAX_HASH_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_READ_BYTES = 8 * 1024 * 1024;
/** Sample size fed to language detection (first N chars of reading order). */
const DETECTION_SAMPLE_CHARS = 50_000;

function documentExtension(file: File): string {
  return file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() ?? '' : '';
}

function detectKind(file: File): DocumentKind {
  const extension = documentExtension(file);
  if (file.type === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (extension === 'docx') return 'rich';
  return 'text';
}

async function hashFile(file: File): Promise<string | null> {
  if (file.size > MAX_HASH_BYTES) return null;
  try {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

async function hashText(text: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    // Deterministic, non-cryptographic fallback: change detection only needs
    // stable inequality, and crypto.subtle may be unavailable on insecure origins.
    let hash = 5381;
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
    }
    return `djb2:${(hash >>> 0).toString(16)}:${text.length}`;
  }
}

/** Page-number/header/footer blocks never become translation units. */
function isFurniture(block: DocumentBlockShape): boolean {
  return block.flags.includes('page_number') || block.flags.includes('header_footer');
}

/** Structural subset of BlockIR/DocumentBlock used by the furniture filter. */
interface DocumentBlockShape {
  readonly flags: readonly ('page_number' | 'header_footer')[];
}

function pageErrorState(error: unknown): { code: string; message: string; at: number; retryable: boolean } {
  const appError = toAppError(error, 'analysis_failed');
  return { code: appError.code, message: appError.message, at: Date.now(), retryable: appError.retryable };
}

export class DocumentService {
  async getAll(): Promise<DocumentRecord[]> {
    const documents = await documentsRepo.getAll();
    return documents.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getByProject(projectId: string): Promise<DocumentRecord | undefined> {
    const documents = await documentsRepo.queryByIndex('by_project', projectId);
    return documents[0];
  }

  async get(id: string): Promise<DocumentRecord | undefined> {
    return documentsRepo.get(id);
  }

  async require(id: string): Promise<DocumentRecord> {
    const document = await this.get(id);
    if (!document) {
      throw new AppError(`Document ${id} not found`, { code: 'not_found' });
    }
    return document;
  }

  /**
   * File-picker validation (type → size → empty). Pure, no I/O, so callers can
   * validate before writing anything (e.g. before a project row exists).
   * Throws AppError with `file_type_unsupported` / `file_too_large` / `file_unreadable`.
   */
  validateSourceFile(file: File): void {
    const extension = documentExtension(file);
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new AppError(`.${extension || '?'} files are not supported`, {
        code: 'file_type_unsupported',
        retryable: false,
        details: { extension },
      });
    }
    if (file.size > LIMITS.maxSourceFileBytes) {
      throw new AppError(`${file.name} exceeds the ${Math.round(LIMITS.maxSourceFileBytes / 1024 / 1024)} MB limit`, {
        code: 'file_too_large',
        retryable: false,
        details: { limit: LIMITS.maxSourceFileBytes },
      });
    }
    const kind = detectKind(file);
    if (kind === 'text' && file.size > LIMITS.maxTextFileBytes) {
      throw new AppError(`${file.name} exceeds the ${Math.round(LIMITS.maxTextFileBytes / 1024 / 1024)} MB text limit`, {
        code: 'file_too_large',
        retryable: false,
        details: { limit: LIMITS.maxTextFileBytes },
      });
    }
    if (file.size === 0) {
      throw new AppError(`${file.name} is empty`, { code: 'file_unreadable', retryable: false });
    }
  }

  async create(input: CreateDocumentInput): Promise<DocumentRecord> {
    this.validateSourceFile(input.file);

    const timestamp = Date.now();
    const kind = detectKind(input.file);
    let charCount: number | null = null;
    if (kind === 'text' && input.file.size <= MAX_TEXT_READ_BYTES) {
      const text = await input.file.text();
      charCount = text.length;
    }

    const document: DocumentRecord = {
      id: newId('doc'),
      projectId: input.projectId,
      kind,
      fileName: input.file.name,
      fileSize: input.file.size,
      mimeType: input.file.type,
      lastModified: input.file.lastModified,
      checksum: await hashFile(input.file),
      payload: input.file.size <= LIMITS.maxSourceFileBytes ? input.file : null,
      payloadStored: input.file.size <= LIMITS.maxSourceFileBytes,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      pageCount: null,
      charCount,
      inspectionState: 'pending',
      analysis: null,
      languageDetection: null,
      metadata: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      await documentsRepo.put(document);
    } catch (error) {
      throw toAppError(error, 'db_operation_failed');
    }
    appEvents.emit('documents:changed', { documentId: document.id, projectId: document.projectId });
    return document;
  }

  async update(
    documentId: string,
    patch: Partial<
      Pick<
        DocumentRecord,
        | 'sourceLanguage'
        | 'targetLanguage'
        | 'checksum'
        | 'payload'
        | 'payloadStored'
        | 'pageCount'
        | 'charCount'
        | 'inspectionState'
        | 'fileName'
        | 'fileSize'
        | 'mimeType'
        | 'lastModified'
        | 'analysis'
        | 'languageDetection'
        | 'metadata'
      >
    >,
  ): Promise<DocumentRecord> {
    const document = await this.require(documentId);
    const next: DocumentRecord = { ...document, ...patch, updatedAt: Date.now() };
    await documentsRepo.put(next);
    appEvents.emit('documents:changed', { documentId, projectId: document.projectId });
    return next;
  }

  async pages(documentId: string): Promise<DocumentPage[]> {
    const pages = await documentPagesRepo.queryByIndex('by_document', documentId);
    return pages.sort((a, b) => a.pageIndex - b.pageIndex);
  }

  async blocksOfPage(pageId: string): Promise<DocumentBlock[]> {
    const blocks = await documentBlocksRepo.queryByIndex('by_page', pageId);
    return blocks.sort((a, b) => a.readingOrder - b.readingOrder);
  }

  async blocksOfDocument(documentId: string): Promise<DocumentBlock[]> {
    const blocks = await documentBlocksRepo.queryByIndex('by_document', documentId);
    return blocks.sort((a, b) => a.orderIndex - b.orderIndex);
  }

  /**
   * Deterministic text sample (reading order) for language detection; works on
   * resumed runs because it reads persisted blocks, not the current run.
   */
  async sampleText(documentId: string, maxChars: number = DETECTION_SAMPLE_CHARS): Promise<string> {
    const blocks = await this.blocksOfDocument(documentId);
    const parts: string[] = [];
    let total = 0;
    for (const block of blocks) {
      if (total >= maxChars) break;
      parts.push(block.text);
      total += block.text.length;
    }
    return parts.join('\n');
  }

  /* ---------------------------------------------------------------- */
  /* Phase 2 analysis persistence (per page / per block, resumable).   */
  /* ---------------------------------------------------------------- */

  /**
   * Opens an analysis run once the source is parsed: records page count and
   * metadata, adds `pending` placeholders for pages that never ran, seeds the
   * progress counters from already-persisted pages, and resets `failedPages`
   * (failed pages are retried this run).
   */
  async beginAnalysis(
    documentId: string,
    info: { pageCount: number; metadata: DocumentMetadata | null },
  ): Promise<DocumentRecord> {
    const document = await this.require(documentId);
    const timestamp = Date.now();
    const existing = await this.pages(documentId);

    const stale = existing.filter((page) => page.pageIndex >= info.pageCount);
    if (stale.length > 0) {
      await this.deletePageRecords(documentId, stale);
    }

    const present = new Set(existing.filter((page) => page.pageIndex < info.pageCount).map((page) => page.pageIndex));
    const placeholders: DocumentPage[] = [];
    for (let index = 0; index < info.pageCount; index += 1) {
      if (present.has(index)) continue;
      placeholders.push({
        id: `${documentId}_p${index}`,
        projectId: document.projectId,
        documentId,
        pageIndex: index,
        width: 0,
        height: 0,
        rotation: 0,
        charCount: 0,
        unitCount: 0,
        status: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    if (placeholders.length > 0) {
      await documentPagesRepo.putMany(placeholders);
    }

    const kept = existing.filter((page) => page.pageIndex < info.pageCount);
    const processedPages = kept.filter(
      (page) => page.analyzedAt !== undefined && (page.status === 'ready' || page.status === 'needs_ocr'),
    ).length;
    const blocks = kept.reduce((sum, page) => sum + (page.blockCount ?? 0), 0);

    const analysis: AnalysisProgress = {
      stage: 'page_analysis',
      task: 'analyzing_pages',
      processedPages,
      totalPages: info.pageCount,
      blocks,
      failedPages: 0,
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    const next: DocumentRecord = {
      ...document,
      pageCount: info.pageCount,
      inspectionState: 'running',
      analysis,
      metadata: info.metadata,
      updatedAt: timestamp,
    };
    await documentsRepo.put(next);
    if (stale.length > 0 || placeholders.length > 0) {
      appEvents.emit('pages:changed', { documentId });
    }
    appEvents.emit('documents:changed', { documentId, projectId: document.projectId });
    emitProgress(next, analysis, 0);
    return next;
  }

  /**
   * Upserts one analyzed page: page record (commit marker, written last within
   * the page), its blocks, and its translation units. Existing units whose
   * `sourceChecksum` is unchanged are preserved verbatim so re-analysis never
   * discards translations; stale rows for the page are removed.
   */
  async applyPageAnalysis(documentId: string, page: PageIR): Promise<void> {
    const document = await this.require(documentId);
    const timestamp = Date.now();

    const existingPage = await documentPagesRepo.get(page.id);
    const existingBlocks = await this.blocksOfPage(page.id);
    const existingBlockById = new Map(existingBlocks.map((block) => [block.id, block]));
    const existingUnits = await translationUnitsRepo.queryByIndex('by_page', page.id);
    const existingUnitById = new Map(existingUnits.map((unit) => [unit.id, unit]));

    const blockRecords: DocumentBlock[] = page.blocks.map((block) => ({
      id: block.id,
      projectId: document.projectId,
      documentId,
      pageId: page.id,
      pageIndex: page.index,
      readingOrder: block.readingOrder,
      orderIndex: page.index * ORDER_STRIDE + block.readingOrder,
      kind: block.kind,
      text: block.text,
      bbox: block.bbox,
      font: block.font,
      alignment: block.alignment,
      headingLevel: block.headingLevel ?? null,
      listOrdered: block.listOrdered ?? null,
      table: block.table ?? null,
      link: block.link ?? null,
      flags: block.flags,
      lines: block.lines,
      createdAt: existingBlockById.get(block.id)?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }));

    const translatable = page.blocks.filter((block) => !isFurniture(block));
    const checksums = await Promise.all(translatable.map((block) => hashText(block.text)));
    const unitRecords: TranslationUnit[] = translatable.map((block, index) => {
      const checksum = checksums[index] ?? '';
      const prior = existingUnitById.get(block.id);
      // Unchanged source: keep the unit verbatim (translation, counters, ages).
      if (prior && prior.sourceChecksum === checksum) return prior;
      return {
        id: block.id,
        projectId: document.projectId,
        documentId,
        pageId: page.id,
        blockId: block.id,
        orderIndex: page.index * ORDER_STRIDE + block.readingOrder,
        sourceText: block.text,
        sourceLanguage: document.languageDetection?.code ?? document.sourceLanguage,
        targetLanguage: document.targetLanguage,
        translatedText: null,
        status: 'pending',
        retryCount: 0,
        provider: null,
        model: null,
        keyId: null,
        estimatedTokens: null,
        actualTokens: null,
        error: null,
        sourceChecksum: checksum,
        createdAt: prior?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
    });

    const nextBlockIds = new Set(blockRecords.map((block) => block.id));
    const staleBlockIds = existingBlocks.filter((block) => !nextBlockIds.has(block.id)).map((block) => block.id);
    const nextUnitIds = new Set(unitRecords.map((unit) => unit.id));
    const staleUnitIds = existingUnits.filter((unit) => !nextUnitIds.has(unit.id)).map((unit) => unit.id);

    // Page record is the commit marker: it lands after its rows so a crash
    // mid-page causes the page to simply be re-analyzed on resume.
    if (staleBlockIds.length > 0) await documentBlocksRepo.deleteMany(staleBlockIds);
    await documentBlocksRepo.putMany(blockRecords);
    if (staleUnitIds.length > 0) await translationUnitsRepo.deleteMany(staleUnitIds);
    await translationUnitsRepo.putMany(unitRecords);

    const pageRecord: DocumentPage = {
      id: page.id,
      projectId: document.projectId,
      documentId,
      pageIndex: page.index,
      width: page.width,
      height: page.height,
      rotation: page.rotation,
      charCount: page.charCount,
      unitCount: unitRecords.length,
      status: page.requiresOcr ? 'needs_ocr' : 'ready',
      blockCount: page.blocks.length,
      error: null,
      analyzedAt: timestamp,
      createdAt: existingPage?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await documentPagesRepo.put(pageRecord);

    const analysis: AnalysisProgress = document.analysis ?? {
      stage: 'page_analysis',
      task: 'analyzing_pages',
      processedPages: 0,
      totalPages: page.index + 1,
      blocks: 0,
      failedPages: 0,
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    // A page already counted by `beginAnalysis` (an OCR retry re-applies a
    // `needs_ocr` page) must not be counted twice, and its previous blocks
    // have to be replaced instead of added to.
    const alreadyCounted = existingPage?.analyzedAt !== undefined;
    const previousBlocks = existingPage?.blockCount ?? 0;
    const nextAnalysis: AnalysisProgress = {
      ...analysis,
      processedPages: alreadyCounted ? analysis.processedPages : analysis.processedPages + 1,
      blocks: Math.max(0, analysis.blocks - previousBlocks + page.blocks.length),
      updatedAt: timestamp,
    };
    const next: DocumentRecord = { ...document, analysis: nextAnalysis, updatedAt: timestamp };
    await documentsRepo.put(next);

    appEvents.emit('pages:changed', { documentId });
    if (unitRecords.length > 0 || staleUnitIds.length > 0) {
      appEvents.emit('units:changed', { documentId });
    }
    emitProgress(next, nextAnalysis, page.index + 1);
  }

  /** Records a per-page failure without stopping the run; retried on the next run. */
  async markPageFailed(documentId: string, pageIndex: number, error: unknown): Promise<void> {
    const document = await this.require(documentId);
    const timestamp = Date.now();
    const id = `${documentId}_p${pageIndex}`;
    const existing = await documentPagesRepo.get(id);
    const pageRecord: DocumentPage = {
      id,
      projectId: document.projectId,
      documentId,
      pageIndex,
      width: existing?.width ?? 0,
      height: existing?.height ?? 0,
      rotation: existing?.rotation ?? 0,
      charCount: existing?.charCount ?? 0,
      unitCount: existing?.unitCount ?? 0,
      status: 'failed',
      blockCount: existing?.blockCount,
      error: pageErrorState(error),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await documentPagesRepo.put(pageRecord);

    const analysis = document.analysis;
    const next: DocumentRecord = analysis
      ? {
          ...document,
          analysis: { ...analysis, failedPages: analysis.failedPages + 1, updatedAt: timestamp },
          updatedAt: timestamp,
        }
      : { ...document, updatedAt: timestamp };
    await documentsRepo.put(next);

    appEvents.emit('pages:changed', { documentId });
    if (analysis) emitProgress(next, next.analysis ?? analysis, pageIndex + 1);
  }

  /** Stores the detection result and syncs it onto every unit of the document. */
  async setLanguageDetection(documentId: string, detection: LanguageDetection): Promise<void> {
    const document = await this.require(documentId);
    const timestamp = Date.now();
    const analysis: AnalysisProgress | null = document.analysis
      ? { ...document.analysis, stage: 'language', task: 'detecting_language', updatedAt: timestamp }
      : null;
    const next: DocumentRecord = {
      ...document,
      languageDetection: detection,
      analysis,
      updatedAt: timestamp,
    };
    await documentsRepo.put(next);

    const units = await translationUnitsRepo.queryByIndex('by_document', documentId);
    // An `unknown` detection must not overwrite a known language on the units.
    const changed = detection.code === 'unknown' ? [] : units.filter((unit) => unit.sourceLanguage !== detection.code);
    if (changed.length > 0) {
      await translationUnitsRepo.putMany(
        changed.map((unit) => ({ ...unit, sourceLanguage: detection.code, updatedAt: timestamp })),
      );
      appEvents.emit('units:changed', { documentId });
    }

    appEvents.emit('documents:changed', { documentId, projectId: document.projectId });
    if (analysis) emitProgress(next, analysis, 0);
  }

  /**
   * User-confirmed source language: applied to the document and every unit so
   * later translation uses what the human chose rather than the measurement.
   */
  async confirmSourceLanguage(documentId: string, code: string): Promise<void> {
    const document = await this.require(documentId);
    const timestamp = Date.now();
    await documentsRepo.put({ ...document, sourceLanguage: code, updatedAt: timestamp });

    const units = await translationUnitsRepo.queryByIndex('by_document', documentId);
    const changed = units.filter((unit) => unit.sourceLanguage !== code);
    if (changed.length > 0) {
      await translationUnitsRepo.putMany(
        changed.map((unit) => ({ ...unit, sourceLanguage: code, updatedAt: timestamp })),
      );
    }

    appEvents.emit('documents:changed', { documentId, projectId: document.projectId });
    appEvents.emit('units:changed', { documentId });
  }

  /**
   * User-chosen target language: applied to the document and every unit so
   * validation, memory matching and the workspace all see the language the
   * human actually selected (workflow step: pick target before translating).
   */
  async setTargetLanguage(documentId: string, code: string): Promise<void> {
    const document = await this.require(documentId);
    const timestamp = Date.now();
    await documentsRepo.put({ ...document, targetLanguage: code, updatedAt: timestamp });

    const units = await translationUnitsRepo.queryByIndex('by_document', documentId);
    const changed = units.filter((unit) => unit.targetLanguage !== code);
    if (changed.length > 0) {
      await translationUnitsRepo.putMany(
        changed.map((unit) => ({ ...unit, targetLanguage: code, updatedAt: timestamp })),
      );
    }

    appEvents.emit('documents:changed', { documentId, projectId: document.projectId });
    appEvents.emit('units:changed', { documentId });
  }

  /**
   * Recomputes counters from persisted pages (authoritative after a run,
   * including resumed/partial ones) and marks the analysis done.
   */
  async finishAnalysis(documentId: string): Promise<void> {    const document = await this.require(documentId);
    const timestamp = Date.now();
    const pages = await this.pages(documentId);
    const processedPages = pages.filter(
      (page) => page.analyzedAt !== undefined && (page.status === 'ready' || page.status === 'needs_ocr'),
    ).length;
    const failedPages = pages.filter((page) => page.status === 'failed').length;
    const blocks = pages.reduce((sum, page) => sum + (page.blockCount ?? 0), 0);
    const charCount = pages.reduce((sum, page) => sum + (page.charCount ?? 0), 0);

    const analysis: AnalysisProgress = {
      stage: 'done',
      task: 'idle',
      processedPages,
      totalPages: document.pageCount ?? pages.length,
      blocks,
      failedPages,
      startedAt: document.analysis?.startedAt ?? timestamp,
      updatedAt: timestamp,
    };
    const inspectionState: InspectionState = processedPages === 0 && failedPages > 0 ? 'failed' : 'ready';
    const next: DocumentRecord = { ...document, inspectionState, charCount, analysis, updatedAt: timestamp };
    await documentsRepo.put(next);

    appEvents.emit('documents:changed', { documentId, projectId: document.projectId });
    appEvents.emit('pages:changed', { documentId });
    emitProgress(next, analysis, 0);
  }

  /** Catastrophic analysis failure (open failed, payload missing, ...). */
  async failAnalysis(documentId: string, error: unknown): Promise<void> {
    const document = await this.get(documentId);
    if (!document) return;
    const timestamp = Date.now();
    const appError = toAppError(error, 'analysis_failed');
    const previous = document.analysis;
    const analysis: AnalysisProgress = {
      stage: 'failed',
      task: 'idle',
      processedPages: previous?.processedPages ?? 0,
      totalPages: previous?.totalPages ?? document.pageCount ?? 0,
      blocks: previous?.blocks ?? 0,
      failedPages: previous?.failedPages ?? 0,
      startedAt: previous?.startedAt ?? timestamp,
      updatedAt: timestamp,
    };
    const next: DocumentRecord = { ...document, inspectionState: 'failed', analysis, updatedAt: timestamp };
    await documentsRepo.put(next);
    logger.warn('Analysis failed', { documentId, code: appError.code });
    appEvents.emit('documents:changed', { documentId, projectId: document.projectId });
    emitProgress(next, analysis, 0);
  }

  async readPayload(documentId: string): Promise<ArrayBuffer> {
    const document = await this.require(documentId);
    if (!document.payload || !document.payloadStored) {
      throw new AppError('Source file is not stored locally. Re-import it to run analysis.', {
        code: 'file_unreadable',
        retryable: false,
      });
    }
    return document.payload.arrayBuffer();
  }

  /** Removes the document plus its pages, blocks, and units. */
  async remove(documentId: string): Promise<void> {
    const document = await this.get(documentId);
    if (!document) return;

    const [pages, blocks, units] = await Promise.all([
      documentPagesRepo.queryByIndex('by_document', documentId),
      documentBlocksRepo.queryByIndex('by_document', documentId),
      translationUnitsRepo.queryByIndex('by_document', documentId),
    ]);
    if (pages.length > 0) await documentPagesRepo.deleteMany(pages.map((page) => page.id));
    if (blocks.length > 0) await documentBlocksRepo.deleteMany(blocks.map((block) => block.id));
    if (units.length > 0) await translationUnitsRepo.deleteMany(units.map((unit) => unit.id));
    await documentsRepo.delete(documentId);

    appEvents.emit('pages:changed', { documentId });
    appEvents.emit('units:changed', { documentId });
    appEvents.emit('documents:changed', { documentId, projectId: document.projectId });
  }

  /** Deletes pages together with their blocks and units. */
  private async deletePageRecords(documentId: string, pages: readonly DocumentPage[]): Promise<void> {
    if (pages.length === 0) return;
    const pageIds = new Set(pages.map((page) => page.id));
    const [blocks, units] = await Promise.all([
      documentBlocksRepo.queryByIndex('by_document', documentId),
      translationUnitsRepo.queryByIndex('by_document', documentId),
    ]);
    const staleBlocks = blocks.filter((block) => pageIds.has(block.pageId));
    const staleUnits = units.filter((unit) => pageIds.has(unit.pageId));
    if (staleBlocks.length > 0) await documentBlocksRepo.deleteMany(staleBlocks.map((block) => block.id));
    if (staleUnits.length > 0) await translationUnitsRepo.deleteMany(staleUnits.map((unit) => unit.id));
    await documentPagesRepo.deleteMany(pages.map((page) => page.id));
  }
}

function emitProgress(document: DocumentRecord, analysis: AnalysisProgress, page: number): void {
  appEvents.emit('analysis:progress', {
    documentId: document.id,
    projectId: document.projectId,
    stage: analysis.stage,
    task: analysis.task,
    page,
    pageCount: analysis.totalPages,
    analyzed: analysis.processedPages,
    blocks: analysis.blocks,
    failed: analysis.failedPages,
  });
}

export const documentService = new DocumentService();
