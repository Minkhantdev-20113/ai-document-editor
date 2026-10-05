import { describe, expect, it } from 'vitest';
import {
  coversBurmese,
  coversLatin,
  DEFAULT_EXPORT_FONTS,
  isBurmeseFontId,
  isLatinFontId,
  isMyanmarCodePoint,
  isMyanmarText,
  missingGlyphs,
  segmentText,
} from './fonts';

describe('export font catalog', () => {
  it('routes Myanmar code points to the Burmese font and everything else to Latin', () => {
    expect(segmentText('Hello')).toEqual([{ role: 'latin', text: 'Hello' }]);
    expect(segmentText('မြန်မာ')).toEqual([{ role: 'burmese', text: 'မြန်မာ' }]);
    expect(segmentText('Myanmar မြန်မာစာ 100%')).toEqual([
      { role: 'latin', text: 'Myanmar ' },
      { role: 'burmese', text: 'မြန်မာစာ' },
      { role: 'latin', text: ' 100%' },
    ]);
    expect(segmentText('')).toEqual([]);
  });

  it('classifies the Myanmar blocks (base, extended-A, extended-B)', () => {
    expect(isMyanmarCodePoint(0x1000)).toBe(true); // ka
    expect(isMyanmarCodePoint(0x109f)).toBe(true); // shan sign
    expect(isMyanmarCodePoint(0xa9e0)).toBe(true); // extended-A
    expect(isMyanmarCodePoint(0xaa60)).toBe(true); // extended-B
    expect(isMyanmarCodePoint(0x10a0)).toBe(false); // Georgian
    expect(isMyanmarCodePoint(0x41)).toBe(false); // A
    expect(isMyanmarText('abc')).toBe(false);
    expect(isMyanmarText('abc မြန်မာ')).toBe(true);
  });

  it('knows what each font role can draw', () => {
    expect(coversLatin(0x41)).toBe(true);
    expect(coversLatin(0x2014)).toBe(true); // em dash is WinAnsi
    expect(coversLatin(0x1000)).toBe(false); // Myanmar never fits Times
    expect(coversBurmese(0x1000)).toBe(true);
    expect(coversBurmese(0x41)).toBe(true);
    expect(coversBurmese(0x4e2d)).toBe(false); // CJK is not covered
    expect(missingGlyphs('hello မြန်မာ')).toEqual([]);
    expect(missingGlyphs('中文')).toEqual(['中', '文']);
  });

  it('validates user font choices', () => {
    expect(isLatinFontId('times')).toBe(true);
    expect(isLatinFontId('padauk')).toBe(false);
    expect(isBurmeseFontId('noto-sans-myanmar')).toBe(true);
    expect(isBurmeseFontId('helvetica')).toBe(false);
    expect(DEFAULT_EXPORT_FONTS).toEqual({ latin: 'times', burmese: 'padauk' });
  });
});
