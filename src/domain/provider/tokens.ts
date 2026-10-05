/**
 * Local token estimation (no network, no tokenizer download).
 *
 * Estimation must never UNDER-estimate: batches are sized from these numbers
 * and an under-estimate could push a request past the model context window.
 * Script-aware weights therefore round up for non-Latin scripts, where
 * tokenizers typically emit 1-3 tokens per character (Burmese included).
 */

const CHAR_WEIGHT_ASCII = 0.25; // ~4 characters per token
const CHAR_WEIGHT_WIDE = 1.5; // CJK / Myanmar / Indic: conservative over-estimate

function isWideScript(codePoint: number): boolean {
  return (
    (codePoint >= 0x0900 && codePoint <= 0x097f) || // Devanagari
    (codePoint >= 0x0e00 && codePoint <= 0x0e7f) || // Thai
    (codePoint >= 0x1000 && codePoint <= 0x109f) || // Myanmar
    (codePoint >= 0x3000 && codePoint <= 0x9fff) || // CJK punctuation, Kana, CJK ideographs
    (codePoint >= 0xa9e0 && codePoint <= 0xa9ff) || // Myanmar Extended-A
    (codePoint >= 0xaa60 && codePoint <= 0xaa7f) || // Myanmar Extended-B
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) // CJK compatibility ideographs
  );
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let units = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      units += CHAR_WEIGHT_ASCII;
    } else if (isWideScript(codePoint)) {
      units += CHAR_WEIGHT_WIDE;
    } else {
      units += 1;
    }
  }
  return Math.ceil(units);
}

export interface EstimableMessage {
  readonly content: string;
}

/** Content tokens plus a small per-message framing allowance. */
export function estimateMessagesTokens(messages: readonly EstimableMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(message.content) + 4;
  }
  return total;
}
