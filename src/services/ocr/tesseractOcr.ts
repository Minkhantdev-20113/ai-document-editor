import Tesseract from 'tesseract.js';
import { AppError } from '../../core/errors/appError';
import { logger } from '../../core/logging/logger';
import type { Block } from 'tesseract.js';
import type { OcrLineResult, OcrPageInput, OcrPageResult, OcrProvider } from '../ocrRegistry';

type TesseractWorker = Awaited<ReturnType<typeof Tesseract.createWorker>>;

/**
 * Built-in OCR engine (Tesseract, runs in its own worker on this device).
 *
 * Everything it needs is served from the app's own origin: `public/tess/`
 * (worker + core) and `public/tessdata/` (language models) are copied there
 * from node_modules by `scripts/copy-ocr-assets.mjs` before dev/build, so no
 * third-party CDN is contacted at runtime. The core build is the single-file
 * variant, which keeps the wasm embedded in the script - that matters because
 * Tesseract's worker is created from a blob URL, where relative wasm paths
 * would not resolve.
 *
 * Only languages listed below ship a traineddata file; anything else is
 * refused by the registry instead of being read with the wrong model.
 */
const MODEL_BY_LANGUAGE: Readonly<Record<string, string>> = {
  en: 'eng',
  my: 'mya',
};

const LANGUAGE_CODES: readonly string[] = Object.keys(MODEL_BY_LANGUAGE);

interface WorkerEntry {
  readonly worker: TesseractWorker;
  readonly model: string;
}

let current: WorkerEntry | null = null;
let opening: Promise<WorkerEntry> | null = null;

/** Absolute URL for a file copied into `public/` (works under a base path too). */
function assetUrl(path: string): string {
  return new URL(`${import.meta.env.BASE_URL}${path}`, window.location.origin).href;
}

function modelFor(language: string): string {
  const model = MODEL_BY_LANGUAGE[language];
  if (!model) {
    throw new AppError(`No OCR model ships for "${language}"`, {
      code: 'unsupported',
      retryable: false,
    });
  }
  return model;
}

async function openWorker(model: string): Promise<WorkerEntry> {
  if (current) {
    const previous = current;
    current = null;
    await previous.worker.terminate().catch(() => undefined);
  }
  const worker = await Tesseract.createWorker(model, Tesseract.OEM.LSTM_ONLY, {
    workerPath: assetUrl('tess/worker.min.js'),
    corePath: assetUrl('tess/tesseract-core-lstm.wasm.js'),
    langPath: assetUrl('tessdata'),
    // Tesseract reports worker-level failures through this hook; swallowing
    // them here keeps a failed OCR run inside the analysis driver's own
    // catch, which leaves the page as `needs_ocr` instead of crashing.
    errorHandler: (error: unknown) => logger.warn('Tesseract worker error', { error: String(error) }),
  });
  return { worker, model };
}

/** One live worker per session; switching models terminates the previous one. */
function ensureWorker(language: string): Promise<WorkerEntry> {
  const model = modelFor(language);
  if (current?.model === model) return Promise.resolve(current);
  if (opening) {
    return opening.then((entry) => (entry.model === model ? entry : openWorker(model)));
  }
  opening = openWorker(model).finally(() => {
    opening = null;
  });
  return opening;
}

/** Tesseract reports line boxes in image pixels; the IR works in points. */
function linesOf(blocks: readonly Block[] | null, scale: number): OcrLineResult[] {
  const divisor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const lines: OcrLineResult[] = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const text = typeof line.text === 'string' ? line.text.trim() : '';
        const box = line.bbox;
        if (text === '' || !box) continue;
        const x0 = Number(box.x0);
        const y0 = Number(box.y0);
        const x1 = Number(box.x1);
        const y1 = Number(box.y1);
        if (![x0, y0, x1, y1].every((value) => Number.isFinite(value))) continue;
        const width = (x1 - x0) / divisor;
        const height = (y1 - y0) / divisor;
        if (!(width > 0) || !(height > 0)) continue;
        lines.push({ text, bbox: { x: x0 / divisor, y: y0 / divisor, width, height } });
      }
    }
  }
  return lines;
}

async function recognize(input: OcrPageInput): Promise<OcrPageResult> {
  if (!input.image) {
    throw new AppError('OCR needs a rendered image of the page', {
      code: 'unsupported',
      retryable: false,
    });
  }
  const { worker } = await ensureWorker(input.language);
  const { data } = await worker.recognize(input.image, {}, { text: true, blocks: true });
  const lines = linesOf(data.blocks, input.scale);
  const text = data.text !== '' ? data.text : lines.map((line) => line.text).join('\n');
  const confidence = Number.isFinite(data.confidence)
    ? Math.min(1, Math.max(0, data.confidence / 100))
    : 0;
  return { text, confidence, lines };
}

export const tesseractOcrProvider: OcrProvider = {
  id: 'tesseract',
  label: 'Tesseract (on-device)',
  languages: LANGUAGE_CODES,
  recognize,
};
