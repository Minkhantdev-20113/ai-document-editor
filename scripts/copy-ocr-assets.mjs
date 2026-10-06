/**
 * Copies the on-device OCR runtime into `public/` before dev/build.
 *
 * Tesseract needs three kinds of file at runtime, all served from this app's
 * own origin so no CDN is contacted:
 *
 *   public/tess/worker.min.js                 Tesseract's worker glue
 *   public/tess/tesseract-core-lstm.wasm.js   single-file core (wasm embedded,
 *                                             so no relative .wasm fetch)
 *   public/tessdata/<lang>.traineddata.gz     language models (LSTM best_int)
 *
 * Everything comes from node_modules, so nothing binary is committed and the
 * versions always match the installed `tesseract.js` / data packages. The
 * output directory is git-ignored; this script recreates it from scratch.
 *
 * Skips quietly when no language data package is installed, so a checkout
 * without the optional devDependencies still builds (OCR then stays off).
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = path.join(root, 'node_modules');
const tessDir = path.join(root, 'public', 'tess');
const dataDir = path.join(root, 'public', 'tessdata');

const workerFile = path.join(modules, 'tesseract.js', 'dist', 'worker.min.js');
const coreFile = path.join(modules, 'tesseract.js-core', 'tesseract-core-lstm.wasm.js');
/** App language -> @tesseract.js-data package; must match tesseractOcr.ts. */
const LANGUAGES = ['eng', 'mya'];

async function copyInto(targetDir, source, name) {
  await mkdir(targetDir, { recursive: true });
  await cp(source, path.join(targetDir, name));
}

async function main() {
  if (!existsSync(workerFile) || !existsSync(coreFile)) {
    console.warn('[ocr-assets] tesseract.js is not installed - skipping OCR assets');
    return;
  }

  await rm(tessDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });

  await copyInto(tessDir, workerFile, 'worker.min.js');
  await copyInto(tessDir, coreFile, 'tesseract-core-lstm.wasm.js');

  let languages = 0;
  for (const language of LANGUAGES) {
    const source = path.join(modules, '@tesseract.js-data', language, '4.0.0_best_int', `${language}.traineddata.gz`);
    if (!existsSync(source)) {
      console.warn(`[ocr-assets] no traineddata for ${language} - skipping it`);
      continue;
    }
    await copyInto(dataDir, source, `${language}.traineddata.gz`);
    languages += 1;
  }

  console.log(`[ocr-assets] worker + core and ${languages} language model(s) copied into public/`);
}

main().catch((error) => {
  console.error('[ocr-assets] failed:', error);
  process.exitCode = 1;
});
