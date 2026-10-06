import type { DocumentRecord } from '../../db/entities';
import { ocrRegistry } from '../ocrRegistry';

/**
 * OCR language selection, shared by the analysis driver and the OCR panel.
 *
 * The detected language describes what the pages actually contain, so it is
 * tried first; the user-declared source language is the fallback for
 * undetected documents. `unknown` is never a language anyone can recognize
 * text in.
 */
function candidates(
  document: Pick<DocumentRecord, 'sourceLanguage' | 'languageDetection'>,
): readonly string[] {
  const detected = document.languageDetection?.code;
  return [detected, document.sourceLanguage].filter(
    (code): code is string => Boolean(code) && code !== 'unknown',
  );
}

/** Best guess of the page's language, regardless of installed models. */
export function preferredOcrLanguage(
  document: Pick<DocumentRecord, 'sourceLanguage' | 'languageDetection'>,
): string | null {
  return candidates(document)[0] ?? null;
}

/** True when any OCR engine is registered (language-independent check). */
export function ocrEngineInstalled(): boolean {
  return ocrRegistry.available().length > 0;
}

/**
 * The first candidate language some engine actually ships a model for, or
 * null when no engine is registered / none fits this document. Null means
 * image-only pages stay `needs_ocr` - recognition is never improvised.
 */
export function supportedOcrLanguage(
  document: Pick<DocumentRecord, 'sourceLanguage' | 'languageDetection'>,
): string | null {
  for (const code of candidates(document)) {
    if (ocrRegistry.firstSupporting(code)) return code;
  }
  return null;
}
