/**
 * Secondary export formats (Phase 5): TXT, Markdown, HTML, JSON (restorable)
 * and DOCX.
 *
 * All of them walk the same translated document model the PDF pipeline uses,
 * so headings, lists, tables, links, alignment and page order survive; they
 * are produced in the export worker (never on the UI thread) and never at the
 * cost of PDF quality - PDF stays the primary, structure-preserving format.
 */
import { readZipEntries } from '../../core/utils/zip';
import type { BlockAlignment } from '../analysis/ir';
import { renderDocx } from './docx';
import type { ExportBlockInput, ExportDocumentInput, ExportPageInput } from './types';

export type SecondaryFormat = 'docx' | 'html' | 'json' | 'md' | 'txt';

export interface SecondaryInspection {
  /** False when the container would not open (bad JSON, broken ZIP, ...). */
  readonly structurallyValid: boolean;
  readonly byteLength: number;
}

/** Translated text when present, source otherwise (same fallback as PDF). */
export function blockText(block: ExportBlockInput): string {
  return block.translatedText ?? block.sourceText;
}

function headingLevel(block: ExportBlockInput): number | null {
  const level = block.headingLevel;
  return typeof level === 'number' && level >= 1 ? Math.min(6, level) : null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeMarkdownCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Renders one secondary format to bytes (encoding is uniform across formats). */
export async function renderSecondaryFormat(
  format: SecondaryFormat,
  document: ExportDocumentInput,
): Promise<Uint8Array> {
  if (format === 'docx') return renderDocx(document);
  const text =
    format === 'txt'
      ? renderPlainText(document)
      : format === 'md'
        ? renderMarkdown(document)
        : format === 'html'
          ? renderHtml(document)
          : JSON.stringify(serializeDocument(document), null, 2);
  return new TextEncoder().encode(text);
}

/** Cheap structural probe run before an artifact may be offered for download. */
export async function inspectSecondaryFormat(
  format: SecondaryFormat,
  bytes: Uint8Array,
): Promise<SecondaryInspection> {
  const byteLength = bytes.byteLength;
  if (byteLength === 0) return { structurallyValid: false, byteLength };

  try {
    const text = new TextDecoder().decode(bytes);
    if (format === 'json') {
      JSON.parse(text);
      return { structurallyValid: true, byteLength };
    }
    if (format === 'html') {
      return { structurallyValid: text.includes('<html') && text.includes('</html>'), byteLength };
    }
    if (format === 'docx') {
      const entries = await readZipEntries(bytes);
      return {
        structurallyValid: entries.has('[Content_Types].xml') && entries.has('word/document.xml'),
        byteLength,
      };
    }
    return { structurallyValid: true, byteLength };
  } catch {
    return { structurallyValid: false, byteLength };
  }
}

/** Plain text: headings underlined, lists numbered, tables as delimited rows. */
export function renderPlainText(document: ExportDocumentInput): string {
  const out: string[] = [document.title, `${document.sourceLanguage} -> ${document.targetLanguage}`, ''];
  let ordered = 0;

  document.pages.forEach((page, pageIndex) => {
    if (pageIndex > 0) out.push('\f', '');
    for (const block of page.blocks) {
      const text = blockText(block);
      const heading = headingLevel(block);

      if (heading !== null) {
        const rule = heading <= 2 ? '=' : '-';
        out.push(text, rule.repeat(Math.min(60, Math.max(3, text.length))), '');
        ordered = 0;
        continue;
      }
      if (block.table) {
        out.push(renderTextTable(block.table), '');
        ordered = 0;
        continue;
      }
      if (block.listOrdered === true) {
        ordered += 1;
        out.push(`${ordered}. ${text}`);
        continue;
      }
      if (block.listOrdered === false) {
        ordered = 0;
        out.push(`\u2022 ${text}`);
        continue;
      }
      ordered = 0;
      out.push(block.link && !text.includes(block.link) ? `${text} <${block.link}>` : text, '');
    }
  });

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** Markdown: ATX headings, GFM tables, real links, `---` page separators. */
export function renderMarkdown(document: ExportDocumentInput): string {
  const out: string[] = [`# ${document.title}`, '', `${document.sourceLanguage} -> ${document.targetLanguage}`, ''];
  let ordered = 0;

  document.pages.forEach((page, pageIndex) => {
    if (pageIndex > 0) out.push('', '---', '');
    for (const block of page.blocks) {
      const text = blockText(block);
      const heading = headingLevel(block);

      if (heading !== null) {
        out.push(`${'#'.repeat(heading)} ${text}`, '');
        ordered = 0;
        continue;
      }
      if (block.table) {
        out.push(renderMarkdownTable(block), '');
        ordered = 0;
        continue;
      }
      const linked = block.link ? `[${text}](${block.link})` : text;
      if (block.listOrdered === true) {
        ordered += 1;
        out.push(`${ordered}. ${linked}`);
        continue;
      }
      if (block.listOrdered === false) {
        ordered = 0;
        out.push(`- ${linked}`);
        continue;
      }
      ordered = 0;
      out.push(linked, '');
    }
  });

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** Full HTML document: semantic elements, page separators, target-language lang. */
export function renderHtml(document: ExportDocumentInput): string {
  const title = escapeHtml(document.title);
  const language = escapeHtml(document.targetLanguage);
  const out: string[] = [
    '<!DOCTYPE html>',
    `<html lang="${language}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="dc.language" content="${language}">`,
    '<meta name="generator" content="AI Document Translator">',
    `<title>${title}</title>`,
    '<style>',
    'body { font-family: "Times New Roman", "Padauk", serif; line-height: 1.5; margin: 2rem; }',
    'table { border-collapse: collapse; margin: 0.75rem 0; }',
    'td, th { border: 1px solid #888; padding: 4px 8px; vertical-align: top; }',
    'hr.page { border: none; border-top: 1px dashed #999; margin: 2rem 0; }',
    '</style>',
    '</head>',
    '<body>',
  ];
  let openList: 'ul' | 'ol' | null = null;
  const closeList = (): void => {
    if (openList) {
      out.push(`</${openList}>`);
      openList = null;
    }
  };

  document.pages.forEach((page, pageIndex) => {
    if (pageIndex > 0) out.push('<hr class="page">');
    for (const block of page.blocks) {
      const text = escapeHtml(blockText(block));
      const heading = headingLevel(block);

      if (block.listOrdered === null) closeList();

      if (heading !== null) {
        out.push(`<h${heading} id="page${pageIndex}_b${escapeHtml(block.blockId)}">${text}</h${heading}>`);
        continue;
      }
      if (block.table) {
        out.push(renderHtmlTable(block.table));
        continue;
      }
      if (block.listOrdered !== null) {
        const tag: 'ul' | 'ol' = block.listOrdered ? 'ol' : 'ul';
        if (openList !== tag) {
          closeList();
          out.push(`<${tag}>`);
          openList = tag;
        }
        const content = block.link ? `<a href="${escapeHtml(block.link)}">${text}</a>` : text;
        out.push(`<li>${content}</li>`);
        continue;
      }

      const align = block.alignment as BlockAlignment;
      const style = align === 'left' ? '' : ` style="text-align:${align}"`;
      const content = block.link ? `<a href="${escapeHtml(block.link)}">${text}</a>` : text;
      out.push(`<p${style}>${content}</p>`);
    }
    closeList();
  });

  out.push('</body>', '</html>', '');
  return out.join('\n');
}

function renderTextTable(table: NonNullable<ExportBlockInput['table']>): string {
  return table.rows.map((row) => row.cells.map((cell) => cell.text).join(' | ')).join('\n');
}

function renderMarkdownTable(block: ExportBlockInput): string {
  const rows = block.table?.rows ?? [];
  const columns = Math.max(1, block.table?.columns ?? 0);
  const header = rows[0]?.cells.map((cell) => escapeMarkdownCell(cell.text)) ?? [];
  const body = rows.slice(1).map((row) =>
    row.cells.map((cell) => escapeMarkdownCell(cell.text)),
  );
  const pad = (cells: readonly string[]): string => {
    const padded = Array.from({ length: columns }, (_, index) => cells[index] ?? '');
    return `| ${padded.join(' | ')} |`;
  };
  return [
    pad(header),
    `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`,
    ...body.map(pad),
  ].join('\n');
}

function renderHtmlTable(table: NonNullable<ExportBlockInput['table']>): string {
  const rows = table.rows
    .map((row) => {
      const cells = row.cells
        .map((cell) => `<td>${escapeHtml(cell.text)}</td>`)
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return `<table><tbody>${rows}</tbody></table>`;
}

/* ------------------------------------------------------------------ JSON -- */

/** Versioned envelope of {@link serializeDocument}; `parseDocumentExportJson` reads it back. */
export interface ExportDocumentJson {
  readonly format: 'adt-export-document';
  readonly version: 1;
  readonly documentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly fileName: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly pages: readonly ExportPageInput[];
}

/** Serializes the translated document model into the restorable JSON envelope. */
export function serializeDocument(document: ExportDocumentInput): ExportDocumentJson {
  return {
    format: 'adt-export-document',
    version: 1,
    documentId: document.documentId,
    projectId: document.projectId,
    title: document.title,
    fileName: document.fileName,
    sourceLanguage: document.sourceLanguage,
    targetLanguage: document.targetLanguage,
    pages: document.pages,
  };
}

/**
 * Restores a document exported as JSON. Returns `null` for anything that is
 * not a valid envelope, so an import can never produce a corrupt model.
 */
export function parseDocumentExportJson(text: string): ExportDocumentInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record['format'] !== 'adt-export-document' || record['version'] !== 1) return null;
  if (typeof record['documentId'] !== 'string' || typeof record['projectId'] !== 'string') return null;
  if (typeof record['title'] !== 'string' || typeof record['fileName'] !== 'string') return null;
  if (typeof record['sourceLanguage'] !== 'string' || typeof record['targetLanguage'] !== 'string') {
    return null;
  }
  const pagesRaw = record['pages'];
  if (!Array.isArray(pagesRaw)) return null;

  const pages: ExportPageInput[] = [];
  for (const rawPage of pagesRaw) {
    const page = normalizePage(rawPage);
    if (!page) return null;
    pages.push(page);
  }

  return {
    documentId: record['documentId'],
    projectId: record['projectId'],
    title: record['title'],
    fileName: record['fileName'],
    sourceLanguage: record['sourceLanguage'],
    targetLanguage: record['targetLanguage'],
    pages,
  };
}

function normalizePage(value: unknown): ExportPageInput | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['pageIndex'] !== 'number') return null;
  if (typeof record['width'] !== 'number' || typeof record['height'] !== 'number') return null;
  if (typeof record['rotation'] !== 'number') return null;
  const blocksRaw = record['blocks'];
  if (!Array.isArray(blocksRaw)) return null;

  const blocks: ExportBlockInput[] = [];
  for (const rawBlock of blocksRaw) {
    const block = normalizeBlock(rawBlock);
    if (!block) return null;
    blocks.push(block);
  }

  return {
    pageIndex: record['pageIndex'],
    width: record['width'],
    height: record['height'],
    rotation: record['rotation'],
    blocks,
  };
}

function normalizeBlock(value: unknown): ExportBlockInput | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['blockId'] !== 'string' || typeof record['orderIndex'] !== 'number') return null;
  if (typeof record['kind'] !== 'string' || typeof record['sourceText'] !== 'string') return null;
  if (typeof record['translatedText'] !== 'string' && record['translatedText'] !== null) return null;
  if (typeof record['alignment'] !== 'string') return null;
  const bbox = record['bbox'];
  if (
    typeof bbox !== 'object' ||
    bbox === null ||
    typeof (bbox as Record<string, unknown>)['x'] !== 'number'
  ) {
    return null;
  }
  const font = record['font'];
  if (typeof font !== 'object' || font === null) return null;

  return {
    blockId: record['blockId'],
    orderIndex: record['orderIndex'],
    kind: record['kind'] as ExportBlockInput['kind'],
    bbox: bbox as ExportBlockInput['bbox'],
    font: font as ExportBlockInput['font'],
    alignment: record['alignment'] as BlockAlignment,
    headingLevel: typeof record['headingLevel'] === 'number' ? record['headingLevel'] : null,
    listOrdered: typeof record['listOrdered'] === 'boolean' ? record['listOrdered'] : null,
    table: (record['table'] as ExportBlockInput['table']) ?? null,
    link: typeof record['link'] === 'string' ? record['link'] : null,
    flags: Array.isArray(record['flags'])
      ? (record['flags'] as ExportBlockInput['flags'])
      : [],
    sourceText: record['sourceText'],
    translatedText: record['translatedText'] as string | null,
    unitStatus: (record['unitStatus'] as ExportBlockInput['unitStatus']) ?? null,
  };
}
