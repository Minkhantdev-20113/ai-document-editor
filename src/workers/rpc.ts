import { AppError, type AppErrorCode } from '../core/errors/appError';
import { logger } from '../core/logging/logger';

export interface RpcRequestMessage<P> {
  readonly id: string;
  readonly type: string;
  readonly payload: P;
}

export type RpcResponseMessage<R> =
  | { readonly id: string; readonly ok: true; readonly result: R }
  | { readonly id: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface RpcClientOptions {
  readonly timeoutMs?: number;
  /** Terminate an idle worker after this long (0 disables). */
  readonly idleTerminateMs?: number;
}

interface PendingCall<R> {
  resolve: (value: R) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

let rpcSequence = 0;

/**
 * Request/response RPC over a dedicated worker.
 *
 * Every call is correlated by id, bounded by a timeout, and rejected with a
 * typed AppError. Workers are created lazily and terminated when idle so an
 * idle app holds no background threads.
 */
export class WorkerRpcClient<Payload, Result> {
  private worker: Worker | null = null;
  private readonly pending = new Map<string, PendingCall<Result>>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly factory: () => Worker,
    private readonly options: RpcClientOptions = {},
  ) {}

  get busy(): boolean {
    return this.pending.size > 0;
  }

  async call(
    type: string,
    payload: Payload,
    transfer: readonly Transferable[] = [],
  ): Promise<Result> {
    if (this.disposed) {
      throw new AppError('Worker client was disposed', { code: 'worker_failed' });
    }
    const worker = this.ensureWorker();
    const id = `rpc_${(rpcSequence += 1)}`;
    const timeoutMs = this.options.timeoutMs ?? 60_000;

    return new Promise<Result>((resolve, reject) => {
      const entry: PendingCall<Result> = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new AppError(`Worker did not respond within ${timeoutMs}ms`, {
              code: 'worker_timeout',
              retryable: true,
              details: { type },
            }),
          );
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      const message: RpcRequestMessage<Payload> = { id, type, payload };
      worker.postMessage(message, transfer as Transferable[]);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.rejectAll(new AppError('Worker client disposed', { code: 'worker_failed' }));
    this.terminate();
  }

  private ensureWorker(): Worker {
    this.clearIdleTimer();
    if (this.worker) return this.worker;
    const worker = this.factory();

    worker.onmessage = (event: MessageEvent<RpcResponseMessage<Result>>) => {
      const data = event.data;
      if (!data || typeof data.id !== 'string') return;
      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (data.ok) {
        entry.resolve(data.result);
      } else {
        entry.reject(
          new AppError(data.error.message, {
            code: normalizeWorkerCode(data.error.code),
            retryable: data.error.code !== 'validation',
            details: { source: 'worker' },
          }),
        );
      }
      this.scheduleIdleTermination();
    };

    worker.onerror = (event: ErrorEvent) => {
      logger.error('Worker runtime error', { message: event.message, filename: event.filename });
      this.rejectAll(
        new AppError(event.message || 'Worker failed to start', { code: 'worker_failed' }),
      );
      this.terminate();
    };

    this.worker = worker;
    return worker;
  }

  private scheduleIdleTermination(): void {
    const idleTerminateMs = this.options.idleTerminateMs ?? 30_000;
    if (idleTerminateMs <= 0 || this.pending.size > 0) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.terminate();
    }, idleTerminateMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private terminate(): void {
    this.clearIdleTimer();
    this.worker?.terminate();
    this.worker = null;
  }

  private rejectAll(error: AppError): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

function normalizeWorkerCode(code: string): AppErrorCode {
  return (code || 'worker_failed') as AppErrorCode;
}
