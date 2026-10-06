import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { documentBlocksRepo, documentPagesRepo, documentsRepo, projectsRepo, translationUnitsRepo } from '../db/repositories';
import { createProgress } from '../domain/types';
import type { AnalysisSource } from '../domain/analysis/source';
import type { PdfjsModule } from '../workers/pdfExtract';
import { createLocalAnalysisSource } from '../workers/analysisSession';
import { analyzePage } from '../domain/analysis/pipeline';
import { analyzeDocument } from './documentAnalysisService';
import { documentService } from './documentService';
import { ocrRegistry, type OcrPageResult } from './ocrRegistry';

const PDFJS = pdfjs as unknown as PdfjsModule;

const ENGLISH_MARKDOWN = `# Project Plan

This is the first paragraph of the document. It contains enough characters for confident language detection and simple sentence structure for grouping.

The second paragraph follows after a blank line and continues the discussion with more English sentences that describe the plan.

## Tasks

1. Review the requirements
2. Implement the pipeline
3. Write the documentation
`;

const BURMESE_MARKDOWN = `# စီမံကိန်း အစီအစဉ်

ဒီစာပိုဒ်က မြန်မာဘာသာစကားဖြင့် ရေးသားထားခြင်း ဖြစ်ပြီး ဘာသာစကား ဖော်ထုတ်ရာတွင် လုံလောက်သော စာလုံးအရေအတွက် ရှိပါသည်။

ဒုတိယ စာပိုဒ်က နောက်တစ်ကြောင်းတွင် ဆက်လက် ဖော်ပြနေပြီး စီမံကိန်းအကြောင်း ဆွေးနွေးချက်များ ပါဝင်ပါသည်။
`;

/** Long enough to paginate into several pages on the nominal A4 layout. */
const LONG_ENGLISH = Array.from(
  { length: 60 },
  (_, index) => `Paragraph ${index} of the document continues with a steady stream of English sentences used to exercise pagination.`,
).join('\n\n');

function localSource(): () => AnalysisSource {
  return () => createLocalAnalysisSource(PDFJS);
}

function failingSource(failIndex: number): () => AnalysisSource {
  return () => {
    const base = createLocalAnalysisSource(PDFJS);
    return {
      open: (bytes, request) => base.open(bytes, request),
      page: (index) =>
        index === failIndex ? Promise.reject(new Error('simulated page failure')) : base.page(index),
      close: () => base.close(),
    };
  };
}

const OCR_PROVIDER_ID = 'fake-ocr';

function registerFakeOcr(): void {
  ocrRegistry.register({
    id: OCR_PROVIDER_ID,
    label: 'Fake OCR',
    languages: ['en'],
    recognize: async (): Promise<OcrPageResult> => ({
      text: 'Recognized from the page image.',
      confidence: 0.8,
      lines: [
        { text: 'Recognized from the page image.', bbox: { x: 50, y: 60, width: 320, height: 18 } },
      ],
    }),
  });
}

/**
 * A source whose only page is an image with no selectable text; `renders()`
 * counts rasterization requests so tests can prove when OCR was (not) run.
 */
function imageOnlySource(): { createSource: () => AnalysisSource; renders: () => number } {
  let documentId = 'doc_unknown';
  let renders = 0;
  const createSource = (): AnalysisSource => ({
    open: async (bytes, request) => {
      void bytes;
      documentId = request.documentId;
      return { pageCount: 1, metadata: null, title: null };
    },
    page: async (index) =>
      analyzePage(
        {
          index,
          width: 612,
          height: 792,
          rotation: 0,
          items: [],
          fonts: [],
          images: [{ bbox: { x: 40, y: 40, width: 532, height: 712 } }],
          links: [],
        },
        documentId,
      ),
    renderPage: async () => {
      renders += 1;
      return { blob: new Blob([new Uint8Array([137, 80, 78, 71])]), scale: 2 };
    },
    close: async () => undefined,
  });
  return { createSource, renders: () => renders };
}

async function createDocument(content: string, fileName: string, patch: { sourceLanguage?: string } = {}) {
  const timestamp = Date.now();
  const projectId = `prj_${Math.random().toString(36).slice(2)}`;
  await projectsRepo.put({
    id: projectId,
    name: 'Analysis test',
    sourceFile: null,
    sourceLanguage: patch.sourceLanguage ?? 'en',
    targetLanguage: 'my',
    status: 'draft',
    progress: createProgress(0, 0),
    documentId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastProcessedUnit: 0,
    error: null,
    exportState: 'not_started',
    notes: '',
  });
  const document = await documentService.create({
    projectId,
    file: new File([content], fileName, { type: 'text/markdown' }),
    sourceLanguage: patch.sourceLanguage ?? 'en',
    targetLanguage: 'my',
  });
  return { projectId, documentId: document.id };
}

beforeEach(async () => {
  ocrRegistry.unregister(OCR_PROVIDER_ID);
  await projectsRepo.clear();
  await documentsRepo.clear();
  await documentPagesRepo.clear();
  await documentBlocksRepo.clear();
  await translationUnitsRepo.clear();
});

describe('analyzeDocument (pipeline driver over persisted state)', () => {
  it('runs the full pipeline: pages, blocks, units, detection, done state', async () => {
    const { documentId } = await createDocument(ENGLISH_MARKDOWN, 'plan.md');

    const result = await analyzeDocument({ documentId, createSource: localSource() });

    expect(result.aborted).toBe(false);
    expect(result.totalPages).toBeGreaterThanOrEqual(1);
    expect(result.analyzedThisRun).toBe(result.totalPages);
    expect(result.failedPages).toBe(0);

    const document = await documentService.require(documentId);
    expect(document.inspectionState).toBe('ready');
    expect(document.analysis?.stage).toBe('done');
    expect(document.analysis?.processedPages).toBe(result.totalPages);
    expect(document.pageCount).toBe(result.totalPages);
    expect(document.metadata?.title).toBeTruthy();

    const pages = await documentService.pages(documentId);
    expect(pages).toHaveLength(result.totalPages);
    expect(pages.every((page) => page.status === 'ready')).toBe(true);
    expect(pages.every((page) => page.analyzedAt !== undefined)).toBe(true);

    const blocks = await documentService.blocksOfDocument(documentId);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks[0]!.readingOrder).toBe(0);
    expect(blocks[0]!.orderIndex).toBe(blocks[0]!.pageIndex * 100_000 + blocks[0]!.readingOrder);
    expect(blocks.some((block) => block.kind === 'heading')).toBe(true);
    expect(blocks.some((block) => block.kind === 'list')).toBe(true);
    expect(blocks[0]!.font.size).toBeGreaterThan(0);

    const units = await translationUnitsRepo.queryByIndex('by_document', documentId);
    expect(units).toHaveLength(blocks.length);
    expect(units.every((unit) => unit.status === 'pending')).toBe(true);
    expect(units.every((unit) => unit.sourceLanguage === 'en')).toBe(true);
    expect(document.languageDetection?.code).toBe('en');
    expect(document.languageDetection!.confidence).toBeGreaterThan(0);
  });

  it('detects Burmese and syncs the detected language onto every unit', async () => {
    // Project language says English; detection must win on the units.
    const { documentId } = await createDocument(BURMESE_MARKDOWN, 'my.md', { sourceLanguage: 'en' });

    await analyzeDocument({ documentId, createSource: localSource() });

    const document = await documentService.require(documentId);
    expect(document.languageDetection?.code).toBe('my');

    const units = await translationUnitsRepo.queryByIndex('by_document', documentId);
    expect(units.length).toBeGreaterThan(0);
    expect(units.every((unit) => unit.sourceLanguage === 'my')).toBe(true);
  });

  it('resumes: a second run skips every analyzed page', async () => {
    const { documentId } = await createDocument(ENGLISH_MARKDOWN, 'plan.md');
    await analyzeDocument({ documentId, createSource: localSource() });

    const second = await analyzeDocument({ documentId, createSource: localSource() });

    expect(second.analyzedThisRun).toBe(0);
    expect(second.skipped).toBe(second.totalPages);
    expect(second.failedPages).toBe(0);
  });

  it('reads an image-only page through the OCR engine and counts it once', async () => {
    const { documentId } = await createDocument(ENGLISH_MARKDOWN, 'plan.md');
    registerFakeOcr();
    const harness = imageOnlySource();

    const first = await analyzeDocument({ documentId, createSource: harness.createSource });

    expect(first.analyzedThisRun).toBe(1);
    expect(harness.renders()).toBe(1);
    const pages = await documentService.pages(documentId);
    expect(pages[0]!.status).toBe('ready');
    expect(pages[0]!.error).toBeNull();
    expect(pages[0]!.blockCount).toBeGreaterThan(0);
    const blocks = await documentService.blocksOfDocument(documentId);
    expect(blocks.map((block) => block.text).join(' ')).toContain('Recognized from the page image');
    expect(blocks[0]!.pageIndex).toBe(0);

    const document = await documentService.require(documentId);
    expect(document.analysis?.processedPages).toBe(1);
    expect(document.analysis?.blocks).toBe(pages[0]!.blockCount);

    // The page is `ready` now, so a re-run skips it without re-rendering.
    const second = await analyzeDocument({ documentId, createSource: harness.createSource });
    expect(second.analyzedThisRun).toBe(0);
    expect(second.skipped).toBe(1);
    expect(harness.renders()).toBe(1);
    expect((await documentService.require(documentId)).analysis?.processedPages).toBe(1);
  });

  it('keeps image-only pages empty without an engine, then retries them once one exists', async () => {
    const { documentId } = await createDocument(ENGLISH_MARKDOWN, 'plan.md');
    const harness = imageOnlySource();

    const first = await analyzeDocument({ documentId, createSource: harness.createSource });
    expect(first.failedPages).toBe(0);
    expect(harness.renders()).toBe(0);
    expect((await documentService.pages(documentId))[0]!.status).toBe('needs_ocr');

    // Without an engine the page is finished work: no render, no retry.
    const second = await analyzeDocument({ documentId, createSource: harness.createSource });
    expect(second.analyzedThisRun).toBe(0);
    expect(second.skipped).toBe(1);
    expect(harness.renders()).toBe(0);

    // Installing an engine makes the same page unfinished: it is re-read.
    registerFakeOcr();
    const third = await analyzeDocument({ documentId, createSource: harness.createSource });
    expect(third.analyzedThisRun).toBe(1);
    expect(harness.renders()).toBe(1);
    expect((await documentService.pages(documentId))[0]!.status).toBe('ready');

    const document = await documentService.require(documentId);
    expect(document.analysis?.processedPages).toBe(1);
    expect(document.analysis?.blocks).toBeGreaterThan(0);
  });

  it('isolates a failing page: the rest analyze, the failure persists with retry', async () => {
    const { documentId } = await createDocument(LONG_ENGLISH, 'long.md');
    const createSource = failingSource(1);

    const result = await analyzeDocument({ documentId, createSource });

    expect(result.totalPages).toBeGreaterThan(1);
    expect(result.failedPages).toBe(1);
    expect(result.processedPages).toBe(result.totalPages - 1);

    const pages = await documentService.pages(documentId);
    expect(pages[1]!.status).toBe('failed');
    expect(pages[1]!.error?.code).toBe('analysis_failed');
    expect(pages.filter((page) => page.status === 'ready')).toHaveLength(result.totalPages - 1);

    const document = await documentService.require(documentId);
    // One bad page does not fail the document.
    expect(document.inspectionState).toBe('ready');
    expect(document.analysis?.stage).toBe('done');
    expect(document.analysis?.failedPages).toBe(1);
  });

  it('recovers the failed page on the next run', async () => {
    const { documentId } = await createDocument(LONG_ENGLISH, 'long.md');
    await analyzeDocument({ documentId, createSource: failingSource(1) });

    const retry = await analyzeDocument({ documentId, createSource: localSource() });

    expect(retry.failedPages).toBe(0);
    expect(retry.analyzedThisRun).toBe(1);
    expect(retry.skipped).toBe(retry.totalPages - 1);
    const pages = await documentService.pages(documentId);
    expect(pages.every((page) => page.status === 'ready')).toBe(true);
  });

  it('stops between pages on abort and resumes from the first unanalyzed page', async () => {
    const { documentId } = await createDocument(LONG_ENGLISH, 'long.md');
    const controller = new AbortController();

    const partial = await analyzeDocument({
      documentId,
      createSource: localSource(),
      signal: controller.signal,
      onPage: () => controller.abort(),
    });

    expect(partial.aborted).toBe(true);
    expect(partial.analyzedThisRun).toBe(1);
    const afterAbort = await documentService.require(documentId);
    expect(afterAbort.analysis?.stage).toBe('page_analysis');
    expect(afterAbort.inspectionState).toBe('running');

    const resumed = await analyzeDocument({ documentId, createSource: localSource() });
    expect(resumed.aborted).toBe(false);
    expect(resumed.skipped).toBe(1);
    expect(resumed.analyzedThisRun).toBe(resumed.totalPages - 1);
    const final = await documentService.require(documentId);
    expect(final.analysis?.stage).toBe('done');
    expect(final.inspectionState).toBe('ready');
  });

  it('keeps an unchanged unit verbatim (translation preserved across re-analysis)', async () => {
    const { documentId } = await createDocument(ENGLISH_MARKDOWN, 'plan.md');
    await analyzeDocument({ documentId, createSource: localSource() });

    const units = await translationUnitsRepo.queryByIndex('by_document', documentId);
    const target = units[0]!;
    await translationUnitsRepo.put({
      ...target,
      translatedText: 'ပြန်ဆိုပြီးသော စာသား',
      status: 'translated',
      updatedAt: Date.now(),
    });

    // Force this page to be re-analyzed.
    const page = (await documentService.pages(documentId)).find((item) => item.id === target.pageId)!;
    await documentPagesRepo.put({ ...page, analyzedAt: undefined });

    await analyzeDocument({ documentId, createSource: localSource() });

    const after = await translationUnitsRepo.get(target.id);
    expect(after?.translatedText).toBe('ပြန်ဆိုပြီးသော စာသား');
    expect(after?.status).toBe('translated');
    expect(after?.sourceChecksum).toBe(target.sourceChecksum);
  });
});

describe('validateSourceFile', () => {
  it('rejects unsupported types before anything is written', () => {
    const file = new File(['MZ'], 'setup.exe', { type: 'application/x-msdownload' });
    expect(() => documentService.validateSourceFile(file)).toThrowError(/not supported/);
    try {
      documentService.validateSourceFile(file);
    } catch (error) {
      expect((error as { code: string }).code).toBe('file_type_unsupported');
    }
  });

  it('rejects empty files', () => {
    const file = new File([], 'empty.md', { type: 'text/markdown' });
    expect(() => documentService.validateSourceFile(file)).toThrowError(/empty/);
  });

  it('rejects files above the size limit', () => {
    const file = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: 400 * 1024 * 1024 });
    expect(() => documentService.validateSourceFile(file)).toThrowError(/limit/);
  });

  it('accepts every supported extension', () => {
    for (const name of ['a.pdf', 'b.txt', 'c.md', 'd.html', 'e.csv', 'f.docx']) {
      expect(() => documentService.validateSourceFile(new File(['content'], name))).not.toThrow();
    }
  });
});
