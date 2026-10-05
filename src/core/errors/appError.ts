import { deepRedact, redactSecrets } from '../utils/redact';

export const APP_ERROR_CODES = [
  'unknown',
  'validation',
  'not_found',
  'conflict',
  'db_unavailable',
  'db_operation_failed',
  'worker_failed',
  'worker_timeout',
  'file_too_large',
  'file_unreadable',
  'file_type_unsupported',
  'pdf_inspection_failed',
  'pdf_unsupported',
  'analysis_failed',
  'export_failed',
  'invalid_transition',
  'handler_missing',
  'job_timeout',
  'job_cancelled',
  'provider_unavailable',
  'provider_rate_limited',
  'provider_quota_exceeded',
  'provider_rejected',
  'provider_invalid_key',
  'provider_invalid_model',
  'provider_content_policy',
  'provider_timeout',
  'vault_locked',
  'vault_wrong_passphrase',
  'vault_failed',
  'network_offline',
  'sync_unconfigured',
  'import_invalid',
  'unsupported',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export interface AppErrorOptions {
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
  readonly code?: AppErrorCode;
}

/**
 * Application-level error.
 *
 * Construction runs every message and detail through secret redaction, so an
 * API key that leaked into a third-party error payload never survives into a
 * log line, toast, or persisted record.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  override readonly cause: unknown;

  constructor(message: string, options: AppErrorOptions = {}) {
    const safeMessage = redactSecrets(message);
    super(safeMessage);
    this.name = 'AppError';
    this.code = options.code ?? 'unknown';
    this.retryable = options.retryable ?? false;
    this.details = options.details ? (deepRedact(options.details) as Record<string, unknown>) : undefined;
    this.cause = options.cause;
    Object.setPrototypeOf(this, AppError.prototype);
  }

  toJSON(): { name: string; code: AppErrorCode; message: string; retryable: boolean; details?: Record<string, unknown> } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Normalizes anything thrown into an AppError without ever losing context. */
export function toAppError(error: unknown, fallbackCode: AppErrorCode = 'unknown'): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    return new AppError(`${error.name}: ${error.message}`, {
      code: fallbackCode,
      cause: error,
      details: { stack: error.stack ?? null },
    });
  }
  return new AppError(typeof error === 'string' ? error : 'Unknown error', {
    code: fallbackCode,
    cause: error,
  });
}


