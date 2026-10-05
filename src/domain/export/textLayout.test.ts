import { describe, expect, it } from 'vitest';
import type { TextMetrics } from './textLayout';
import { measureLine, overflowingLines, wrapText } from './textLayout';

/** Deterministic fake: 0.5pt per char per pt of size (like a 0.5em advance). */
const metrics: TextMetrics = {
  width: (text, _role, size) => text.length * size * 0.5,
};

describe('export text layout', () => {
  it('measures mixed-script lines through both font roles', () => {
    // "Myanmar " (8 chars) + "မြန်မာ" (6 chars) at size 10 -> 14 * 5.
    expect(measureLine('Myanmar မြန်မာ', 10, metrics)).toBe(14 * 10 * 0.5);
  });

  it('wraps plain text to the available width', () => {
    // 20 chars * 5 = 100pt wide at size 10; column 60 fits 12 chars.
    const lines = wrapText('aaaa bbbb cccc dddd', { maxWidth: 60, size: 10, metrics });
    expect(lines).toEqual(['aaaa bbbb', 'cccc dddd']);
  });

  it('keeps hard line breaks from the source', () => {
    const lines = wrapText('one two\nthree', { maxWidth: 500, size: 10, metrics });
    expect(lines).toEqual(['one two', 'three']);
  });

  it('breaks a word that is wider than the whole column', () => {
    const lines = wrapText('aaaaaaaaaaaaaaaa', { maxWidth: 40, size: 10, metrics });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe('aaaaaaaaaaaaaaaa');
  });

  it('never starts a line with a Burmese combining mark', () => {
    // က (base) plus many combining asats: clusters stay whole per line.
    const text = `က${'်'.repeat(20)}`;
    const lines = wrapText(text, { maxWidth: 40, size: 10, metrics });
    for (const line of lines.slice(1)) {
      expect(line.codePointAt(0)).not.toBe(0x103a);
    }
    expect(lines.join('')).toBe(text);
  });

  it('returns nothing for blank input', () => {
    expect(wrapText('', { maxWidth: 100, size: 10, metrics })).toEqual([]);
    expect(wrapText('   \n  ', { maxWidth: 100, size: 10, metrics })).toEqual([]);
  });

  it('reports lines that still exceed the column (drawn, never clipped)', () => {
    const options = { maxWidth: 40, size: 10, metrics };
    const lines = wrapText('XX aaaaaaaaaaaa', options);
    expect(overflowingLines(lines, options)).toEqual([]);
    // A single glyph wider than the column cannot be broken further.
    expect(overflowingLines(['က'], { maxWidth: 1, size: 10, metrics })).toEqual(['က']);
  });
});
