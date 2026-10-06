import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LanguageDetection, PageIR } from '../../domain/analysis/ir';
import { analyzePage } from '../../domain/analysis/pipeline';
import type { AnalysisSource } from '../../domain/analysis/source';
import {
  ocrRegistry,
  type OcrPageInput,
  type OcrPageResult,
  type OcrProvider,
} from '../ocrRegistry';
import { recognizeImageOnlyPage, type RecognizePageOptions } from './ocrService';
import { preferredOcrLanguage, supportedOcrLanguage } from './ocrSupport';

/**
 * OCR orchestration tests with a fake provider: they pin the contract that
 * every miss degrades to `null` (page untouched) and that a recognized page
 * goes through the normal analysis pipeline.
 */

const DOCUMENT_ID = 'doc_ocr';
const PROVIDER_ID = 'fake-ocr';

const DETECTION: LanguageDetection = {
  code: 'en',
  confidence: 0.9,
  scores: { en: 1 },
  sampleChars: 120,
};

interface DocOverrides {
  readonly sourceLanguage?: string;
  readonly languageDetection?: LanguageDetection | null;
}

function doc(overrides: DocOverrides = {}) {
  return {
    id: DOCUMENT_ID,
    sourceLanguage: overrides.sourceLanguage ?? 'en',
    languageDetection: overrides.languageDetection === null ? null : (overrides.languageDetection ?? DETECTION),
  };
}

/** An image-only page: images but not three characters of selectable text. */
function imageOnlyPage(documentId = DOCUMENT_ID): PageIR {
  return analyzePage(
    {
      index: 0,
      width: 612,
      height: 792,
      rotation: 0,
      items: [],
      fonts: [],
      images: [{ bbox: { x: 40, y: 40, width: 532, height: 712 } }],
      links: [],
    },
    documentId,
  );
}

/** Fake source: rasterizes (counted) unless `renderPage` is omitted. */
function source(options: { readonly renderable?: boolean; readonly raster?: boolean } = {}): {
  readonly source: AnalysisSource;
  readonly renders: () => number;
} {
  let renders = 0;
  const base: AnalysisSource = {
    open: async () => ({ pageCount: 1, metadata: null, title: null }),
    page: async () => imageOnlyPage(),
    close: async () => undefined,
  };
  if (options.renderable === false) return { source: base, renders: () => renders };
  return {
    source: {
      ...base,
      renderPage: async () => {
        renders += 1;
        if (options.raster === false) return null;
        return { blob: new Blob([new Uint8Array([137, 80, 78, 71])]), scale: 2 };
      },
    },
    renders: () => renders,
  };
}

function recognizedLines(): OcrPageResult {
  return {
    text: 'A paragraph that OCR actually read from the page.',
    confidence: 0.87,
    lines: [
      { text: 'A paragraph that OCR actually read', bbox: { x: 52, y: 70, width: 300, height: 18 } },
      { text: 'from the page.', bbox: { x: 52, y: 92, width: 120, height: 18 } },
    ],
  };
}

function fakeProvider(overrides: Partial<OcrProvider> = {}): OcrProvider {
  return {
    id: PROVIDER_ID,
    label: 'Fake OCR',
    languages: ['en'],
    recognize: async () => recognizedLines(),
    ...overrides,
  };
}

function options(
  document: ReturnType<typeof doc>,
  source: AnalysisSource,
): RecognizePageOptions {
  const page = imageOnlyPage();
  return { document, index: 0, page, source };
}

afterEach(() => {
  ocrRegistry.unregister(PROVIDER_ID);
  vi.restoreAllMocks();
});

describe('recognizeImageOnlyPage', () => {
  it('turns recognized lines into an analyzed page', async () => {
    ocrRegistry.register(fakeProvider());
    const { source: src } = source();

    const result = await recognizeImageOnlyPage(options(doc(), src));

    expect(result).not.toBeNull();
    expect(result!.id).toBe(`${DOCUMENT_ID}_p0`);
    expect(result!.requiresOcr).toBe(false);
    expect(result!.charCount).toBeGreaterThan(3);
    expect(result!.blocks.length).toBeGreaterThan(0);
    expect(result!.blocks.map((block) => block.text).join(' ')).toContain('OCR actually read');
    // Geometry is preserved so the page still knows it is an image-backed page.
    expect(result!.images).toHaveLength(1);
    expect(result!.rotation).toBe(0);
  });

  it('leaves the page untouched when no engine is registered', async () => {
    const { source: src, renders } = source();

    const result = await recognizeImageOnlyPage(options(doc(), src));

    expect(result).toBeNull();
    expect(renders()).toBe(0);
  });

  it('refuses a language it ships no model for, without rasterizing', async () => {
    ocrRegistry.register(fakeProvider({ languages: ['my'] }));
    const { source: src, renders } = source();

    const result = await recognizeImageOnlyPage(options(doc(), src));

    expect(result).toBeNull();
    expect(renders()).toBe(0);
  });

  it('gives up when the page cannot be rasterized', async () => {
    ocrRegistry.register(fakeProvider());
    const withoutRenderer = source({ renderable: false });
    const withoutPixels = source({ raster: false });

    expect(await recognizeImageOnlyPage(options(doc(), withoutRenderer.source))).toBeNull();
    expect(await recognizeImageOnlyPage(options(doc(), withoutPixels.source))).toBeNull();
    expect(withoutRenderer.renders()).toBe(0);
    expect(withoutPixels.renders()).toBe(1);
  });

  it('keeps the page image-only when the provider fails', async () => {
    ocrRegistry.register(
      fakeProvider({
        recognize: async () => {
          throw new Error('engine exploded');
        },
      }),
    );
    const { source: src } = source();

    await expect(recognizeImageOnlyPage(options(doc(), src))).resolves.toBeNull();
  });

  it('keeps the page image-only when recognition returns nothing usable', async () => {
    ocrRegistry.register(fakeProvider({ recognize: async () => ({ text: '', confidence: 0, lines: [] }) }));
    const { source: src } = source();

    expect(await recognizeImageOnlyPage(options(doc(), src))).toBeNull();

    // Boxes below the OCR noise floor are dropped rather than stored as blocks.
    ocrRegistry.register(
      fakeProvider({
        recognize: async (): Promise<OcrPageResult> => ({
          text: 'hi',
          confidence: 0.1,
          lines: [{ text: 'hi', bbox: { x: 0, y: 0, width: 0, height: 0 } }],
        }),
      }),
    );
    expect(await recognizeImageOnlyPage(options(doc(), src))).toBeNull();
  });

  it('passes the page size, scale and language to the provider', async () => {
    const recognize = vi.fn(
      async (_input: OcrPageInput): Promise<OcrPageResult> => recognizedLines(),
    );
    ocrRegistry.register(fakeProvider({ recognize }));
    const { source: src } = source();

    await recognizeImageOnlyPage(options(doc(), src));

    expect(recognize).toHaveBeenCalledTimes(1);
    const input = recognize.mock.calls[0]![0];
    expect(input.documentId).toBe(DOCUMENT_ID);
    expect(input.pageIndex).toBe(0);
    expect(input.width).toBe(612);
    expect(input.height).toBe(792);
    expect(input.scale).toBe(2);
    expect(input.language).toBe('en');
    expect(input.image).toBeInstanceOf(Blob);
  });
});

describe('OCR language selection', () => {
  it('prefers the detected language over the declared one', () => {
    expect(preferredOcrLanguage(doc({ sourceLanguage: 'en', languageDetection: DETECTION }))).toBe('en');
    expect(
      preferredOcrLanguage(doc({ sourceLanguage: 'en', languageDetection: { ...DETECTION, code: 'my' } })),
    ).toBe('my');
  });

  it('falls back to the declared language when detection is unknown', () => {
    expect(
      preferredOcrLanguage(doc({ sourceLanguage: 'my', languageDetection: { ...DETECTION, code: 'unknown' } })),
    ).toBe('my');
    expect(preferredOcrLanguage(doc({ sourceLanguage: 'fr', languageDetection: null }))).toBe('fr');
  });

  it('reports a supported language only when an engine actually has the model', () => {
    expect(supportedOcrLanguage(doc())).toBeNull();
    ocrRegistry.register(fakeProvider());
    expect(supportedOcrLanguage(doc())).toBe('en');
    expect(supportedOcrLanguage(doc({ sourceLanguage: 'de', languageDetection: null }))).toBeNull();
    // Detection missed the language, but the declared one has a model.
    expect(
      supportedOcrLanguage(doc({ sourceLanguage: 'en', languageDetection: { ...DETECTION, code: 'ja' } })),
    ).toBe('en');
    expect(
      supportedOcrLanguage(doc({ sourceLanguage: 'de', languageDetection: { ...DETECTION, code: 'ja' } })),
    ).toBeNull();
  });
});
