/**
 * Text measurement and line wrapping for export (Phase 5).
 *
 * Everything is driven by an injected {@link TextMetrics} implementation, so
 * the pure layout code can be tested without any font bytes while the worker
 * supplies real fontkit/HarfBuzz measurements.
 *
 * Rules (from the phase spec):
 * - translated text reflows inside the available width,
 * - long words are broken instead of being clipped,
 * - Burmese combining marks are never pushed to the start of a line,
 * - hard line breaks in the source are preserved.
 */
import { segmentText, type FontRole } from './fonts';

export interface TextMetrics {
  /** Width in points of `text` rendered with the font behind `role`. */
  width(text: string, role: FontRole, size: number, style?: FontStyle): number;
}

/** Weight/slant of a block; metrics depend on it, so it travels everywhere. */
export interface FontStyle {
  readonly bold: boolean;
  readonly italic: boolean;
  /** Forces the monospace (Courier) face, e.g. for code blocks. */
  readonly mono?: boolean;
}

/** Myanmar combining marks: never a valid line start (they belong to a base). */
function isMyanmarCombining(codePoint: number): boolean {
  return (
    (codePoint >= 0x102b && codePoint <= 0x103e) ||
    (codePoint >= 0x1056 && codePoint <= 0x1059) ||
    (codePoint >= 0x105e && codePoint <= 0x1060) ||
    (codePoint >= 0x1062 && codePoint <= 0x1064) ||
    (codePoint >= 0x1067 && codePoint <= 0x106d) ||
    (codePoint >= 0x1071 && codePoint <= 0x1074) ||
    codePoint === 0x1082 ||
    (codePoint >= 0x1087 && codePoint <= 0x108c) ||
    codePoint === 0x108f ||
    (codePoint >= 0x109a && codePoint <= 0x109c)
  );
}

/** Width of a possibly mixed-script line at `size`. */
export function measureLine(
  text: string,
  size: number,
  metrics: TextMetrics,
  style?: FontStyle,
): number {
  let width = 0;
  for (const run of segmentText(text)) {
    width += metrics.width(run.text, run.role, size, style);
  }
  return width;
}

export interface WrapOptions {
  /** Available width in points. */
  readonly maxWidth: number;
  readonly size: number;
  readonly metrics: TextMetrics;
  /** Weight/slant used for measurement (matches what the renderer draws). */
  readonly style?: FontStyle;
  /** Extra chars appended while hard-breaking a single unbreakable token. */
  readonly overfillTolerance?: number;
}

function pushWord(line: string, word: string): string {
  return line === '' ? word : `${line} ${word}`;
}

/**
 * Breaks one word that is wider than the whole line into fragments that fit.
 * Returns the fragments in order; combining marks stay attached to the
 * previous character, so a cluster is only split when it alone is too wide.
 */
function hardBreakWord(word: string, options: WrapOptions): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const char of word) {
    const width = measureLine(current + char, options.size, options.metrics, options.style);
    const wouldOverflow =
      current !== '' &&
      width > options.maxWidth &&
      !isMyanmarCombining(char.codePointAt(0) ?? 0);

    if (wouldOverflow) {
      chunks.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks.length > 0 ? chunks : [word];
}

/**
 * Wraps `text` into lines that fit `maxWidth`.
 *
 * Returns `[]` for blank input so callers can tell "nothing to draw" from a
 * single empty line.
 */
export function wrapText(text: string, options: WrapOptions): string[] {
  if (text.trim() === '') return [];

  const lines: string[] = [];
  const paragraphs = text.split('\n');

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter((word) => word !== '');
    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let line = '';
    for (const word of words) {
      const candidate = pushWord(line, word);
      const width = measureLine(candidate, options.size, options.metrics, options.style);

      if (width <= options.maxWidth) {
        line = candidate;
        continue;
      }

      if (line !== '') {
        lines.push(line);
        line = '';
      }

      const wordWidth = measureLine(word, options.size, options.metrics, options.style);
      if (wordWidth <= options.maxWidth) {
        line = word;
        continue;
      }

      const chunks = hardBreakWord(word, options);
      // Every chunk but the last one is already a finished line.
      while (chunks.length > 1) {
        lines.push(chunks.shift() ?? '');
      }
      line = chunks[0] ?? '';
    }

    if (line !== '') lines.push(line);
  }

  return lines;
}

/**
 * Lines still produced by the wrap that exceed the available width (single
 * glyphs wider than the column, or clusters that must not be split). These
 * are drawn wider rather than clipped - the caller surfaces a warning.
 */
export function overflowingLines(lines: readonly string[], options: WrapOptions): string[] {
  return lines.filter(
    (line) => measureLine(line, options.size, options.metrics, options.style) > options.maxWidth,
  );
}
