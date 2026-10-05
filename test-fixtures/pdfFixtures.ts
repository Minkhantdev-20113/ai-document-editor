import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

/**
 * PDF fixtures for the Phase 2 analysis pipeline tests.
 *
 * Every builder produces a real PDF with pdf-lib so tests exercise the entire
 * chain (pdf.js extraction → line grouping → classification) instead of
 * synthetic raw items. The set mirrors the spec's required coverage:
 * normal text, multiple paragraphs, headings, lists, tables, mixed formatting,
 * Burmese text and scanned/image pages - plus a rotated page.
 */

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const LEFT = 56;
const GRAY = rgb(0.15, 0.15, 0.15);

const BURMESE_FONT_PATH = 'test-fixtures/fonts/NotoSansMyanmar-Regular.ttf';

export interface FixturePdf {
  readonly bytes: Uint8Array;
}

async function newDoc(): Promise<{ doc: PDFDocument; page: PDFPage }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  return { doc, page };
}

async function standard(page: PDFPage): Promise<{ regular: PDFFont; bold: PDFFont; italic: PDFFont; courier: PDFFont; times: PDFFont }> {
  const doc = page.doc;
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    courier: await doc.embedFont(StandardFonts.Courier),
    times: await doc.embedFont(StandardFonts.TimesRoman),
  };
}

function drawLines(
  page: PDFPage,
  lines: ReadonlyArray<{ text: string; x: number; y: number; size: number; font: PDFFont }>,
): void {
  for (const line of lines) {
    page.drawText(line.text, {
      x: line.x,
      y: line.y,
      size: line.size,
      font: line.font,
      color: GRAY,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 1. Normal text                                                      */
/* ------------------------------------------------------------------ */

export async function normalTextPdf(): Promise<FixturePdf> {
  const { doc, page } = await newDoc();
  const fonts = await standard(page);
  drawLines(page, [
    { text: 'Quarterly operations summary', x: LEFT, y: 760, size: 20, font: fonts.bold },
    { text: 'This document contains normal prose that flows across several', x: LEFT, y: 730, size: 11, font: fonts.regular },
    { text: 'lines of readable body text in a single coherent paragraph block.', x: LEFT, y: 714, size: 11, font: fonts.regular },
    { text: 'It is the simplest shape the analysis pipeline must understand.', x: LEFT, y: 698, size: 11, font: fonts.regular },
  ]);
  return { bytes: await doc.save() };
}

/* ------------------------------------------------------------------ */
/* 2. Multiple paragraphs                                              */
/* ------------------------------------------------------------------ */

export async function paragraphsPdf(): Promise<FixturePdf> {
  const { doc, page } = await newDoc();
  const fonts = await standard(page);
  drawLines(page, [
    { text: 'Alpha paragraph discusses the first topic in careful detail', x: LEFT, y: 740, size: 11, font: fonts.regular },
    { text: 'and continues onto a second line to form a grouped block.', x: LEFT, y: 724, size: 11, font: fonts.regular },

    { text: 'Beta paragraph covers a second subject with its own spacing', x: LEFT, y: 690, size: 11, font: fonts.regular },
    { text: 'so the grouper must split it from the paragraph above it.', x: LEFT, y: 674, size: 11, font: fonts.regular },

    { text: 'Gamma paragraph closes the sample with a third distinct body', x: LEFT, y: 640, size: 11, font: fonts.regular },
    { text: 'of text, again spread across two separate visual lines.', x: LEFT, y: 624, size: 11, font: fonts.regular },
  ]);
  return { bytes: await doc.save() };
}

/* ------------------------------------------------------------------ */
/* 3. Headings                                                         */
/* ------------------------------------------------------------------ */

export async function headingsPdf(): Promise<FixturePdf> {
  const { doc, page } = await newDoc();
  const fonts = await standard(page);
  drawLines(page, [
    { text: 'Project Overview', x: LEFT, y: 760, size: 24, font: fonts.bold },
    { text: 'Body copy underneath the primary heading explains the scope', x: LEFT, y: 730, size: 11, font: fonts.regular },
    { text: 'of the work in two ordinary lines of regular weight text.', x: LEFT, y: 714, size: 11, font: fonts.regular },

    { text: 'Background', x: LEFT, y: 680, size: 16, font: fonts.bold },
    { text: 'A secondary heading is smaller than the first but still larger', x: LEFT, y: 650, size: 11, font: fonts.regular },
    { text: 'than the surrounding body text of this document page.', x: LEFT, y: 634, size: 11, font: fonts.regular },
  ]);
  return { bytes: await doc.save() };
}

/* ------------------------------------------------------------------ */
/* 4. Lists                                                            */
/* ------------------------------------------------------------------ */

export async function listsPdf(): Promise<FixturePdf> {
  const { doc, page } = await newDoc();
  const fonts = await standard(page);
  drawLines(page, [
    { text: '1. Draft the initial outline', x: LEFT, y: 740, size: 11, font: fonts.regular },
    { text: '2. Review with the editorial team', x: LEFT, y: 724, size: 11, font: fonts.regular },
    { text: '3. Publish the final version', x: LEFT, y: 708, size: 11, font: fonts.regular },

    { text: '- Collect the source documents', x: LEFT, y: 670, size: 11, font: fonts.regular },
    { text: '- Verify the page layout carefully', x: LEFT, y: 654, size: 11, font: fonts.regular },
  ]);
  return { bytes: await doc.save() };
}

/* ------------------------------------------------------------------ */
/* 5. Tables                                                           */
/* ------------------------------------------------------------------ */

export async function tablePdf(): Promise<FixturePdf> {
  const { doc, page } = await newDoc();
  const fonts = await standard(page);
  const rows: Array<[string, string, string]> = [
    ['Department', 'Items', 'Status'],
    ['Finance', '14', 'Open'],
    ['Operations', '9', 'Closed'],
    ['Support', '21', 'Open'],
  ];
  const lines = [
    { text: 'Audit findings by department', x: LEFT, y: 740, size: 11, font: fonts.regular },
  ];
  rows.forEach((row, index) => {
    const y = 690 - index * 16;
    const font = index === 0 ? fonts.bold : fonts.regular;
    lines.push({ text: row[0] ?? '', x: 60, y, size: 11, font });
    lines.push({ text: row[1] ?? '', x: 250, y, size: 11, font });
    lines.push({ text: row[2] ?? '', x: 380, y, size: 11, font });
  });
  drawLines(page, lines);
  return { bytes: await doc.save() };
}

/* ------------------------------------------------------------------ */
/* 6. Mixed formatting                                                 */
/* ------------------------------------------------------------------ */

export async function mixedFontsPdf(): Promise<FixturePdf> {
  const { doc, page } = await newDoc();
  const fonts = await standard(page);
  // 30pt rhythm keeps each styled line its own block (merge limit is
  // 1.95 × fontSize), so per-block font capture is actually observable.
  drawLines(page, [
    { text: 'Bold lead sentence introduces the topic.', x: LEFT, y: 740, size: 14, font: fonts.bold },
    { text: 'Normal weight text continues the thought.', x: LEFT, y: 710, size: 12, font: fonts.regular },
    { text: 'Italic line adds emphasis here.', x: LEFT, y: 680, size: 12, font: fonts.italic },
    { text: 'Courier line uses fixed pitch styling.', x: LEFT, y: 650, size: 12, font: fonts.courier },
    { text: 'A final Times line closes the sample.', x: LEFT, y: 620, size: 11, font: fonts.times },
  ]);
  return { bytes: await doc.save() };
}

/* ------------------------------------------------------------------ */
/* 7. Burmese text                                                     */
/* ------------------------------------------------------------------ */

export const BURMESE_LINES = {
  heading: 'မြန်မာစာ ခေါင်းစဉ်',
  body1: 'ဤစာရွက်စာတမ်းသည် စမ်းသပ်မှုအတွက် ရေးသားထားခြင်း ဖြစ်သည်။',
  body2: 'စာပိုဒ်နှစ်ပိုဒ်ကို ကွဲပြားစွာ ဖန်တီးထားသည်။',
} as const;

export async function burmesePdf(): Promise<FixturePdf> {
  const { doc, page } = await newDoc();
  doc.registerFontkit(fontkit);
  const myFont = await doc.embedFont(readFileSync(BURMESE_FONT_PATH));
  drawLines(page, [
    { text: BURMESE_LINES.heading, x: LEFT, y: 750, size: 18, font: myFont },
    { text: BURMESE_LINES.body1, x: LEFT, y: 720, size: 12, font: myFont },
    { text: BURMESE_LINES.body2, x: LEFT, y: 704, size: 12, font: myFont },
  ]);
  return { bytes: await doc.save() };
}

/* ------------------------------------------------------------------ */
/* 8. Scanned / image-only pages                                       */
/* ------------------------------------------------------------------ */

export async function scannedPdf(): Promise<FixturePdf> {
  const { doc, page } = await newDoc();
  const fonts = await standard(page);
  const image = await doc.embedPng(solidPng(24, 32));
  // Page 0: a full-page "scan" with no selectable text.
  page.drawImage(image, { x: 40, y: 40, width: 515, height: 762 });
  // Page 1: a normal text page so tests prove per-page isolation.
  const second = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawLines(second, [
    { text: 'A normal text page follows the scanned one.', x: LEFT, y: 740, size: 11, font: fonts.regular },
    { text: 'Its paragraph must still be analyzed correctly.', x: LEFT, y: 724, size: 11, font: fonts.regular },
  ]);
  return { bytes: await doc.save() };
}

/* ------------------------------------------------------------------ */
/* 9. Rotated page                                                     */
/* ------------------------------------------------------------------ */

export async function rotatedPdf(): Promise<FixturePdf> {
  const { doc, page } = await newDoc();
  const fonts = await standard(page);
  page.setRotation(degrees(90));
  drawLines(page, [
    { text: 'This page carries a ninety degree rotation flag.', x: LEFT, y: 740, size: 11, font: fonts.regular },
    { text: 'Extraction still happens in unrotated content space.', x: LEFT, y: 724, size: 11, font: fonts.regular },
  ]);
  return { bytes: await doc.save() };
}

/* ------------------------------------------------------------------ */
/* Tiny grayscale PNG encoder (no image dependency)                    */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Uint8Array): number {
  let crc = -1;
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** Solid light-gray PNG, generated so fixtures never depend on binary blobs. */
export function solidPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc(height * (1 + width));
  for (let row = 0; row < height; row += 1) {
    const offset = row * (1 + width);
    raw[offset] = 0; // filter: none
    raw.fill(0xc8, offset + 1, offset + 1 + width);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
