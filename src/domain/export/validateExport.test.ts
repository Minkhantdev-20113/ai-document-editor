import { describe, expect, it } from 'vitest';
import { buildRenderPlan } from './layoutPlan';
import type { TextMetrics } from './textLayout';
import {
  hasBlockingFindings,
  summarizeFindings,
  validateExport,
  validateSecondaryArtifact,
} from './validateExport';
import type { ExportBlockInput, ExportDocumentInput, ExportPageInput } from './types';

const metrics: TextMetrics = { width: (text, _role, size) => text.length * size * 0.5 };

function makeBlock(overrides: Partial<ExportBlockInput> = {}): ExportBlockInput {
  return {
    blockId: 'b1',
    orderIndex: 0,
    kind: 'paragraph',
    bbox: { x: 56, y: 100, width: 483, height: 40 },
    font: { family: 'Times', size: 10, bold: false, italic: false },
    alignment: 'left',
    headingLevel: null,
    listOrdered: null,
    table: null,
    link: null,
    flags: [],
    sourceText: 'Source text.',
    translatedText: 'ဘာသာပြန်ချက်',
    unitStatus: 'translated',
    ...overrides,
  };
}

function makeDoc(blocks: ExportBlockInput[], overrides: Partial<ExportDocumentInput> = {}): ExportDocumentInput {
  const page: ExportPageInput = {
    pageIndex: 0,
    width: 595.28,
    height: 841.89,
    rotation: 0,
    blocks,
  };
  return {
    documentId: 'doc_1',
    projectId: 'proj_1',
    title: 'Sample document',
    fileName: 'sample.pdf',
    sourceLanguage: 'en',
    targetLanguage: 'my',
    pages: [page],
    ...overrides,
  };
}

function inputFor(blocks: ExportBlockInput[], overrides: Partial<ExportDocumentInput> = {}) {
  const plan = buildRenderPlan(makeDoc(blocks, overrides), { metrics });
  return {
    plan,
    targetLanguage: 'my',
    expectedTargetLanguage: 'my',
    title: 'Sample document',
    artifact: { pageCount: plan.pages.length, structurallyValid: true },
  };
}

describe('validateExport', () => {
  it('accepts a healthy plan with a matching artifact', () => {
    const findings = validateExport(inputFor([makeBlock()]));
    expect(findings).toEqual([]);
    expect(hasBlockingFindings(findings)).toBe(false);
  });

  it('blocks the download when the file structure is broken', () => {
    const input = inputFor([makeBlock()]);
    const findings = validateExport({ ...input, artifact: { pageCount: 1, structurallyValid: false } });
    expect(findings.map((item) => item.code)).toContain('pdf_structure');
    expect(hasBlockingFindings(findings)).toBe(true);
  });

  it('reports a page count mismatch between plan and artifact', () => {
    const input = inputFor([makeBlock()]);
    const findings = validateExport({ ...input, artifact: { pageCount: 7, structurallyValid: true } });
    const mismatch = findings.find((item) => item.code === 'page_count_mismatch');
    expect(mismatch?.severity).toBe('error');
    expect(mismatch?.detail).toContain('expected 1 pages');
  });

  it('reports a language mismatch as an error', () => {
    const input = inputFor([makeBlock()]);
    const findings = validateExport({ ...input, expectedTargetLanguage: 'en' });
    expect(findings.some((item) => item.code === 'language_mismatch' && item.severity === 'error')).toBe(true);
  });

  it('warns about an empty title', () => {
    const input = inputFor([makeBlock()]);
    const findings = validateExport({ ...input, title: '   ' });
    expect(findings.find((item) => item.code === 'title_missing')?.severity).toBe('warning');
  });

  it('surfaces planning warnings (missing translation, glyphs, overflow)', () => {
    const findings = validateExport(
      inputFor([
        makeBlock({ blockId: 'a', translatedText: null, unitStatus: 'pending' }),
        makeBlock({ blockId: 'b', orderIndex: 1, translatedText: '中文' }),
      ]),
    );
    const codes = findings.map((item) => item.code);
    expect(codes).toContain('missing_translation');
    expect(codes).toContain('glyph_missing');
    // Warnings never block: the user decides.
    expect(hasBlockingFindings(findings)).toBe(false);
    expect(summarizeFindings(findings).glyph_missing).toBe(1);
  });

  it('flags a page that produced no content at all', () => {
    const findings = validateExport(inputFor([makeBlock({ sourceText: '', translatedText: '', unitStatus: null })]));
    const codes = findings.map((item) => item.code);
    expect(codes).toContain('empty_page');
    expect(codes).toContain('source_empty');
  });

  it('blocks when the document has no pages', () => {
    const findings = validateExport({
      plan: { pages: [], warnings: [], stats: { sourcePages: 0, pages: 0, blocks: 0, characters: 0 } },
      targetLanguage: 'my',
      expectedTargetLanguage: 'my',
      title: 'x',
      artifact: null,
    });
    expect(findings).toEqual([expect.objectContaining({ code: 'no_pages', severity: 'error' })]);
  });
});

describe('validateSecondaryArtifact (TXT/MD/HTML/JSON/DOCX)', () => {
  function inputFor(
    blocks: ExportBlockInput[],
    overrides: Partial<Parameters<typeof validateSecondaryArtifact>[0]> = {},
  ): Parameters<typeof validateSecondaryArtifact>[0] {
    const document = makeDoc(blocks);
    return {
      targetLanguage: 'my',
      expectedTargetLanguage: 'my',
      title: document.title,
      pages: document.pages,
      artifact: { byteLength: 2_048, structurallyValid: true },
      ...overrides,
    };
  }

  it('accepts a healthy artifact', () => {
    const findings = validateSecondaryArtifact(inputFor([makeBlock()]));
    expect(findings).toEqual([]);
    expect(hasBlockingFindings(findings)).toBe(false);
  });

  it('blocks on a corrupt container or empty output', () => {
    const corrupt = validateSecondaryArtifact(
      inputFor([makeBlock()], { artifact: { byteLength: 2_048, structurallyValid: false } }),
    );
    expect(corrupt).toEqual([expect.objectContaining({ code: 'container_corrupt', severity: 'error' })]);

    const empty = validateSecondaryArtifact(
      inputFor([makeBlock()], { artifact: { byteLength: 0, structurallyValid: true } }),
    );
    expect(empty).toEqual([expect.objectContaining({ code: 'missing_text', severity: 'error' })]);
  });

  it('warns about untranslated blocks without blocking', () => {
    const findings = validateSecondaryArtifact(
      inputFor([makeBlock(), makeBlock({ blockId: 'b2', translatedText: null, unitStatus: null })]),
    );
    expect(findings).toEqual([
      expect.objectContaining({ code: 'missing_translation', severity: 'warning', blockId: 'b2' }),
    ]);
    expect(hasBlockingFindings(findings)).toBe(false);
  });

  it('blocks on a target language mismatch and warns on a missing title', () => {
    const findings = validateSecondaryArtifact(
      inputFor([makeBlock()], {
        expectedTargetLanguage: 'ja',
        title: '   ',
      }),
    );
    const codes = findings.map((item) => item.code);
    expect(codes).toContain('language_mismatch');
    expect(codes).toContain('title_missing');
    expect(hasBlockingFindings(findings)).toBe(true);
  });
});
