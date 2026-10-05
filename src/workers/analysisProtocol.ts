import type { PageIR } from '../domain/analysis/ir';
import type { OpenRequest, OpenedDocumentInfo } from '../domain/analysis/source';

/**
 * Request/response contract of the analysis worker session.
 *
 * Kept separate from both the worker entry and its client so neither side
 * imports the other; `RpcRequestMessage<SessionRequest>` carries these on the
 * wire and the transfer list holds the `open` bytes.
 */
export type SessionRequest =
  | { readonly request: OpenRequest; readonly bytes: ArrayBuffer }
  | { readonly index: number }
  | { readonly marker: 'close' };

export type SessionResult = OpenedDocumentInfo | PageIR | null;
