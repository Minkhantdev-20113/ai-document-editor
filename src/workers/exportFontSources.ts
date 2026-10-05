import type { BurmeseFontId } from '../domain/export/fonts';

/**
 * Where the bundled export fonts live (Phase 5).
 *
 * The two Burmese-capable families ship with the app (SIL OFL, see the
 * `OFL-*.txt` files next to them) and are fetched inside the export worker by
 * URL, so no font is ever base64-inlined into the bundle.
 */
export interface BurmeseFontFiles {
  readonly regular: URL;
  readonly bold: URL;
}

export const BURMESE_FONT_FILES: Readonly<Record<BurmeseFontId, BurmeseFontFiles>> = {
  padauk: {
    regular: new URL('../assets/fonts/Padauk-Regular.ttf', import.meta.url),
    bold: new URL('../assets/fonts/Padauk-Bold.ttf', import.meta.url),
  },
  'noto-sans-myanmar': {
    regular: new URL('../assets/fonts/NotoSansMyanmar-Regular.ttf', import.meta.url),
    bold: new URL('../assets/fonts/NotoSansMyanmar-Bold.ttf', import.meta.url),
  },
};

export type FontBytesLoader = (url: URL) => Promise<Uint8Array>;

/** Loader used by the worker in the browser. */
export const fetchFontBytes: FontBytesLoader = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load export font (${response.status}): ${url.pathname}`);
  }
  return new Uint8Array(await response.arrayBuffer());
};
