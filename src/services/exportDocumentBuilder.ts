/**
 * Translated document model (Phase 5): joins persisted analysis blocks with
 * their translation units into the {@link ExportDocumentInput} the export
 * worker lays out.
 *
 * Pure and side-effect free so it can be unit-tested with plain fixtures: the
 * service layer only fetches records, this module decides what an export
 * document actually is (page order, block order, source vs translated text).
 */
import type { DocumentBlock, DocumentPage, DocumentRecord, TranslationUnit } from '../db/entities';
import type { ExportBlockInput, ExportDocumentInput, ExportPageInput } from '../domain/export/types';

export interface ExportDocumentSources {
  readonly document: DocumentRecord;
  readonly pages: readonly DocumentPage[];
  readonly blocks: readonly DocumentBlock[];
  readonly units: readonly TranslationUnit[];
  /** Output file name override (defaults to the stored file name). */
  readonly fileName?: string;
  /** Target language override for this export (defaults to the document's). */
  readonly targetLanguage?: string;
}

export function buildExportDocument(sources: ExportDocumentSources): ExportDocumentInput {
  const unitsByBlock = new Map<string, TranslationUnit>();
  for (const unit of sources.units) unitsByBlock.set(unit.blockId, unit);

  const blocksByPage = new Map<number, DocumentBlock[]>();
  for (const block of sources.blocks) {
    const pageBlocks = blocksByPage.get(block.pageIndex);
    if (pageBlocks) pageBlocks.push(block);
    else blocksByPage.set(block.pageIndex, [block]);
  }
  for (const pageBlocks of blocksByPage.values()) {
    pageBlocks.sort((a, b) => a.orderIndex - b.orderIndex);
  }

  const pages = [...sources.pages]
    .sort((a, b) => a.pageIndex - b.pageIndex)
    .map<ExportPageInput>((page) => ({
      pageIndex: page.pageIndex,
      width: page.width,
      height: page.height,
      rotation: page.rotation,
      blocks: (blocksByPage.get(page.pageIndex) ?? []).map((block) =>
        toExportBlock(block, unitsByBlock.get(block.id)),
      ),
    }));

  const { document } = sources;
  return {
    documentId: document.id,
    projectId: document.projectId,
    title: documentTitle(document),
    fileName: sources.fileName ?? document.fileName,
    sourceLanguage: document.sourceLanguage,
    targetLanguage: sources.targetLanguage ?? document.targetLanguage,
    pages,
  };
}

/** PDF info title when the file has one, otherwise the file name. */
export function documentTitle(document: DocumentRecord): string {
  const embedded = document.metadata?.title?.trim();
  return embedded && embedded !== '' ? embedded : document.fileName;
}

function toExportBlock(block: DocumentBlock, unit: TranslationUnit | undefined): ExportBlockInput {
  return {
    blockId: block.id,
    orderIndex: block.orderIndex,
    kind: block.kind,
    bbox: block.bbox,
    font: block.font,
    alignment: block.alignment,
    headingLevel: block.headingLevel,
    listOrdered: block.listOrdered,
    table: block.table,
    link: block.link,
    flags: block.flags,
    sourceText: unit?.sourceText ?? block.text,
    translatedText: unit?.translatedText ?? null,
    unitStatus: unit?.status ?? null,
  };
}
