import { describe, expect, it } from 'vitest';
import { readZipEntries } from '../../core/utils/zip';
import {
  inspectSecondaryFormat,
  parseDocumentExportJson,
  renderHtml,
  renderMarkdown,
  renderPlainText,
  renderSecondaryFormat,
  serializeDocument,
} from './secondaryFormats';
import type { ExportBlockInput, ExportDocumentInput } from './types';

const BBOX = { x: 56, y: 100, width: 483, height: 40 };

function block(overrides: Partial<ExportBlockInput> & { blockId: string }): ExportBlockInput {
  return {
    orderIndex: 0,
    kind: 'paragraph',
    bbox: BBOX,
    font: { family: 'Times', size: 12, bold: false, italic: false },
    alignment: 'left',
    headingLevel: null,
    listOrdered: null,
    table: null,
    link: null,
    flags: [],
    sourceText: 'Source text',
    translatedText: 'ဘာသာပြန်စာ',
    unitStatus: 'translated',
    ...overrides,
  };
}

const document: ExportDocumentInput = {
  documentId: 'doc1',
  projectId: 'proj1',
  title: 'Annual <Report>',
  fileName: 'annual.pdf',
  sourceLanguage: 'en',
  targetLanguage: 'my',
  pages: [
    {
      pageIndex: 0,
      width: 595.28,
      height: 841.89,
      rotation: 0,
      blocks: [
        block({
          blockId: 'h1',
          kind: 'heading',
          headingLevel: 2,
          translatedText: 'Annual Report',
          sourceText: 'Annual Report',
        }),
        block({ blockId: 'p1', link: 'https://example.com/report', translatedText: 'Read the report' }),
        block({ blockId: 'l1', listOrdered: true, translatedText: 'First item' }),
        block({ blockId: 'l2', listOrdered: true, translatedText: 'Second item' }),
        block({ blockId: 'l3', listOrdered: false, translatedText: 'Bullet note' }),
        block({
          blockId: 't1',
          kind: 'table',
          translatedText: null,
          table: {
            columns: 2,
            rows: [
              {
                cells: [
                  { text: 'Name', bbox: BBOX },
                  { text: 'Value', bbox: BBOX },
                ],
              },
              {
                cells: [
                  { text: 'Pages', bbox: BBOX },
                  { text: '2 | 2', bbox: BBOX },
                ],
              },
            ],
          },
        }),
        block({ blockId: 'c1', alignment: 'center', translatedText: 'Centered line' }),
      ],
    },
    {
      pageIndex: 1,
      width: 595.28,
      height: 841.89,
      rotation: 90,
      blocks: [
        block({ blockId: 'u1', translatedText: null, sourceText: 'Plain source line', unitStatus: null }),
        block({ blockId: 'k1', kind: 'code', translatedText: 'const x = 1;' }),
      ],
    },
  ],
};

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('secondary format renderers (Phase 5)', () => {
  it('renders plain text with headings, lists, tables and page breaks', () => {
    const text = renderPlainText(document);

    expect(text.startsWith('Annual <Report>\nen -> my')).toBe(true);
    expect(text).toContain('Annual Report\n====');
    expect(text).toContain('1. First item');
    expect(text).toContain('2. Second item');
    expect(text).toContain('• Bullet note');
    expect(text).toContain('Name | Value');
    expect(text).toContain('Centered line');
    // Untranslated block falls back to the source text.
    expect(text).toContain('Plain source line');
    // Pages are separated by a form feed.
    expect(text).toContain('\f');
  });

  it('renders markdown with ATX headings, links and a GFM table', () => {
    const md = renderMarkdown(document);

    expect(md).toContain('## Annual Report');
    expect(md).toContain('[Read the report](https://example.com/report)');
    expect(md).toContain('- Bullet note');
    expect(md).toContain('| Name | Value |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| Pages | 2 \\| 2 |');
    expect(md).toContain('\n---\n');
    expect(md).toContain('const x = 1;');
  });

  it('renders valid HTML carrying the target language and page separators', () => {
    const html = renderHtml(document);

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="my">');
    expect(html).toContain('<title>Annual &lt;Report&gt;</title>');
    expect(html).toContain('<h2 id="page0_bh1">Annual Report</h2>');
    // Consecutive list items share one list element.
    expect(html).toMatch(/<ol>\s*<li>First item<\/li>\s*<li>Second item<\/li>\s*<\/ol>/);
    expect(html).toMatch(/<ul>\s*<li>Bullet note<\/li>\s*<\/ul>/);
    expect(html).toContain('<table><tbody><tr><td>Name</td><td>Value</td></tr>');
    expect(html).toContain('<a href="https://example.com/report">Read the report</a>');
    expect(html).toContain('style="text-align:center"');
    expect(html).toContain('<hr class="page">');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('serializes JSON that restores the document model', async () => {
    const bytes = await renderSecondaryFormat('json', document);
    const text = decode(bytes);

    expect(text).toContain('"format": "adt-export-document"');
    const restored = parseDocumentExportJson(text);

    expect(restored).toEqual(document);
    expect(parseDocumentExportJson('{"format":"other"}')).toBeNull();
    expect(parseDocumentExportJson('not json at all')).toBeNull();
    expect(serializeDocument(document).pages).toHaveLength(2);
  });

  it('renders a DOCX package with styles, sections, links and a table grid', async () => {
    const bytes = await renderSecondaryFormat('docx', document);
    const entries = await readZipEntries(bytes);

    expect([...entries.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/core.xml',
      'word/document.xml',
      'word/styles.xml',
      'word/_rels/document.xml.rels',
    ]);

    const xml = decode(entries.get('word/document.xml')?.data ?? new Uint8Array());
    expect(xml).toContain('<w:pStyle w:val="Heading2"/>');
    expect(xml).toContain('1. First item');
    expect(xml).toContain('2. Second item');
    expect(xml).toContain('• Bullet note');
    expect(xml).toContain('<w:tblGrid>');
    expect(xml).toContain('<w:sectPr>');
    // Rotation 90 on page 2 switches that section to landscape.
    expect(xml).toContain('w:orient="landscape"');
    expect(xml).toContain('const x = 1;');

    const rels = decode(entries.get('word/_rels/document.xml.rels')?.data ?? new Uint8Array());
    expect(rels).toContain('Target="https://example.com/report"');
    expect(rels).toContain('TargetMode="External"');

    const core = decode(entries.get('docProps/core.xml')?.data ?? new Uint8Array());
    expect(core).toContain('<dc:title>Annual &lt;Report&gt;</dc:title>');
    expect(core).toContain('<dc:language>my</dc:language>');
  });
});

describe('inspectSecondaryFormat (pre-download probe)', () => {
  it('accepts well-formed containers', async () => {
    const html = await renderSecondaryFormat('html', document);
    const json = await renderSecondaryFormat('json', document);
    const docx = await renderSecondaryFormat('docx', document);
    const txt = await renderSecondaryFormat('txt', document);

    expect(await inspectSecondaryFormat('html', html)).toEqual({
      structurallyValid: true,
      byteLength: html.byteLength,
    });
    expect((await inspectSecondaryFormat('json', json)).structurallyValid).toBe(true);
    expect((await inspectSecondaryFormat('docx', docx)).structurallyValid).toBe(true);
    expect((await inspectSecondaryFormat('txt', txt)).structurallyValid).toBe(true);
  });

  it('rejects empty or corrupt output', async () => {
    expect((await inspectSecondaryFormat('txt', new Uint8Array(0))).structurallyValid).toBe(false);
    expect(
      (await inspectSecondaryFormat('json', new TextEncoder().encode('{ nope'))).structurallyValid,
    ).toBe(false);
    expect(
      (await inspectSecondaryFormat('html', new TextEncoder().encode('<p>not a document</p>')))
        .structurallyValid,
    ).toBe(false);
    expect(
      (await inspectSecondaryFormat('docx', new TextEncoder().encode('PK not really a zip')))
        .structurallyValid,
    ).toBe(false);
  });
});
