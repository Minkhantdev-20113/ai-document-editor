import type { ExportFontSelection } from '../domain/export/fonts';
import type { SecondaryFormat } from '../domain/export/secondaryFormats';
import type { ExportFinding } from '../domain/export/validateExport';
import type { ExportDocumentInput, ExportWarning, RenderPlanStats } from '../domain/export/types';

/**
 * Request/response contract of the export worker session (Phase 5).
 *
 * One session renders one document: `prepare` lays it out (and restores a
 * checkpoint when the plan still matches), `paint` renders the next page,
 * `checkpoint` serializes what is done so far for crash recovery, `finish`
 * writes metadata and returns the file, and `validate` re-opens the produced
 * bytes to confirm the file is really downloadable. Kept separate from both
 * the worker entry and its client so neither imports the other.
 */
export interface ExportPrepareRequest {
  readonly kind: 'prepare';
  readonly document: ExportDocumentInput;
  readonly fonts: ExportFontSelection;
  readonly keepLayout: boolean;
  /** Previous checkpoint to resume from (signature must still match). */
  readonly resume?: { readonly bytes: ArrayBuffer; readonly signature: string };
}

export interface ExportPaintRequest {
  readonly kind: 'paint';
  readonly index: number;
}

export interface ExportCheckpointRequest {
  readonly kind: 'checkpoint';
}

export interface ExportFinishRequest {
  readonly kind: 'finish';
  readonly title: string;
  readonly subject?: string;
  readonly keywords?: readonly string[];
}

export interface ExportValidateRequest {
  readonly kind: 'validate';
  readonly bytes: ArrayBuffer;
  readonly targetLanguage: string;
  readonly expectedTargetLanguage: string;
  readonly title: string;
}

export interface ExportCloseRequest {
  readonly kind: 'close';
}

/** Renders a secondary format (TXT/MD/HTML/JSON/DOCX) from the model. */
export interface ExportFormatRequest {
  readonly kind: 'format';
  readonly document: ExportDocumentInput;
  readonly format: SecondaryFormat;
}

export type SessionRequest =
  | ExportPrepareRequest
  | ExportPaintRequest
  | ExportCheckpointRequest
  | ExportFinishRequest
  | ExportValidateRequest
  | ExportFormatRequest
  | ExportCloseRequest;

export interface ExportPrepareResult {
  readonly pages: number;
  readonly warnings: readonly ExportWarning[];
  readonly stats: RenderPlanStats;
  readonly signature: string;
  /** Pages already present in the resumed document (0 = fresh start). */
  readonly resumedFrom: number;
}

export interface ExportPaintResult {
  readonly painted: number;
}

export interface ExportBytesResult {
  readonly bytes: ArrayBuffer;
}

export interface ExportFormatResult extends ExportBytesResult {
  /** Structural probe of the rendered container (bad JSON/ZIP -> false). */
  readonly structurallyValid: boolean;
}

export interface ExportValidateResult {
  readonly findings: readonly ExportFinding[];
  readonly pageCount: number;
  readonly structurallyValid: boolean;
  /** True when an `error` finding blocks the download. */
  readonly blocking: boolean;
}

export type SessionResult =
  | ExportPrepareResult
  | ExportPaintResult
  | ExportBytesResult
  | ExportFormatResult
  | ExportValidateResult
  | null;
