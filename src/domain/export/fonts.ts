/**
 * Export font configuration (Phase 5).
 *
 * Two font roles travel through the whole export pipeline:
 * - `latin`: the default text font (Times Roman and friends, shipped with the
 *   PDF spec, so no embedding is required),
 * - `burmese`: a bundled Unicode font with real Myanmar glyph coverage.
 *
 * Times New Roman alone cannot render Burmese - a font that supports the
 * Myanmar block must be used for those code points, which is why every line is
 * segmented into runs and drawn with the font whose coverage matches.
 *
 * Nothing here touches IndexedDB or the file system: the catalog is data, the
 * coverage rules are pure predicates, so layout tests need no font bytes.
 */

/** Role a run of text plays when picking a font. */
export type FontRole = 'latin' | 'burmese';

/** Built-in Latin families (PDF standard 14 fonts - never embedded). */
export const LATIN_FONTS = ['times', 'helvetica', 'courier'] as const;
export type LatinFontId = (typeof LATIN_FONTS)[number];

/** Bundled Burmese-capable fonts (embedded into every produced PDF). */
export const BURMESE_FONTS = ['padauk', 'noto-sans-myanmar'] as const;
export type BurmeseFontId = (typeof BURMESE_FONTS)[number];

export type ExportFontSelection = {
  readonly latin: LatinFontId;
  readonly burmese: BurmeseFontId;
};

export const DEFAULT_EXPORT_FONTS: Readonly<ExportFontSelection> = {
  latin: 'times',
  burmese: 'padauk',
};

export function isLatinFontId(value: unknown): value is LatinFontId {
  return typeof value === 'string' && (LATIN_FONTS as readonly string[]).includes(value);
}

export function isBurmeseFontId(value: unknown): value is BurmeseFontId {
  return typeof value === 'string' && (BURMESE_FONTS as readonly string[]).includes(value);
}

/** Human-readable labels for the font pickers (UI localizes the family names). */
export const FONT_LABELS: Readonly<Record<LatinFontId | BurmeseFontId, string>> = {
  times: 'Times Roman',
  helvetica: 'Helvetica',
  courier: 'Courier',
  padauk: 'Padauk',
  'noto-sans-myanmar': 'Noto Sans Myanmar',
};

/** Myanmar Unicode blocks (Myanmar + Extended-A + Extended-B). */
const MYANMAR_RANGES: readonly (readonly [number, number])[] = [
  [0x1000, 0x109f],
  [0xa9e0, 0xa9ff],
  [0xaa60, 0xaa7f],
];

export function isMyanmarCodePoint(codePoint: number): boolean {
  return MYANMAR_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

export function isMyanmarText(text: string): boolean {
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && isMyanmarCodePoint(codePoint)) return true;
  }
  return false;
}

/**
 * WinAnsi coverage of the PDF standard fonts. Anything outside this set
 * (including the Myanmar block) must be routed to a font that has the glyph.
 */
export function coversLatin(codePoint: number): boolean {
  if (codePoint <= 0x00ff) return true;
  return (
    (codePoint >= 0x0152 && codePoint <= 0x0153) || // OE / oe
    (codePoint >= 0x0160 && codePoint <= 0x0161) || // S caron
    (codePoint >= 0x0178 && codePoint <= 0x017e) || // Y diaeresis .. z caron
    (codePoint >= 0x2013 && codePoint <= 0x2014) || // dashes
    (codePoint >= 0x2018 && codePoint <= 0x201d) || // quotes
    (codePoint >= 0x2020 && codePoint <= 0x2022) || // daggers, bullet
    codePoint === 0x2026 || // ellipsis
    (codePoint >= 0x2030 && codePoint <= 0x203a) || // permille .. guillemets
    codePoint === 0x20ac || // euro
    codePoint === 0x2122 // trademark
  );
}

/**
 * Coverage of the bundled Burmese fonts: Latin + general punctuation + the
 * Myanmar block. Used to route a code point and to flag glyphs that no
 * configured font can draw.
 */
export function coversBurmese(codePoint: number): boolean {
  if (codePoint <= 0x024f) return true;
  if (isMyanmarCodePoint(codePoint)) return true;
  return codePoint >= 0x2000 && codePoint <= 0x206f;
}

export interface TextRun {
  readonly role: FontRole;
  readonly text: string;
}

/**
 * Splits text into maximal same-font runs. Burmese code points always go to
 * the Burmese font; everything else goes to the Latin font, so mixed-language
 * output keeps both scripts intact.
 */
export function segmentText(text: string): TextRun[] {
  const runs: TextRun[] = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    const role: FontRole = isMyanmarCodePoint(codePoint) ? 'burmese' : 'latin';
    const last = runs[runs.length - 1];
    if (last && last.role === role) {
      runs[runs.length - 1] = { role, text: last.text + char };
    } else {
      runs.push({ role, text: char });
    }
  }
  return runs;
}

/** Code points in `text` that neither configured font can draw. */
export function missingGlyphs(text: string): string[] {
  const missing: string[] = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (coversLatin(codePoint) || coversBurmese(codePoint)) continue;
    if (!missing.includes(char)) missing.push(char);
  }
  return missing;
}
