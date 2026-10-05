import { describe, expect, it } from 'vitest';
import { estimateMessagesTokens, estimateTokens } from './tokens';

describe('estimateTokens', () => {
  it('returns 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('uses roughly four characters per token for ASCII', () => {
    expect(estimateTokens('hello world')).toBe(3); // ceil(11 * 0.25)
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });

  it('never under-estimates Burmese text (>= 1 token per character)', () => {
    const burmese = 'မြန်မာနိုင်ငံ၊ ရန်ကုန်မြို့';
    expect(estimateTokens(burmese)).toBeGreaterThanOrEqual([...burmese].length);
  });

  it('never under-estimates CJK text', () => {
    const cjk = '日本語のテキスト';
    expect(estimateTokens(cjk)).toBeGreaterThanOrEqual([...cjk].length);
  });

  it('weights mixed scripts per code point', () => {
    // 3 ASCII chars -> 0.75, 2 CJK chars -> 3.0, total 3.75 -> ceil 4.
    expect(estimateTokens('abc日本')).toBe(4);
  });
});

describe('estimateMessagesTokens', () => {
  it('adds a framing allowance per message', () => {
    const messages = [{ content: 'hello world' }, { content: '' }];
    expect(estimateMessagesTokens(messages)).toBe(estimateTokens('hello world') + 4 + 4);
  });

  it('is at least the sum of content estimates', () => {
    const messages = [{ content: 'မြန်မာ' }, { content: 'plain text' }];
    const total = estimateMessagesTokens(messages);
    expect(total).toBeGreaterThanOrEqual(estimateTokens('မြန်မာ') + estimateTokens('plain text'));
  });
});
