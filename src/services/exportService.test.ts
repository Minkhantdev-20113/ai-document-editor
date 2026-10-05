import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DocumentBlock, DocumentPage, DocumentRecord, TranslationUnit } from '../db/entities';
import {
  documentBlocksRepo,
  documentPagesRepo,
  documentsRepo,
  exportArtifactsRepo,
  translationUnitsRepo,
} from '../db/repositories';
import type { ExportWorkerSession } from '../workers/exportClient';
import type {
  ExportFormatResult,
  ExportPrepareResult,
  ExportValidateResult,
} from '../workers/exportProtocol';
import { exportService, outputFileName, requireExportFormat } from './exportService';

const T0 = 1_700_000_000_000;

function makeDocument(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: 'doc_1',
    projectId: 'proj_1',
    kind: 'pdf',
    fileName: 'report.pdf',
    fileSize: 2_048,
    mimeType: 'application/pdf',
    lastModified: T0,
    checksum: null,
    payload: null,
    payloadStored: false,
    sourceLanguage: 'en',
    targetLanguage: 'my',
    pageCount: 3,
    charCount: 300,
    inspectionState: 'ready',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function makePage(pageIndex: number): DocumentPage {
  return {
    id: `page_${pageIndex}`,
    projectId: 'proj_1',
    documentId: 'doc_1',
    pageIndex,
    width: 595,
    height: 842,
    rotation: 0,
    charCount: 100,
    unitCount: 1,
    status: 'ready',
    blockCount: 1,
    createdAt: T0,
    updatedAt: T0,
  };
}

function makeBlock(pageIndex: number): DocumentBlock {
  return {
    id: `page_${pageIndex}_b0`,
    projectId: 'proj_1',
    documentId: 'doc_1',
    pageId: `page_${pageIndex}`,
    pageIndex,
    readingOrder: 0,
    orderIndex: pageIndex * 100_000,
    kind: 'paragraph',
    text: `Source ${pageIndex}`,
    bbox: { x: 72, y: 700, width: 450, height: 20 },
    font: { family: 'Times New Roman', size: 12, bold: false, italic: false },
    alignment: 'left',
    headingLevel: null,
    listOrdered: null,
    table: null,
    link: null,
    flags: [],
    lines: [],
    createdAt: T0,
    updatedAt: T0,
  };
}

function makeUnit(pageIndex: number): TranslationUnit {
  const blockId = `page_${pageIndex}_b0`;
  return {
    id: blockId,
    projectId: 'proj_1',
    documentId: 'doc_1',
    pageId: `page_${pageIndex}`,
    blockId,
    orderIndex: pageIndex * 100_000,
    sourceText: `Source ${pageIndex}`,
    sourceLanguage: 'en',
    targetLanguage: 'my',
    translatedText: `ဘာသာပြန် ${pageIndex}`,
    status: 'translated',
    retryCount: 0,
    provider: null,
    model: null,
    keyId: null,
    estimatedTokens: null,
    actualTokens: null,
    error: null,
    sourceChecksum: 'checksum',
    createdAt: T0,
    updatedAt: T0,
  };
}

interface FakeSessionOptions {
  readonly pages?: number;
  /** `paint(index)` rejects for this index (simulates a rendering crash). */
  readonly failAtPaint?: number;
  /** Resume point the fake `prepare` reports when a checkpoint is supplied. */
  readonly resumePoint?: number;
}

function makeFakeSession(options: FakeSessionOptions = {}) {
  const pages = options.pages ?? 3;
  const state = {
    prepare: [] as { hasResume: boolean; signature: string | null; documentId: string }[],
    painted: [] as number[],
    checkpoints: 0,
    validations: 0,
    formats: 0,
    closes: 0,
  };

  const session: ExportWorkerSession = {
    async prepare(request): Promise<ExportPrepareResult> {
      state.prepare.push({
        hasResume: Boolean(request.resume),
        signature: request.resume?.signature ?? null,
        documentId: request.document.documentId,
      });
      const resumedFrom =
        request.resume && options.resumePoint !== undefined ? options.resumePoint : 0;
      return {
        pages,
        warnings: [],
        stats: { sourcePages: pages, pages, blocks: pages, characters: 120 },
        signature: 'sig-1',
        resumedFrom,
      };
    },
    async paint(index): Promise<number> {
      if (options.failAtPaint === index) {
        throw new Error('render exploded');
      }
      state.painted.push(index);
      return index;
    },
    async checkpoint(): Promise<ArrayBuffer> {
      state.checkpoints += 1;
      return new Uint8Array([1, 2, 3, 4]).buffer;
    },
    async finish(): Promise<ArrayBuffer> {
      return new Uint8Array([8, 6, 7, 5]).buffer;
    },
    async validate(): Promise<ExportValidateResult> {
      state.validations += 1;
      return {
        findings: [{ code: 'missing_translation', severity: 'warning', pageIndex: 0 }],
        pageCount: pages,
        structurallyValid: true,
        blocking: false,
      };
    },
    async format(): Promise<ExportFormatResult> {
      state.formats += 1;
      return {
        bytes: new Uint8Array([116, 120, 116]).buffer,
        structurallyValid: true,
      };
    },
    async close(): Promise<void> {
      state.closes += 1;
    },
  };

  return { session, state };
}

beforeEach(async () => {
  await documentsRepo.clear();
  await documentPagesRepo.clear();
  await documentBlocksRepo.clear();
  await translationUnitsRepo.clear();
  await exportArtifactsRepo.clear();
  await documentsRepo.put(makeDocument());
  await documentPagesRepo.putMany([makePage(0), makePage(1), makePage(2)]);
  await documentBlocksRepo.putMany([makeBlock(0), makeBlock(1), makeBlock(2)]);
  await translationUnitsRepo.putMany([makeUnit(0), makeUnit(1), makeUnit(2)]);
});

describe('exportService.runExport (Phase 5)', () => {
  it('renders, validates and persists a ready artifact with its findings', async () => {
    const { session, state } = makeFakeSession({ pages: 3 });
    const progress: [number, number][] = [];

    const outcome = await exportService.runExport({
      jobId: 'job_1',
      documentId: 'doc_1',
      format: 'pdf',
      keepLayout: true,
      session,
      onProgress: (processed, total) => progress.push([processed, total]),
    });

    expect(outcome.aborted).toBe(false);
    expect(outcome.fileName).toBe('report-my.pdf');
    expect(outcome.pageCount).toBe(3);
    expect(outcome.resumedFrom).toBe(0);
    expect(outcome.blocking).toBe(false);
    expect(outcome.findings).toHaveLength(1);
    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(state.painted).toEqual([0, 1, 2]);
    expect(state.validations).toBe(1);
    expect(state.closes).toBe(1);

    const artifact = await exportService.getArtifact('job_1');
    expect(artifact?.state).toBe('ready');
    expect(artifact?.format).toBe('pdf');
    expect(artifact?.fileName).toBe('report-my.pdf');
    expect(artifact?.renderedPages).toBe(3);
    expect(artifact?.signature).toBe('sig-1');
    expect(artifact?.bytes).not.toBeNull();
    expect(artifact?.findings).toHaveLength(1);
    expect(await exportService.latestReady('doc_1')).toMatchObject({ jobId: 'job_1' });
  });

  it('saves a failed checkpoint so a retry resumes from the failed page', async () => {
    const first = makeFakeSession({ pages: 3, failAtPaint: 1 });

    await expect(
      exportService.runExport({
        jobId: 'job_2',
        documentId: 'doc_1',
        format: 'pdf',
        keepLayout: true,
        session: first.session,
      }),
    ).rejects.toThrow('render exploded');
    expect(first.state.closes).toBe(1);

    const failed = await exportArtifactsRepo.get('job_2');
    expect(failed?.state).toBe('failed');
    expect(failed?.renderedPages).toBe(1);
    expect(failed?.signature).toBe('sig-1');
    expect(failed?.bytes).not.toBeNull();

    const retry = makeFakeSession({ pages: 3, resumePoint: 1 });
    const outcome = await exportService.runExport({
      jobId: 'job_2',
      documentId: 'doc_1',
      format: 'pdf',
      keepLayout: true,
      session: retry.session,
    });

    expect(retry.state.prepare[0]).toMatchObject({ hasResume: true, signature: 'sig-1' });
    expect(retry.state.painted).toEqual([1, 2]);
    expect(outcome.resumedFrom).toBe(1);
    expect(outcome.renderedPages).toBe(3);
    expect(outcome.aborted).toBe(false);

    const ready = await exportArtifactsRepo.get('job_2');
    expect(ready?.state).toBe('ready');
    expect(ready?.renderedPages).toBe(3);
  });

  it('persists progress and stops immediately when cancelled', async () => {
    const { session, state } = makeFakeSession({ pages: 3 });
    const controller = new AbortController();

    const outcome = await exportService.runExport({
      jobId: 'job_3',
      documentId: 'doc_1',
      format: 'pdf',
      keepLayout: true,
      session,
      signal: controller.signal,
      onProgress: (processed) => {
        if (processed >= 1) controller.abort();
      },
    });

    expect(outcome.aborted).toBe(true);
    expect(outcome.renderedPages).toBe(1);
    expect(state.painted).toEqual([0]);
    expect(state.closes).toBe(1);

    const artifact = await exportArtifactsRepo.get('job_3');
    expect(artifact?.state).toBe('rendering');
    expect(artifact?.renderedPages).toBe(1);
    expect(artifact?.bytes).not.toBeNull();
  });

  it('renders secondary formats in one worker call and stores the artifact', async () => {
    const { session, state } = makeFakeSession({ pages: 3 });
    const progress: [number, number][] = [];

    const outcome = await exportService.runExport({
      jobId: 'job_md',
      documentId: 'doc_1',
      format: 'md',
      keepLayout: true,
      session,
      onProgress: (processed, total) => progress.push([processed, total]),
    });

    expect(state.prepare).toEqual([]); // no layout plan for secondary formats
    expect(state.formats).toBe(1);
    expect(state.closes).toBe(1);
    expect(outcome.fileName).toBe('report-my.md');
    expect(outcome.aborted).toBe(false);
    expect(outcome.blocking).toBe(false);
    expect(progress).toEqual([
      [0, 3],
      [3, 3],
    ]);

    const artifact = await exportArtifactsRepo.get('job_md');
    expect(artifact?.state).toBe('ready');
    expect(artifact?.format).toBe('md');
    expect(artifact?.renderedPages).toBe(3);
    expect(artifact?.bytes).not.toBeNull();
    expect(artifact?.findings).toEqual([]);
  });

  it('reports plan progress at the checkpoint interval for long documents', async () => {
    const { session, state } = makeFakeSession({ pages: 12, failAtPaint: 11 });

    await expect(
      exportService.runExport({
        jobId: 'job_4',
        documentId: 'doc_1',
        format: 'pdf',
        keepLayout: true,
        session,
      }),
    ).rejects.toThrow('render exploded');

    // Periodic flush at page 10, then the crash snapshot in the catch block.
    expect(state.checkpoints).toBe(2);
    const artifact = await exportArtifactsRepo.get('job_4');
    expect(artifact?.state).toBe('failed');
    expect(artifact?.renderedPages).toBe(11);
  });
});

describe('export helpers', () => {
  it('derives output names from the source name and target language', () => {
    expect(outputFileName('report.pdf', 'my', 'pdf')).toBe('report-my.pdf');
    expect(outputFileName('annual.report.docx', 'ja', 'md')).toBe('annual.report-ja.md');
    expect(outputFileName('README', 'en', 'txt')).toBe('README-en.txt');
  });

  it('accepts only supported formats', () => {
    expect(requireExportFormat('pdf')).toBe('pdf');
    expect(requireExportFormat(undefined)).toBe('pdf');
    expect(() => requireExportFormat('png')).toThrow(/Unsupported export format/);
  });
});
