/**
 * Export text engine (Phase 5).
 *
 * One object owns everything needed to measure and shape text during export:
 * - Latin runs use the PDF standard fonts (Times Roman and friends), so their
 *   widths come straight from the embedded AFM metrics,
 * - Burmese runs are shaped with HarfBuzz (harfbuzzjs) because plain cmap
 *   output would mis-order pre-base medials and never build kinzi ligatures,
 *   then measured from the shaped glyph advances.
 *
 * Layout and rendering both go through this engine, so what the planner
 * measured is exactly what the renderer draws. Instances live inside the
 * export worker; tests build them from the bundled font files with a Node
 * loader.
 */
import fontkit from '@pdf-lib/fontkit';
import { Blob as HbBlob, Buffer as HbBuffer, Face as HbFace, Font as HbFont, shape as hbShape } from 'harfbuzzjs';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import {
  segmentText,
  type ExportFontSelection,
  type FontRole,
  type LatinFontId,
} from '../domain/export/fonts';
import type { FontStyle, TextMetrics } from '../domain/export/textLayout';
import { BURMESE_FONT_FILES, fetchFontBytes, type FontBytesLoader } from './exportFontSources';

export type FontVariant = 'regular' | 'bold' | 'italic' | 'boldItalic';

export function variantFor(style?: FontStyle): FontVariant {
  if (style?.bold && style.italic) return 'boldItalic';
  if (style?.bold) return 'bold';
  if (style?.italic) return 'italic';
  return 'regular';
}

const LATIN_STANDARD_FONTS: Readonly<Record<LatinFontId, Readonly<Record<FontVariant, StandardFonts>>>> = {
  times: {
    regular: StandardFonts.TimesRoman,
    bold: StandardFonts.TimesRomanBold,
    italic: StandardFonts.TimesRomanItalic,
    boldItalic: StandardFonts.TimesRomanBoldItalic,
  },
  helvetica: {
    regular: StandardFonts.Helvetica,
    bold: StandardFonts.HelveticaBold,
    italic: StandardFonts.HelveticaOblique,
    boldItalic: StandardFonts.HelveticaBoldOblique,
  },
  courier: {
    regular: StandardFonts.Courier,
    bold: StandardFonts.CourierBold,
    italic: StandardFonts.CourierOblique,
    boldItalic: StandardFonts.CourierBoldOblique,
  },
};

/** One shaped glyph with its advance/offsets in points at the shaped size. */
export interface ShapedGlyph {
  readonly id: number;
  readonly advance: number;
  readonly xOffset: number;
  readonly yOffset: number;
}

export interface ShapedRun {
  readonly glyphs: readonly ShapedGlyph[];
  readonly width: number;
}

interface BurmeseFace {
  readonly bytes: Uint8Array;
  readonly fontkit: ReturnType<typeof fontkit.create>;
  readonly hb: HbFont;
  readonly upem: number;
}

const MEMO_LIMIT = 20_000;

export class ExportTextEngine {
  private readonly memo = new Map<string, number>();

  private constructor(
    readonly selection: ExportFontSelection,
    private readonly latinFonts: ReadonlyMap<StandardFonts, PDFFont>,
    private readonly burmeseFaces: Readonly<Record<'regular' | 'bold', BurmeseFace>>,
  ) {}

  static async create(
    selection: ExportFontSelection,
    loadBytes: FontBytesLoader = fetchFontBytes,
  ): Promise<ExportTextEngine> {
    const measureDoc = await PDFDocument.create();
    const latinFonts = new Map<StandardFonts, PDFFont>();
    // The selected family plus Courier (code blocks), in all four variants —
    // standard-14 fonts embed from built-in AFM metrics, so this is cheap.
    for (const programs of [LATIN_STANDARD_FONTS[selection.latin], LATIN_STANDARD_FONTS.courier]) {
      for (const program of Object.values(programs)) {
        if (!latinFonts.has(program)) latinFonts.set(program, await measureDoc.embedFont(program));
      }
    }

    const files = BURMESE_FONT_FILES[selection.burmese];
    const [regularBytes, boldBytes] = await Promise.all([loadBytes(files.regular), loadBytes(files.bold)]);
    const burmeseFaces = {
      regular: await loadBurmeseFace(regularBytes),
      bold: await loadBurmeseFace(boldBytes),
    };

    return new ExportTextEngine(selection, latinFonts, burmeseFaces);
  }

  /** Bound implementation of the planner's {@link TextMetrics}. */
  readonly metrics: TextMetrics = {
    width: (text, role, size, style) => this.width(text, role, size, style),
  };

  width(text: string, role: FontRole, size: number, style?: FontStyle): number {
    if (text === '') return 0;
    const variant = variantFor(style);
    const key = `${role}|${variant}|${style?.mono ? 'm' : ''}|${size}|${text}`;
    const cached = this.memo.get(key);
    if (cached !== undefined) return cached;

    const value =
      role === 'latin'
        ? this.latinFont(style).widthOfTextAtSize(text, size)
        : this.burmeseWidth(text, size, variant === 'bold');

    if (this.memo.size >= MEMO_LIMIT) this.memo.clear();
    this.memo.set(key, value);
    return value;
  }

  /** Shapes Burmese text with HarfBuzz and scales the result to `size`. */
  shapeBurmese(text: string, size: number, bold = false): ShapedRun {
    const face = this.burmeseFaces[bold ? 'bold' : 'regular'];
    const buffer = new HbBuffer();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    hbShape(face.hb, buffer);

    const infos = buffer.getGlyphInfos();
    const positions = buffer.getGlyphPositions();
    const scale = size / face.upem;
    const glyphs: ShapedGlyph[] = infos.map((info, index) => {
      const position = positions[index];
      return {
        id: info.codepoint,
        advance: (position?.xAdvance ?? 0) * scale,
        xOffset: (position?.xOffset ?? 0) * scale,
        yOffset: (position?.yOffset ?? 0) * scale,
      };
    });

    let width = 0;
    for (const glyph of glyphs) width += glyph.advance;
    return { glyphs, width };
  }

  /** Characters the Burmese font cannot draw (rendering would show tofu). */
  missingBurmeseGlyphs(text: string, bold = false): string[] {
    const face = this.burmeseFaces[bold ? 'bold' : 'regular'];
    const missing: string[] = [];
    for (const char of text) {
      const codePoint = char.codePointAt(0) ?? 0;
      if (face.fontkit.hasGlyphForCodePoint(codePoint)) continue;
      if (!missing.includes(char)) missing.push(char);
    }
    return missing;
  }

  /** PDF program for a Latin run (renderer embeds it per page). */
  latinProgram(style?: FontStyle): StandardFonts {
    const family = style?.mono ? LATIN_STANDARD_FONTS.courier : LATIN_STANDARD_FONTS[this.selection.latin];
    return family[variantFor(style)];
  }

  private latinFont(style?: FontStyle): PDFFont {
    const font = this.latinFonts.get(this.latinProgram(style));
    if (!font) throw new Error(`Export font program not embedded: ${this.latinProgram(style)}`);
    return font;
  }

  /** Raw bytes of the Burmese font a page must embed. */
  burmeseBytes(bold = false): Uint8Array {
    return this.burmeseFaces[bold ? 'bold' : 'regular'].bytes;
  }

  /**
   * Advance of one font glyph at `size` in points, straight from the hmtx
   * table (what a PDF viewer will add to the pen) — used to decide whether
   * consecutive glyphs can share a single positioning operator.
   */
  burmeseGlyphAdvancePoints(glyphId: number, size: number, bold = false): number {
    const face = this.burmeseFaces[bold ? 'bold' : 'regular'];
    return (face.fontkit.getGlyph(glyphId).advanceWidth * size) / face.upem;
  }

  /** Total width of a possibly mixed-script line (single entry point). */
  measure(text: string, size: number, style?: FontStyle): number {
    let width = 0;
    for (const run of segmentText(text)) {
      width += this.width(run.text, run.role, size, style);
    }
    return width;
  }

  private burmeseWidth(text: string, size: number, bold: boolean): number {
    return this.shapeBurmese(text, size, bold).width;
  }
}

async function loadBurmeseFace(bytes: Uint8Array): Promise<BurmeseFace> {
  const parsed = fontkit.create(bytes);
  const upem = parsed.unitsPerEm;
  const face = new HbFace(new HbBlob(bytes), 0);
  const hb = new HbFont(face);
  hb.setScale(upem, upem);
  return { bytes, fontkit: parsed, hb, upem };
}
