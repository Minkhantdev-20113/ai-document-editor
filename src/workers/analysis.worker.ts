/// <reference lib="webworker" />

import * as pdfjsLib from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker&inline';
import { AppError, toAppError } from '../core/errors/appError';
import type { AnalysisSource } from '../domain/analysis/source';
import { createLocalAnalysisSource } from './analysisSession';
import type { SessionRequest, SessionResult } from './analysisProtocol';
import type { RpcRequestMessage, RpcResponseMessage } from './rpc';

/**
 * Document analysis worker.
 *
 * One session per worker: `open` parses the document, `page` runs extraction +
 * the analysis pipeline for one page, `close` releases pdf.js. Keeping the
 * document open across pages avoids re-parsing a 500-page PDF for every page
 * and lets the queue fan out two sessions (queue concurrency) without shared
 * state. Results are plain structured-clone data (no secrets, no objects).
 */

// pdf.js needs its own worker; `inline` keeps the blob URL self-contained so
// the nested worker also works when the app is served from cache/offline.
try {
  pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();
} catch (error) {
  console.warn('[analysis] pdf.js worker port unavailable, falling back', error);
}

const source: AnalysisSource = createLocalAnalysisSource(pdfjsLib);
const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<RpcRequestMessage<SessionRequest> | undefined>) => {
  const data = event.data;
  if (!data || typeof data.id !== 'string') return;
  void handle(data.type, data.payload)
    .then((result) => respond({ id: data.id, ok: true, result }))
    .catch((error: unknown) => {
      const appError = toAppError(error, 'analysis_failed');
      respond({
        id: data.id,
        ok: false,
        error: { code: appError.code, message: appError.message },
      });
    });
};

async function handle(type: string, payload: SessionRequest): Promise<SessionResult> {
  if (type === 'open' && payload && 'bytes' in payload) {
    return source.open(payload.bytes, payload.request);
  }
  if (type === 'page' && payload && 'index' in payload) {
    return source.page(payload.index);
  }
  if (type === 'close') {
    await source.close();
    return null;
  }
  throw new AppError(`Unknown analysis request: ${String(type)}`, { code: 'validation' });
}

function respond(message: RpcResponseMessage<SessionResult>): void {
  workerScope.postMessage(message);
}
