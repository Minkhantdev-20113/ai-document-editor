import { AppError } from '../core/errors/appError';
import type { PageIR } from '../domain/analysis/ir';
import type { AnalysisSource, OpenedDocumentInfo, PageRenderResult } from '../domain/analysis/source';
import type { SessionRequest, SessionResult } from './analysisProtocol';
import { WorkerRpcClient } from './rpc';

/**
 * `AnalysisSource` backed by a dedicated Web Worker.
 *
 * Sessions own their worker: idle termination is disabled because an idle gap
 * between two pages must not drop the open document, and disposal happens in
 * `close()`. Heavy parsing (pdf.js), line grouping and classification all run
 * off the main thread, so the UI never freezes on a large PDF.
 */
export function createWorkerAnalysisSession(): AnalysisSource {
  const rpc = new WorkerRpcClient<SessionRequest, SessionResult>(
    () =>
      new Worker(new URL('./analysis.worker.ts', import.meta.url), {
        type: 'module',
        name: 'document-analysis',
      }),
    // Page extraction of a dense scanned page can take a while; 5 minutes.
    { timeoutMs: 300_000, idleTerminateMs: 0 },
  );
  let closed = false;

  function ensureOpen(): void {
    if (closed) {
      throw new AppError('The analysis session was already closed', { code: 'worker_failed' });
    }
  }

  return {
    async open(bytes, request): Promise<OpenedDocumentInfo> {
      ensureOpen();
      if (bytes.byteLength === 0) {
        throw new AppError('The document is empty', { code: 'file_unreadable' });
      }
      return (await rpc.call('open', { request, bytes }, [bytes])) as OpenedDocumentInfo;
    },
    async page(index): Promise<PageIR> {
      ensureOpen();
      return (await rpc.call('page', { index })) as PageIR;
    },
    async renderPage(index): Promise<PageRenderResult | null> {
      ensureOpen();
      return (await rpc.call('page', { index, render: true })) as PageRenderResult | null;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // Best effort: the worker is disposed either way.
      await rpc.call('close', { marker: 'close' }).catch(() => undefined);
      rpc.dispose();
    },
  };
}
