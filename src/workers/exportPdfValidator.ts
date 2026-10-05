/**
 * Produced-artifact validation (Phase 5): opens the finished bytes, proves the
 * container is structurally sound and contains what the plan promised, and
 * turns that plus the planner's warnings into user-facing findings.
 *
 * Nothing here ever repairs a file - the phase spec forbids silently fixing or
 * silently downloading a broken export; errors block the download instead.
 */
import {
  PDFArray,
  PDFDocument,
  PDFRawStream,
  decodePDFRawStream,
  type PDFPage,
} from 'pdf-lib';
import {
  hasBlockingFindings,
  validateExport,
  type ExportFinding,
} from '../domain/export/validateExport';
import type { RenderPlan } from '../domain/export/types';

export interface PdfInspection {
  /** False when the header/probe failed or the file would not open. */
  readonly structurallyValid: boolean;
  readonly pageCount: number;
  /** Produced page indexes that draw no text at all. */
  readonly blankPages: readonly number[];
}

export interface ExportArtifactValidation {
  readonly findings: readonly ExportFinding[];
  readonly pageCount: number;
  readonly structurallyValid: boolean;
  readonly blocking: boolean;
}

/** Cheap structural probe: header first, then a real parse. */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  const header = new TextDecoder().decode(bytes.subarray(0, 5));
  if (header !== '%PDF-') {
    return { structurallyValid: false, pageCount: 0, blankPages: [] };
  }
  try {
    const doc = await PDFDocument.load(bytes);
    const blankPages: number[] = [];
    const pageCount = doc.getPageCount();
    for (let index = 0; index < pageCount; index += 1) {
      if (!pageDrawsText(doc, doc.getPage(index))) blankPages.push(index);
    }
    return { structurallyValid: true, pageCount, blankPages };
  } catch {
    return { structurallyValid: false, pageCount: 0, blankPages: [] };
  }
}

/**
 * Runs the pre-download checks against the finished file: plan findings
 * (missing translations, overflow, untranslated blocks, language/title) plus
 * what the produced container actually contains.
 */
export async function validateExportArtifact(input: {
  readonly bytes: Uint8Array;
  readonly plan: RenderPlan;
  readonly targetLanguage: string;
  readonly expectedTargetLanguage: string;
  readonly title: string;
}): Promise<ExportArtifactValidation> {
  const inspection = await inspectPdf(input.bytes);
  // Report blank produced pages in source-page coordinates like every other
  // finding (continuation pages map back to the page that overflowed).
  const blankPages = inspection.blankPages.map(
    (index) => input.plan.pages[index]?.sourcePageIndex ?? index,
  );
  const findings = validateExport({
    plan: input.plan,
    targetLanguage: input.targetLanguage,
    expectedTargetLanguage: input.expectedTargetLanguage,
    title: input.title,
    artifact: {
      pageCount: inspection.pageCount,
      structurallyValid: inspection.structurallyValid,
      blankPages,
    },
  });
  return {
    findings,
    pageCount: inspection.pageCount,
    structurallyValid: inspection.structurallyValid,
    blocking: hasBlockingFindings(findings),
  };
}

/** True when any content stream of this page shows text. */
function pageDrawsText(doc: PDFDocument, page: PDFPage): boolean {
  const contents = page.node.Contents();
  if (!contents) return false;
  const objects =
    contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, index) => contents.get(index))
      : [contents];

  for (const object of objects) {
    const stream = doc.context.lookup(object);
    if (!(stream instanceof PDFRawStream)) continue;
    const text = new TextDecoder().decode(decodePDFRawStream(stream).decode());
    if (text.includes('Tj') || text.includes('TJ')) return true;
  }
  return false;
}
