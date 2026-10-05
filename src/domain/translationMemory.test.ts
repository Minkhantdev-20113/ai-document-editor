import { describe, expect, it } from 'vitest';
import { MEMORY_THRESHOLDS, normalizeForMatch, similarityScore } from './translationMemory';

describe('normalizeForMatch', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normalizeForMatch('  The  Submit-Button (v2)! ')).toBe('the submit button v2');
    expect(normalizeForMatch('မြန်မာနိုင်ငံ')).toBe('မြန်မာနိုင်ငံ');
  });
});

describe('similarityScore', () => {
  it('scores exact normalized equality as 1 regardless of case/punctuation', () => {
    expect(similarityScore('Click Submit.', 'click   SUBMIT')).toBe(1);
    expect(similarityScore('မြန်မာ', 'မြန်မာ')).toBe(1);
  });

  it('scores empty input as 0 (never matches nothing)', () => {
    expect(similarityScore('', 'anything')).toBe(0);
    expect(similarityScore('   ', 'anything')).toBe(0);
    expect(similarityScore('', '')).toBe(0);
  });

  it('ranks shared-content pairs above unrelated ones', () => {
    const base = 'Click the Submit button to save the document';
    const similar = similarityScore(base, 'Click the Submit button for saving the document');
    const partial = similarityScore(base, 'Click the Cancel button to discard');
    const unrelated = similarityScore(base, 'The weather in Yangon is hot today');
    expect(similar).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(unrelated);
    expect(unrelated).toBeLessThan(MEMORY_THRESHOLDS.suggest);
  });

  it('handles unspaced scripts through character bigrams', () => {
    const base = 'စာရွက်စာတမ်းကို ဘာသာပြန်ပါ';
    const near = 'စာရွက်စာတမ်းကို ဘာသာပြန်နိုင်သည်';
    const far = 'ရာသီဥတု ပူပူနွေးနွေးရှိသည်';
    expect(similarityScore(base, near)).toBeGreaterThan(similarityScore(base, far));
    expect(similarityScore(base, near)).toBeGreaterThanOrEqual(MEMORY_THRESHOLDS.suggest);
  });

  it('stays within [0, 1] and is symmetric', () => {
    const a = 'Server: https://example.com/docs';
    const b = 'ဆာဗာ - https://example.com/docs';
    const ab = similarityScore(a, b);
    const ba = similarityScore(b, a);
    expect(ab).toBeCloseTo(ba, 10);
    expect(ab).toBeGreaterThanOrEqual(0);
    expect(ab).toBeLessThanOrEqual(1);
  });

  it('keeps the auto-apply threshold strictly above the suggestion threshold', () => {
    expect(MEMORY_THRESHOLDS.suggest).toBeGreaterThan(0);
    expect(MEMORY_THRESHOLDS.suggest).toBeLessThan(MEMORY_THRESHOLDS.autoApply);
    expect(MEMORY_THRESHOLDS.autoApply).toBeLessThanOrEqual(1);
  });
});
