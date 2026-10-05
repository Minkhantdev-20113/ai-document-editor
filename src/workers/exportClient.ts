import { AppError } from '../core/errors/appError';
import type {
  ExportBytesResult,
  ExportCloseRequest,
  ExportFinishRequest,
  ExportFormatRequest,
  ExportFormatResult,
  ExportPaintResult,
  ExportPrepareRequest,
  ExportPrepareResult,
  ExportValidateRequest,
  ExportValidateResult,
  SessionRequest,
  SessionResult,
} from './exportProtocol';
import { WorkerRpcClient } from './rpc';

/**
 * Export worker session (Phase 5).
 *
 * Layout, shaping, page painting, PDF generation and artifact validation all
 * run in this worker, so a 500-page export never blocks the UI thread. The
 * session keeps its document between calls (idle termination disabled); the
 * caller persists `checkpoint()` bytes after every batch of pages so a crash
 * or reload resumes from page N instead of page 1.
 */
export interface ExportWorkerSession {
  prepare(request: Omit<ExportPrepareRequest, 'kind'>): Promise<ExportPrepareResult>;
  paint(index: number): Promise<number>;
  checkpoint(): Promise<ArrayBuffer>;
  finish(meta: Omit<ExportFinishRequest, 'kind'>): Promise<ArrayBuffer>;
  validate(request: Omit<ExportValidateRequest, 'kind'>): Promise<ExportValidateResult>;
  /** Renders a secondary format (no layout plan involved). */
  format(request: Omit<ExportFormatRequest, 'kind'>): Promise<ExportFormatResult>;
  close(): Promise<void>;
}

export function createExportWorkerSession(): ExportWorkerSession {
  const rpc = new WorkerRpcClient<SessionRequest, SessionResult>(
    () =>
      new Worker(new URL('./export.worker.ts', import.meta.url), {
        type: 'module',
        name: 'document-export',
      }),
    // Dense pages and a final full-document save can take a while: 5 minutes.
    { timeoutMs: 300_000, idleTerminateMs: 0 },
  );
  let closed = false;

  function ensureOpen(): void {
    if (closed) {
      throw new AppError('The export session was already closed', { code: 'worker_failed' });
    }
  }

  return {
    async prepare(request): Promise<ExportPrepareResult> {
      ensureOpen();
      return (await rpc.call('prepare', { kind: 'prepare', ...request })) as ExportPrepareResult;
    },
    async paint(index): Promise<number> {
      ensureOpen();
      const result = (await rpc.call('paint', { kind: 'paint', index })) as ExportPaintResult;
      return result.painted;
    },
    async checkpoint(): Promise<ArrayBuffer> {
      ensureOpen();
      const result = (await rpc.call('checkpoint', { kind: 'checkpoint' })) as ExportBytesResult;
      return result.bytes;
    },
    async finish(meta): Promise<ArrayBuffer> {
      ensureOpen();
      const result = (await rpc.call('finish', { kind: 'finish', ...meta })) as ExportBytesResult;
      return result.bytes;
    },
    async validate(request): Promise<ExportValidateResult> {
      ensureOpen();
      const { bytes } = request;
      // The worker consumes the bytes for its structural probe.
      return (await rpc.call(
        'validate',
        { kind: 'validate', ...request },
        [bytes],
      )) as ExportValidateResult;
    },
    async format(request): Promise<ExportFormatResult> {
      ensureOpen();
      return (await rpc.call('format', { kind: 'format', ...request })) as ExportFormatResult;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await rpc.call('close', { kind: 'close' } satisfies ExportCloseRequest).catch(() => undefined);
      rpc.dispose();
    },
  };
}
