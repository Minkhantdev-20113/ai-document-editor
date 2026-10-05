import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import { StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_FONTS, segmentText } from '../domain/export/fonts';
import { wrapText } from '../domain/export/textLayout';
import type { FontBytesLoader } from './exportFontSources';
import { ExportTextEngine } from './exportTextEngine';

const loadBytes: FontBytesLoader = async (url) => new Uint8Array(await readFile(fileURLToPath(url)));

const enginePromise = ExportTextEngine.create(DEFAULT_EXPORT_FONTS, loadBytes);

const padaukPromise = (async () => {
  const url = new URL('../assets/fonts/Padauk-Regular.ttf', import.meta.url);
  return fontkit.create(new Uint8Array(await readFile(fileURLToPath(url))));
})();

async function naiveGlyphIds(text: string): Promise<number[]> {
  const parsed = await padaukPromise;
  return [...text].map((char) => parsed.glyphForCodePoint(char.codePointAt(0) ?? 0).id);
}

describe('ExportTextEngine', () => {
  it('measures Latin text with the selected standard font', async () => {
    const engine = await enginePromise;
    const at10 = engine.width('Translation sample', 'latin', 10);
    const at20 = engine.width('Translation sample', 'latin', 20);
    expect(at10).toBeGreaterThan(0);
    expect(at20).toBeCloseTo(at10 * 2, 5);
    expect(engine.latinProgram()).toBe(StandardFonts.TimesRoman);
  });

  it('measures Burmese text from shaped glyph advances', async () => {
    const engine = await enginePromise;
    const at12 = engine.width('မြန်မာနိုင်ငံ', 'burmese', 12);
    expect(at12).toBeGreaterThan(0);
    expect(engine.width('မြန်မာနိုင်ငံ', 'burmese', 24)).toBeCloseTo(at12 * 2, 5);

    const run = engine.shapeBurmese('မြန်မာနိုင်ငံ', 12);
    expect(run.width).toBeCloseTo(at12, 5);
    expect(run.glyphs.length).toBeGreaterThan(0);
  });

  it('splits measurement per font role, matching the planner', async () => {
    const engine = await enginePromise;
    const text = 'Myanmar မြန်မာစာ 100%';
    const viaSegmentation = segmentText(text).reduce(
      (sum, run) => sum + engine.width(run.text, run.role, 11),
      0,
    );
    expect(engine.measure(text, 11)).toBeCloseTo(viaSegmentation, 5);
    expect(engine.metrics.width('မြန်မာ', 'burmese', 11)).toBeCloseTo(
      engine.width('မြန်မာ', 'burmese', 11),
      5,
    );
  });

  it('shapes Burmese properly (reordering + ligatures, unlike raw cmap order)', async () => {
    const engine = await enginePromise;
    const kinziText = 'အင်္ဂလိပ်';
    const kinzi = engine.shapeBurmese(kinziText, 12);
    // Kinzi and stacked forms collapse into ligatures: fewer glyphs than chars.
    expect(kinzi.glyphs.length).toBeLessThan([...kinziText].length);
    expect(kinzi.glyphs.map((glyph) => glyph.id)).not.toEqual(await naiveGlyphIds(kinziText));

    // Pre-base medial ra must be drawn before its base consonant.
    const prebaseText = 'မြန်မာ';
    const prebase = engine.shapeBurmese(prebaseText, 12);
    const naivePrebase = await naiveGlyphIds(prebaseText);
    expect(prebase.glyphs.map((glyph) => glyph.id)).not.toEqual(naivePrebase);
    expect(prebase.glyphs[0]?.id).toBe(naivePrebase[1]); // medial ra first
  });

  it('reports characters the Burmese font cannot draw', async () => {
    const engine = await enginePromise;
    expect(engine.missingBurmeseGlyphs('မြန်မာ')).toEqual([]);
    expect(engine.missingBurmeseGlyphs('中文')).toEqual(['中', '文']);
  });

  it('uses the bold face for bold Burmese text', async () => {
    const engine = await ExportTextEngine.create(
      { latin: 'helvetica', burmese: 'noto-sans-myanmar' },
      loadBytes,
    );
    expect(engine.selection.burmese).toBe('noto-sans-myanmar');
    expect(engine.latinProgram({ bold: true, italic: false })).toBe(StandardFonts.HelveticaBold);
    expect(engine.burmeseBytes(true).byteLength).toBeGreaterThan(1000);
    // Same family, two files: the bold face really is a different font program.
    expect(Buffer.compare(Buffer.from(engine.burmeseBytes(true)), Buffer.from(engine.burmeseBytes(false)))).not.toBe(0);
    const run = engine.shapeBurmese('စာ', 12, true);
    expect(run.glyphs.length).toBeGreaterThan(0);
  });

  it('wraps real Burmese text without losing characters', async () => {
    const engine = await enginePromise;
    const text = 'မြန်မာနိုင်ငံသည် အရှေ့တောင်အာရှတွင် တည်ရှိပြီး စာပေနှင့် ရိုးရာဓလေ့များ ကြွယ်ဝသည်။';
    const lines = wrapText(text, { maxWidth: 200, size: 12, metrics: engine.metrics });
    expect(lines.length).toBeGreaterThan(1);
    // Reflow normalizes whitespace but never drops or reorders words.
    expect(lines.join(' ').split(/\s+/)).toEqual(text.split(/\s+/));
    for (const line of lines) {
      expect(engine.measure(line, 12)).toBeLessThanOrEqual(200 + 1e-6);
    }
  });
});
