import { AppError, isAppError } from '../core/errors/appError';
import type { DocumentMetadata, PageIR } from '../domain/analysis/ir';
import { analyzePage } from '../domain/analysis/pipeline';
import type { AnalysisSource, OpenRequest, OpenedDocumentInfo } from '../domain/analysis/source';
import { parseDocx } from '../domain/analysis/docx';
import {
  buildTextPages,
  detectTextFormat,
  parseTextDocument,
} from '../domain/analysis/textFormats';
import { extractPdfPage, openPdf, type OpenedPdf, type PdfjsModule } from './pdfExtract';

/**
 * Analysis session core.
 *
 * Implements the `AnalysisSource` contract in-process: PDF pages stream through
 * pdf.js extraction + the pure pipeline, while TXT/Markdown/HTML/DOCX are
 * parsed once at `open` and paginated into the very same IR shape. The Web
 * Worker (`analysis.worker.ts`) is a thin RPC wrapper around this file, so
 * worker results and test results come from one code path.
 */

type SessionState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'pdf'; readonly pdf: OpenedPdf; readonly documentId: string }
  | { readonly kind: 'text'; readonly pages: readonly PageIR[]; readonly documentId: string };

/** Text documents are decoded eagerly; above this the string itself is a risk. */
const MAX_TEXT_BYTES = 64 * 1024 * 1024;

export function createLocalAnalysisSource(ns: PdfjsModule): AnalysisSource {
  let state: SessionState = { kind: 'empty' };

  async function open(bytes: ArrayBuffer, request: OpenRequest): Promise<OpenedDocumentInfo> {
    await close();
    if (bytes.byteLength === 0) {
      throw new AppError('The document is empty', { code: 'file_unreadable' });
    }

    const extension = fileExtension(request.fileName);
    try {
      if (extension === 'pdf' || startsWithPdfMagic(bytes)) {
        const pdf = await openPdf(ns, bytes);
        state = { kind: 'pdf', pdf, documentId: request.documentId };
        return {
          pageCount: pdf.pageCount,
          metadata: pdf.metadata,
          title: pdf.metadata?.title ?? null,
        };
      }

      const parsed =
        extension === 'docx'
          ? await parseDocx(new Uint8Array(bytes))
          : parseTextDocument(decodeText(bytes, request.fileName), detectTextFormat(request.fileName));
      const pages = buildTextPages(parsed, request.documentId);
      state = { kind: 'text', pages, documentId: request.documentId };
      const metadata: DocumentMetadata = {
        title: parsed.title,
        author: null,
        subject: null,
        producer: null,
        creator: null,
        creationDate: null,
        format: extension === '' ? 'text' : extension,
      };
      return { pageCount: pages.length, metadata, title: parsed.title };
    } catch (error) {
      state = { kind: 'empty' };
      throw openError(error, request.fileName);
    }
  }

  async function page(index: number): Promise<PageIR> {
    const current = state;
    if (current.kind === 'empty') {
      throw new AppError('No document is open', { code: 'validation' });
    }
    if (!Number.isInteger(index) || index < 0) {
      throw new AppError(`Invalid page index ${index}`, { code: 'validation' });
    }

    if (current.kind === 'text') {
      const result = current.pages[index];
      if (!result) throw pageRangeError(index, current.pages.length);
      return result;
    }

    if (index >= current.pdf.pageCount) {
      throw pageRangeError(index, current.pdf.pageCount);
    }
    try {
      const raw = await extractPdfPage(ns, current.pdf.doc, index);
      return analyzePage(raw, current.documentId);
    } catch (error) {
      if (isAppError(error)) throw error;
      // Retryable: the driver retries a page in isolation and finally marks it
      // failed without stopping the rest of the document.
      throw new AppError(`Page ${index + 1} could not be analyzed`, {
        code: 'analysis_failed',
        retryable: true,
        cause: error,
      });
    }
  }

  async function close(): Promise<void> {
    const current = state;
    state = { kind: 'empty' };
    if (current.kind === 'pdf') await current.pdf.dispose().catch(() => undefined);
  }

  return { open, page, close };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

function startsWithPdfMagic(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 4) return false;
  const head = new Uint8Array(bytes, 0, 4);
  return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46; // %PDF
}

function decodeText(bytes: ArrayBuffer, fileName: string): string {
  if (bytes.byteLength > MAX_TEXT_BYTES) {
    throw new AppError(`${fileName} is larger than the ${MAX_TEXT_BYTES / (1024 * 1024)}MB text limit`, {
      code: 'file_too_large',
    });
  }
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}

function openError(error: unknown, fileName: string): AppError {
  if (isAppError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AppError(`Could not open ${fileName}: ${message}`, {
    code: 'file_unreadable',
    cause: error,
  });
}

function pageRangeError(index: number, pageCount: number): AppError {
  return new AppError(`Page ${index + 1} of ${pageCount} does not exist`, {
    code: 'not_found',
    retryable: false,
  });
}
