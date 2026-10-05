/// <reference lib="webworker" />

import { AppError, toAppError } from '../core/errors/appError';
import { inspectSecondaryFormat, renderSecondaryFormat } from '../domain/export/secondaryFormats';
import type { SessionRequest, SessionResult } from './exportProtocol';
import { ExportPdfSession } from './exportPdfRenderer';
import { validateExportArtifact } from './exportPdfValidator';
import type { RpcRequestMessage, RpcResponseMessage } from './rpc';

/**
 * Export worker (Phase 5): one session, one document.
 *
 * Layout, HarfBuzz shaping, page painting, PDF generation and the
 * pre-download artifact probe all happen here; the main thread only drives
 * `prepare`/`paint`/`checkpoint`/`finish`/`validate` and stays responsive.
 * `checkpoint` serializes the pages painted so far, which is what the job
 * handler persists so a retry resumes from the failed page.
 */
const workerScope = self as unknown as DedicatedWorkerGlobalScope;

let session: ExportPdfSession | null = null;
let transfer: readonly Transferable[] = [];

workerScope.onmessage = (event: MessageEvent<RpcRequestMessage<SessionRequest> | undefined>) => {
  const data = event.data;
  if (!data || typeof data.id !== 'string') return;
  void handle(data.type, data.payload)
    .then((result) => respond({ id: data.id, ok: true, result }, transfer))
    .catch((error: unknown) => {
      const appError = toAppError(error, 'export_failed');
      respond({
        id: data.id,
        ok: false,
        error: { code: appError.code, message: appError.message },
      });
    });
};

async function handle(type: string, payload: SessionRequest): Promise<SessionResult> {
  transfer = [];
  if (!payload) {
    throw new AppError(`Export request has no payload: ${String(type)}`, { code: 'validation' });
  }

  switch (payload.kind) {
    case 'prepare': {
      // A retry re-prepares from scratch; fonts are re-fetched/cached by the
      // browser, and any previous half-rendered document is discarded.
      session = await ExportPdfSession.create(payload.fonts);
      return session.prepare(payload.document, {
        keepLayout: payload.keepLayout,
        ...(payload.resume
          ? { resume: { bytes: new Uint8Array(payload.resume.bytes), signature: payload.resume.signature } }
          : {}),
      });
    }
    case 'paint': {
      const active = requireSession();
      await active.paintPage(payload.index);
      return { painted: active.renderedPages };
    }
    case 'checkpoint': {
      const buffer = toArrayBuffer(await requireSession().checkpoint());
      transfer = [buffer];
      return { bytes: buffer };
    }
    case 'finish': {
      const buffer = toArrayBuffer(
        await requireSession().finish({
          title: payload.title,
          ...(payload.subject !== undefined ? { subject: payload.subject } : {}),
          ...(payload.keywords !== undefined ? { keywords: payload.keywords } : {}),
        }),
      );
      transfer = [buffer];
      return { bytes: buffer };
    }
    case 'validate': {
      const active = requireSession();
      const plan = active.renderPlan;
      if (!plan) {
        throw new AppError('Export validation ran before the document was prepared', {
          code: 'validation',
        });
      }
      return validateExportArtifact({
        bytes: new Uint8Array(payload.bytes),
        plan,
        targetLanguage: payload.targetLanguage,
        expectedTargetLanguage: payload.expectedTargetLanguage,
        title: payload.title,
      });
    }
    case 'close': {
      session = null;
      return null;
    }
    case 'format': {
      // Secondary formats are pure transformations of the model; they still
      // run here so a large DOCX/HTML build never blocks the UI thread.
      const bytes = await renderSecondaryFormat(payload.format, payload.document);
      const inspection = await inspectSecondaryFormat(payload.format, bytes);
      const buffer = toArrayBuffer(bytes);
      transfer = [buffer];
      return { bytes: buffer, structurallyValid: inspection.structurallyValid };
    }
  }

  throw new AppError(`Unknown export request: ${String(type)}`, { code: 'validation' });
}

function requireSession(): ExportPdfSession {
  if (!session) {
    throw new AppError('Export session has no document prepared', { code: 'validation' });
  }
  return session;
}

/** Keeps only the bytes view actually used so transfers never share a buffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

function respond(
  message: RpcResponseMessage<SessionResult>,
  transfer: readonly Transferable[] = [],
): void {
  workerScope.postMessage(message, [...transfer]);
}
