import { toAppError } from '../../core/errors/appError';
import { logger } from '../../core/logging/logger';
import type { DocumentRecord } from '../../db/entities';
import type { PageIR, RawTextItem } from '../../domain/analysis/ir';
import { analyzePage } from '../../domain/analysis/pipeline';
import type { AnalysisSource } from '../../domain/analysis/source';
import { ocrRegistry, type OcrLineResult } from '../ocrRegistry';
import { supportedOcrLanguage } from './ocrSupport';

/** A page only stops being "image-only" once OCR produced real text. */
const MIN_VISIBLE_CHARS = 3;
/** Single synthetic font: recognition carries no typography of its own. */
const OCR_FONT_KEY = 'ocr';

export interface RecognizePageOptions {
  readonly document: Pick<DocumentRecord, 'id' | 'sourceLanguage' | 'languageDetection'>;
  readonly index: number;
  readonly page: PageIR;
  readonly source: AnalysisSource;
}

/**
 * Reads one image-only page through the OCR registry.
 *
 * Every failure path (no engine, no model for the language, the page cannot be
 * rasterized, the engine errors, or it returns nothing usable) resolves to
 * `null`, which keeps the original `needs_ocr` page untouched: text is either
 * recognized or the page stays honestly empty.
 */
export async function recognizeImageOnlyPage(options: RecognizePageOptions): Promise<PageIR | null> {
  const { document, index, page, source } = options;
  const language = supportedOcrLanguage(document);
  const provider = language ? ocrRegistry.firstSupporting(language) : undefined;
  if (!language || !provider) {
    logger.info('OCR skipped: no model for the document language', {
      documentId: document.id,
      pageIndex: index,
      language,
    });
    return null;
  }

  const rendered = (await source.renderPage?.(index)) ?? null;
  if (!rendered) {
    logger.info('OCR skipped: the page could not be rasterized', {
      documentId: document.id,
      pageIndex: index,
    });
    return null;
  }

  let result;
  try {
    result = await ocrRegistry.recognize(
      {
        documentId: document.id,
        pageIndex: index,
        width: page.width,
        height: page.height,
        image: rendered.blob,
        scale: rendered.scale,
        language,
      },
      provider.id,
    );
  } catch (error) {
    logger.warn('OCR failed; the page keeps its image-only status', {
      documentId: document.id,
      pageIndex: index,
      code: toAppError(error, 'analysis_failed').code,
    });
    return null;
  }

  const items = linesToRawItems(result.lines ?? []);
  const visible = items.reduce((sum, item) => sum + item.text.length, 0);
  if (visible < MIN_VISIBLE_CHARS) {
    logger.info('OCR produced no usable text', {
      documentId: document.id,
      pageIndex: index,
      confidence: result.confidence,
    });
    return null;
  }

  // Same pipeline as every other page, so OCR text ends up as ordinary blocks
  // and translation units instead of a special case.
  return analyzePage(
    {
      index: page.index,
      width: page.width,
      height: page.height,
      rotation: page.rotation,
      items,
      fonts: [{ key: OCR_FONT_KEY, family: 'unknown', bold: false, italic: false }],
      images: page.images,
      links: [],
    },
    document.id,
  );
}

/** Providers report line boxes in page points; unusable boxes are dropped. */
function linesToRawItems(lines: readonly OcrLineResult[]): RawTextItem[] {
  const items: RawTextItem[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    const { bbox } = line;
    const usable =
      text !== '' &&
      Number.isFinite(bbox.x) &&
      Number.isFinite(bbox.y) &&
      bbox.width > 0 &&
      bbox.height > 0;
    if (!usable) continue;
    items.push({ text, bbox, fontSize: bbox.height, fontKey: OCR_FONT_KEY, hasEol: true });
  }
  return items;
}
