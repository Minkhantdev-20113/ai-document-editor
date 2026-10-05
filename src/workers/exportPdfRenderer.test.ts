import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  PDFArray,
  PDFDocument,
  PDFDict,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
  type PDFPage,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_FONTS } from '../domain/export/fonts';
import type { ExportBlockInput, ExportDocumentInput, ExportPageInput } from '../domain/export/types';
import type { FontBytesLoader } from './exportFontSources';
import { ExportPdfSession, isActionableLink } from './exportPdfRenderer';

const loadBytes: FontBytesLoader = async (url) => new Uint8Array(await readFile(fileURLToPath(url)));

function newSession(): Promise<ExportPdfSession> {
  return ExportPdfSession.create(DEFAULT_EXPORT_FONTS, loadBytes);
}

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

/** Prepares + paints `count` pages and returns the finished PDF. */
async function render(
  session: ExportPdfSession,
  document: ExportDocumentInput,
  count: number,
): Promise<Uint8Array> {
  await session.prepare(document);
  for (let index = 0; index < count; index += 1) await session.paintPage(index);
  return session.finish({ title: document.title });
}

function contentOf(doc: PDFDocument, page: PDFPage): string {
  const contents = page.node.Contents();
  if (!contents) return '';
  const objects =
    contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, index) => contents.get(index))
      : [contents];

  let text = '';
  for (const object of objects) {
    const stream = doc.context.lookup(object);
    if (!(stream instanceof PDFRawStream)) continue;
    text += new TextDecoder().decode(decodePDFRawStream(stream).decode());
  }
  return text;
}

function fontEntries(doc: PDFDocument, page: PDFPage): string[] {
  return page.node
    .normalizedEntries()
    .Font.entries()
    .map(([, value]) => {
      const font = doc.context.lookupMaybe(value, PDFDict);
      return String(font?.get(PDFName.of('BaseFont')) ?? '');
    });
}

describe('ExportPdfSession', () => {
  it('renders Burmese and Latin text with an embedded Burmese font', async () => {
    const bytes = await render(await newSession(), documentOf(pageInput([textBlock()])), 1);
    const doc = await PDFDocument.load(bytes);

    expect(doc.getPageCount()).toBe(1);
    const page = doc.getPage(0);
    expect(page.getWidth()).toBeCloseTo(595.28, 2);
    expect(page.getHeight()).toBeCloseTo(841.89, 2);

    const content = contentOf(doc, page);
    expect(content).toContain('BT');
    expect(content).toContain('Tf');
    expect(content).toContain('Tj');
    // Absolute positioning for the HarfBuzz glyphs.
    expect(content).toContain('Tm');

    expect(fontEntries(doc, page).some((name) => name.includes('Padauk'))).toBe(true);
    expect(doc.getTitle()).toBe('Test export');
  });

  it('embeds the Burmese font once for the whole document', async () => {
    const bytes = await render(
      await newSession(),
      documentOf(pageInput([textBlock()]), pageInput([textBlock({ blockId: 'b2' })], 1)),
      2,
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);

    const padaukObjects = doc.context
      .enumerateIndirectObjects()
      .filter(([, object]) => {
        if (!(object instanceof PDFDict)) return false;
        const subtype = String(object.get(PDFName.of('Subtype')) ?? '');
        const baseFont = String(object.get(PDFName.of('BaseFont')) ?? '');
        return subtype === '/Type0' && baseFont.includes('Padauk');
      });
    expect(padaukObjects).toHaveLength(1);
    // Both pages reference that single font object.
    expect(fontEntries(doc, doc.getPage(0)).some((name) => name.includes('Padauk'))).toBe(true);
    expect(fontEntries(doc, doc.getPage(1)).some((name) => name.includes('Padauk'))).toBe(true);
  });

  it('adds link annotations only for actionable targets', async () => {
    const linked = await render(
      await newSession(),
      documentOf(pageInput([textBlock({ link: 'https://example.com/doc' })])),
      1,
    );
    const linkedDoc = await PDFDocument.load(linked);
    expect(linkedDoc.getPage(0).node.Annots()?.size()).toBe(1);

    const unsafe = await render(
      await newSession(),
      documentOf(pageInput([textBlock({ link: 'javascript:alert(1)' })])),
      1,
    );
    const unsafeDoc = await PDFDocument.load(unsafe);
    expect(unsafeDoc.getPage(0).node.Annots()?.size() ?? 0).toBe(0);

    expect(isActionableLink('mailto:a@b.c')).toBe(true);
    expect(isActionableLink('ftp://x')).toBe(false);
  });

  it('keeps Latin-only pages free of Burmese font data', async () => {
    const only = textBlock({
      translatedText: 'Plain Latin only text for the page.',
      sourceText: 'Plain Latin only text for the page.',
    });
    const doc = await PDFDocument.load(await render(await newSession(), documentOf(pageInput([only])), 1));
    expect(fontEntries(doc, doc.getPage(0)).some((name) => name.includes('Padauk'))).toBe(false);
    expect(contentOf(doc, doc.getPage(0))).toContain('Tj');
  });

  it('paints table borders and cell text', async () => {
    const table = textBlock({
      blockId: 't1',
      kind: 'table',
      bbox: { x: 56, y: 200, width: 400, height: 60 },
      table: {
        columns: 2,
        rows: [
          {
            cells: [
              { text: 'Header တစ်ခု', bbox: { x: 56, y: 200, width: 200, height: 30 } },
              { text: 'Header two', bbox: { x: 256, y: 200, width: 200, height: 30 } },
            ],
          },
          {
            cells: [
              { text: 'Cell A', bbox: { x: 56, y: 230, width: 200, height: 30 } },
              { text: 'Cell B', bbox: { x: 256, y: 230, width: 200, height: 30 } },
            ],
          },
        ],
      },
      translatedText: null,
      unitStatus: null,
    });
    const doc = await PDFDocument.load(await render(await newSession(), documentOf(pageInput([table])), 1));
    const content = contentOf(doc, doc.getPage(0));
    expect(content).toContain('Tj');
    // Border strokes: "x y m" / "x y l" pairs drawn before the cell text.
    expect(content).toMatch(/[-\d.]+ [-\d.]+ m/);
    expect(content).toMatch(/[-\d.]+ [-\d.]+ l/);
    expect(fontEntries(doc, doc.getPage(0)).some((name) => name.includes('Padauk'))).toBe(true);
  });

  it('draws justified lines with expanded space gaps', async () => {
    const justified = textBlock({
      alignment: 'justify',
      bbox: { x: 56, y: 100, width: 483, height: 120 },
      translatedText:
        'မြန်မာနိုင်ငံသည် အရှေ့တောင်အာရှတွင် တည်ရှိပြီး စာပေနှင့် ရိုးရာဓလေ့များ ကြွယ်ဝသည်။ ဤစာပေကို လေ့လာရန် လိုအပ်ပါသည်။ နောက်ထပ်စာကြောင်းများ ထပ်မံဖြည့်စွက်ထားပါသည်။',
    });
    const doc = await PDFDocument.load(
      await render(await newSession(), documentOf(pageInput([justified])), 1),
    );
    const content = contentOf(doc, doc.getPage(0));
    // A stretched line draws each piece at its own x: one Tm per piece/run.
    expect(content.split('Tm').length - 1).toBeGreaterThan(3);
    expect(content.split('Tj').length - 1).toBeGreaterThan(3);
  });

  it('resumes from a checkpoint instead of page 1', async () => {
    const document = documentOf(pageInput([textBlock()]), pageInput([textBlock({ blockId: 'b2' })], 1));
    const session = await newSession();
    const prepared = await session.prepare(document);
    expect(prepared.pages).toBe(2);
    expect(prepared.resumedFrom).toBe(0);

    await session.paintPage(0);
    const checkpoint = await session.checkpoint();
    expect(session.renderedPages).toBe(1);

    // A fresh session restores the checkpoint and paints only the rest.
    const resumedSession = await newSession();
    const resumed = await resumedSession.prepare(document, {
      resume: { bytes: checkpoint, signature: prepared.signature },
    });
    expect(resumed.resumedFrom).toBe(1);

    await resumedSession.paintPage(1);
    const bytes = await resumedSession.finish({ title: document.title });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(contentOf(doc, doc.getPage(1))).toContain('Tj');
  });

  it('starts over when the plan no longer matches the checkpoint', async () => {
    const document = documentOf(pageInput([textBlock()]));
    const session = await newSession();
    const prepared = await session.prepare(document);
    await session.paintPage(0);
    const checkpoint = await session.checkpoint();

    const changed = documentOf(
      pageInput([
        textBlock({
          translatedText: 'Completely different and much longer translated content for signature change',
          sourceText: 'Completely different and much longer translated content for signature change',
        }),
      ]),
      pageInput(
        [
          textBlock({
            blockId: 'b2',
            translatedText: 'Second changed page content',
            sourceText: 'Second changed page content',
          }),
        ],
        1,
      ),
    );
    const fresh = await newSession();
    const result = await fresh.prepare(changed, {
      resume: { bytes: checkpoint, signature: prepared.signature },
    });
    expect(result.resumedFrom).toBe(0);

    // Out-of-order painting is rejected instead of corrupting the document.
    await expect(fresh.paintPage(1)).rejects.toThrow(/expected page 0/i);
    await fresh.paintPage(0);
    expect(fresh.renderedPages).toBe(1);
  });
});
