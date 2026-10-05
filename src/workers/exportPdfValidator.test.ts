import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_FONTS } from '../domain/export/fonts';
import type { ExportBlockInput, ExportDocumentInput, ExportPageInput } from '../domain/export/types';
import type { FontBytesLoader } from './exportFontSources';
import { ExportPdfSession } from './exportPdfRenderer';
import { inspectPdf, validateExportArtifact } from './exportPdfValidator';

const loadBytes: FontBytesLoader = async (url) => new Uint8Array(await readFile(fileURLToPath(url)));

function textBlock(overrides: Partial<ExportBlockInput> = {}): ExportBlockInput {
  return {
    blockId: 'b1',
    orderIndex: 0,
    kind: 'paragraph',
    bbox: { x: 56, y: 100, width: 483, height: 40 },
    font: { family: 'Times', size: 12, bold: false, italic: false },
    alignment: 'left',
    headingLevel: null,
    listOrdered: null,
    table: null,
    link: null,
    flags: [],
    sourceText: 'Source sentence used for layout.',
    translatedText: 'မြန်မာစာ စမ်းသပ်မှုတစ်ခု ဖြစ်သည်။',
    unitStatus: 'translated',
    ...overrides,
  };
}

function pageInput(blocks: ExportPageInput['blocks'], pageIndex = 0): ExportPageInput {
  return { pageIndex, width: 595.28, height: 841.89, rotation: 0, blocks };
}

function documentOf(...pages: ExportPageInput[]): ExportDocumentInput {
  return {
    documentId: 'doc1',
    projectId: 'proj1',
    title: 'Test export',
    fileName: 'test.pdf',
    sourceLanguage: 'en',
    targetLanguage: 'my',
    pages,
  };
}

/** Renders a two-page document through the real session and returns its bytes + plan. */
async function renderFinished(): Promise<{
  bytes: Uint8Array;
  plan: NonNullable<ExportPdfSession['renderPlan']>;
}> {
  const session = await ExportPdfSession.create(DEFAULT_EXPORT_FONTS, loadBytes);
  const document = documentOf(
    pageInput([textBlock()]),
    pageInput([textBlock({ blockId: 'b2', orderIndex: 0 })], 1),
  );
  await session.prepare(document);
  await session.paintPage(0);
  await session.paintPage(1);
  const bytes = await session.finish({ title: document.title });
  const plan = session.renderPlan;
  if (!plan) throw new Error('plan missing after prepare');
  return { bytes, plan };
}

describe('exportPdfValidator (pre-download probe, Phase 5)', () => {
  it('opens a finished PDF and reports its pages', async () => {
    const { bytes } = await renderFinished();

    const inspection = await inspectPdf(bytes);

    expect(inspection.structurallyValid).toBe(true);
    expect(inspection.pageCount).toBe(2);
    expect(inspection.blankPages).toEqual([]);
  });

  it('accepts a healthy artifact with no blocking findings', async () => {
    const { bytes, plan } = await renderFinished();

    const result = await validateExportArtifact({
      bytes,
      plan,
      targetLanguage: 'my',
      expectedTargetLanguage: 'my',
      title: 'Test export',
    });

    expect(result.structurallyValid).toBe(true);
    expect(result.pageCount).toBe(2);
    expect(result.blocking).toBe(false);
    expect(result.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  });

  it('blocks the download when the bytes are not a PDF at all', async () => {
    const { plan } = await renderFinished();

    const result = await validateExportArtifact({
      bytes: new Uint8Array([1, 2, 3, 4, 5]),
      plan,
      targetLanguage: 'my',
      expectedTargetLanguage: 'my',
      title: 'Test export',
    });

    expect(result.structurallyValid).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.findings.map((finding) => finding.code)).toContain('pdf_structure');
  });

  it('blocks on a language mismatch between the plan and the request', async () => {
    const { bytes, plan } = await renderFinished();

    const result = await validateExportArtifact({
      bytes,
      plan,
      targetLanguage: 'ja',
      expectedTargetLanguage: 'my',
      title: 'Test export',
    });

    expect(result.blocking).toBe(true);
    expect(result.findings.map((finding) => finding.code)).toContain('language_mismatch');
  });
});
