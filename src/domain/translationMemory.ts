/**
 * Translation memory domain (Phase 4).
 *
 * Scores how similar two source texts are so a previously translated unit can
 * be offered as a suggestion when similar text appears again. Deterministic
 * and dependency-free: a blend of word-token and character-bigram Dice
 * coefficients, which behaves sensibly for spaced languages (English) and
 * unspaced scripts (Burmese) alike.
 */

export const MEMORY_THRESHOLDS = {
  /** Score at or above which a match is shown as a suggestion. */
  suggest: 0.6,
  /** Score at or above which auto-apply is allowed (still needs the opt-in). */
  autoApply: 0.9,
} as const;

/**
 * Normalized comparison form: lowercased, punctuation collapsed to spaces,
 * whitespace collapsed. Both sides always go through this, so matching is
 * punctuation-insensitive by construction.
 */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): string[] {
  return text.split(' ').filter(Boolean);
}

function bigrams(text: string): string[] {
  if (text.length === 1) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length - 1; i += 1) out.push(text.slice(i, i + 2));
  return out;
}

/** Dice coefficient over two multisets of items: 2|A∩B| / (|A|+|B|). */
function dice(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const item of a) counts.set(item, (counts.get(item) ?? 0) + 1);
  let shared = 0;
  for (const item of b) {
    const available = counts.get(item) ?? 0;
    if (available > 0) {
      shared += 1;
      counts.set(item, available - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/**
 * Similarity of two source texts in [0, 1].
 * `0` when either side normalizes to nothing; `1` for exact normalized
 * equality; otherwise the mean of word-token and char-bigram Dice scores.
 */
export function similarityScore(left: string, right: string): number {
  const a = normalizeForMatch(left);
  const b = normalizeForMatch(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const wordScore = dice(tokenize(a), tokenize(b));
  const charScore = dice(bigrams(a), bigrams(b));
  return 0.5 * wordScore + 0.5 * charScore;
}
