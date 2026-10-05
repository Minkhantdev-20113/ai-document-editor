import { LIMITS } from '../../config/appConfig';
import { deepRedact, redactSecrets } from '../utils/redact';
import { newId } from '../utils/id';
import { isAppError, toAppError } from '../errors/appError';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  readonly id: string;
  readonly ts: number;
  readonly level: LogLevel;
  readonly scope: string;
  readonly message: string;
  readonly context: Record<string, unknown> | undefined;
  readonly code: string | undefined;
}

export interface Logger {
  readonly scope: string;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  errorWith(error: unknown, message?: string, context?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

type LogSink = (record: LogRecord) => void;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: LogLevel = import.meta.env.DEV ? 'debug' : 'info';

const buffer: LogRecord[] = [];
const listeners = new Set<(record: LogRecord) => void>();
const sinks = new Set<LogSink>();

/**
 * Centralized logging.
 * - Every message/context is redacted before it is stored anywhere.
 * - A ring buffer keeps recent records for the in-app diagnostics view.
 * - Optional sinks (IndexedDB) receive warn/error records for persistence.
 */
function write(level: LogLevel, scope: string, message: string, context?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL] && !import.meta.env.DEV) return;

  const record: LogRecord = {
    id: newId('log'),
    ts: Date.now(),
    level,
    scope,
    message: redactSecrets(message),
    context: context ? (deepRedact(context) as Record<string, unknown>) : undefined,
    code: undefined,
  };

  buffer.push(record);
  if (buffer.length > LIMITS.logBufferSize) buffer.splice(0, buffer.length - LIMITS.logBufferSize);

  emitToConsole(record);
  for (const listener of listeners) listener(record);
  if (level === 'warn' || level === 'error') {
    for (const sink of sinks) {
      try {
        sink(record);
      } catch {
        /* a failing sink must never break the app */
      }
    }
  }
}

function emitToConsole(record: LogRecord): void {
  const prefix = `[${record.scope}]`;
  const payload = record.context ?? {};
  switch (record.level) {
    case 'debug':
      console.debug(prefix, record.message, payload);
      break;
    case 'info':
      console.info(prefix, record.message, payload);
      break;
    case 'warn':
      console.warn(prefix, record.message, payload);
      break;
    case 'error':
      console.error(prefix, record.message, payload);
      break;
  }
}

export const logger: Logger = createLogger('app');

function createLogger(scope: string): Logger {
  return {
    scope,
    debug: (message, context) => write('debug', scope, message, context),
    info: (message, context) => write('info', scope, message, context),
    warn: (message, context) => write('warn', scope, message, context),
    error: (message, context) => write('error', scope, message, context),
    errorWith: (error, message, context) => {
      const appError = toAppError(error);
      write('error', scope, message ?? appError.message, {
        ...(context ?? {}),
        code: appError.code,
        cause: isAppError(appError.cause) ? appError.cause.message : String(appError.cause ?? ''),
        stack: (appError.stack ?? '').split('\n').slice(0, 6).join('\n'),
      });
    },
    child: (childScope) => createLogger(childScope ? `${scope}:${childScope}` : scope),
  };
}

export function subscribeToLogs(listener: (record: LogRecord) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRecentLogs(limit = LIMITS.logBufferSize): readonly LogRecord[] {
  return buffer.slice(-limit);
}

export function registerLogSink(sink: LogSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

export function clearLogBuffer(): void {
  buffer.length = 0;
}
