/**
 * Pre-download export validation (Phase 5).
 *
 * The rule from the spec: never silently download a broken file. Findings
 * are surfaced to the user - nothing is ever auto-fixed - and `error`
 * findings block the download until the user resolves or explicitly accepts.
 */
import type { ExportPageInput, ExportWarningCode, RenderPlan } from './types';

export type ExportCheckCode =
  | ExportWarningCode
  | 'no_pages'
  | 'empty_page'
  | 'missing_text'
  | 'page_count_mismatch'
  | 'pdf_structure'
  | 'container_corrupt'
  | 'language_mismatch'
  | 'title_missing';

export type ExportFindingSeverity = 'error' | 'warning';

export interface ExportFinding {
  readonly code: ExportCheckCode;
  readonly severity: ExportFindingSeverity;
  readonly pageIndex?: number;
  readonly blockId?: string;
  readonly detail?: string;
}

export interface ExportArtifactInfo {
  /** Pages actually present in the produced file. */
  readonly pageCount: number;
  /** False when the container failed a structural probe (e.g. `%PDF-` header). */
  readonly structurallyValid: boolean;
  /** Source pages whose produced page draws no text at all. */
  readonly blankPages?: readonly number[];
}

export interface ExportValidationInput {
  readonly plan: RenderPlan;
  /** Target language stored on the document being exported. */
  readonly targetLanguage: string;
  /** Target language the user selected for this export. */
  readonly expectedTargetLanguage: string;
  /** Document/project title written into the file metadata. */
  readonly title: string;
  /** Produced artifact (omit while the plan is still being validated). */
  readonly artifact?: ExportArtifactInfo | null;
}

function finding(
  code: ExportCheckCode,
  severity: ExportFindingSeverity,
  extra: { pageIndex?: number; blockId?: string; detail?: string } = {},
): ExportFinding {
  return { code, severity, ...extra };
}

/** Maps a planning warning onto a user-facing finding. */
function fromWarning(warning: {
  code: ExportWarningCode;
  pageIndex?: number;
  blockId?: string;
  detail?: string;
}): ExportFinding {
  return finding(warning.code, 'warning', {
    ...(warning.pageIndex !== undefined ? { pageIndex: warning.pageIndex } : {}),
    ...(warning.blockId ? { blockId: warning.blockId } : {}),
    ...(warning.detail ? { detail: warning.detail } : {}),
  });
}

export function validateExport(input: ExportValidationInput): ExportFinding[] {
  const findings: ExportFinding[] = [];
  const { plan } = input;

  if (plan.pages.length === 0) {
    findings.push(finding('no_pages', 'error', { detail: 'the document produced no pages' }));
  }

  if (input.artifact && !input.artifact.structurallyValid) {
    findings.push(finding('pdf_structure', 'error', { detail: 'the generated file failed its structure check' }));
  }

  if (input.artifact && input.artifact.pageCount !== plan.pages.length) {
    findings.push(
      finding('page_count_mismatch', 'error', {
        detail: `expected ${plan.pages.length} pages, file has ${input.artifact.pageCount}`,
      }),
    );
  }

  for (const pageIndex of input.artifact?.blankPages ?? []) {
    findings.push(
      finding('empty_page', 'warning', {
        pageIndex,
        detail: `page ${pageIndex + 1} renders no text in the produced file`,
      }),
    );
  }

  if (input.targetLanguage !== input.expectedTargetLanguage) {
    findings.push(
      finding('language_mismatch', 'error', {
        detail: `document is ${input.targetLanguage}, export was prepared for ${input.expectedTargetLanguage}`,
      }),
    );
  }

  if (input.title.trim() === '') {
    findings.push(finding('title_missing', 'warning', { detail: 'no document title for the file metadata' }));
  }

  for (const page of plan.pages) {
    if (page.blocks.length === 0) {
      findings.push(
        finding('empty_page', 'warning', {
          pageIndex: page.sourcePageIndex,
          detail: `page ${page.sourcePageIndex + 1} has no content`,
        }),
      );
    }
    for (const block of page.blocks) {
      if (block.type === 'text' && block.lines.length === 0) {
        findings.push(
          finding('missing_text', 'error', {
            pageIndex: page.sourcePageIndex,
            blockId: block.blockId,
            detail: 'block produced no text',
          }),
        );
      }
    }
  }

  for (const warning of plan.warnings) {
    findings.push(fromWarning(warning));
  }

  return findings;
}

export function hasBlockingFindings(findings: readonly ExportFinding[]): boolean {
  return findings.some((item) => item.severity === 'error');
}

/* -------------------------------------------------- secondary formats -- */

export interface SecondaryArtifactInfo {
  /** Bytes actually produced (`0` means nothing was written). */
  readonly byteLength: number;
  /** False when the container failed its structural probe (bad JSON/ZIP, ...). */
  readonly structurallyValid: boolean;
}

export interface SecondaryValidationInput {
  /** Target language stored on the document being exported. */
  readonly targetLanguage: string;
  /** Target language the user selected for this export. */
  readonly expectedTargetLanguage: string;
  readonly title: string;
  /** Pages/blocks of the translated model the artifact was built from. */
  readonly pages: readonly ExportPageInput[];
  readonly artifact: SecondaryArtifactInfo;
}

/**
 * Pre-download checks for TXT/Markdown/HTML/JSON/DOCX artifacts: same rules
 * as the PDF path (structure, content, language, title, untranslated blocks)
 * but page geometry probes are replaced by the container probe.
 */
export function validateSecondaryArtifact(input: SecondaryValidationInput): ExportFinding[] {
  const findings: ExportFinding[] = [];

  if (input.artifact.byteLength === 0) {
    findings.push(finding('missing_text', 'error', { detail: 'the produced file is empty' }));
  }
  if (!input.artifact.structurallyValid) {
    findings.push(
      finding('container_corrupt', 'error', {
        detail: 'the produced file failed its structure check',
      }),
    );
  }
  if (input.pages.length === 0) {
    findings.push(finding('no_pages', 'error', { detail: 'the document produced no pages' }));
  }
  if (input.targetLanguage !== input.expectedTargetLanguage) {
    findings.push(
      finding('language_mismatch', 'error', {
        detail: `document is ${input.targetLanguage}, export was prepared for ${input.expectedTargetLanguage}`,
      }),
    );
  }
  if (input.title.trim() === '') {
    findings.push(finding('title_missing', 'warning', { detail: 'no document title for the file metadata' }));
  }

  for (const page of input.pages) {
    if (page.blocks.length === 0) {
      findings.push(
        finding('empty_page', 'warning', {
          pageIndex: page.pageIndex,
          detail: `page ${page.pageIndex + 1} has no content`,
        }),
      );
    }
    for (const block of page.blocks) {
      if (block.translatedText === null) {
        findings.push(
          finding('missing_translation', 'warning', {
            pageIndex: page.pageIndex,
            blockId: block.blockId,
            detail: 'no translation yet; the source text was used',
          }),
        );
      }
    }
  }

  return findings;
}

/** Findings grouped by code for compact UI counters. */
export function summarizeFindings(
  findings: readonly ExportFinding[],
): Readonly<Partial<Record<ExportCheckCode, number>>> {
  const counts: Partial<Record<ExportCheckCode, number>> = {};
  for (const item of findings) {
    counts[item.code] = (counts[item.code] ?? 0) + 1;
  }
  return counts;
}
