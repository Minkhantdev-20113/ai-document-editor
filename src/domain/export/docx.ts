/**
 * DOCX writer (Phase 5, secondary format): builds a minimal but valid
 * Office Open XML package (`[Content_Types].xml`, relationships, document,
 * styles, core properties) from the translated document model.
 *
 * Structure preserved: headings as `Heading1..6` styles, ordered/bulleted
 * lists, tables with a grid, hyperlinks as real relationships, alignment and
 * per-block size, plus one section per source page so page size and
 * orientation survive. Compression uses the platform's `CompressionStream`
 * through `writeZipEntries` - no extra dependency.
 */
import { writeZipEntries } from '../../core/utils/zip';
import type { BlockAlignment } from '../analysis/ir';
import type { ExportBlockInput, ExportDocumentInput, ExportPageInput } from './types';

const MAIN_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** Same 56 pt layout margin the PDF planner uses, in twips (1 pt = 20 twips). */
const MARGIN_TWIPS = 56 * 20;
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

interface LinkTarget {
  readonly id: string;
  readonly target: string;
}

type LinkSink = LinkTarget[];

interface ListState {
  ordered: number;
}

export async function renderDocx(document: ExportDocumentInput): Promise<Uint8Array> {
  const links: LinkSink = [];
  const body: string[] = [];
  // Ordered-list numbering restarts per page and whenever a non-list block
  // interrupts the run (mirrors the TXT/Markdown renderers).
  const list: ListState = { ordered: 0 };

  document.pages.forEach((page, pageIndex) => {
    const flowWidth = Math.max(72, page.width - 112);
    for (const block of page.blocks) {
      body.push(blockXml(block, flowWidth, links, list));
    }
    list.ordered = 0;
    // A paragraph section break closes this page's section: the next page
    // starts on a new page with its own size/orientation.
    if (pageIndex < document.pages.length - 1) {
      body.push(sectionParagraph(page));
    }
  });

  const last = document.pages[document.pages.length - 1];
  const documentXml = `${XML_DECL}<w:document xmlns:w="${MAIN_NS}" xmlns:r="${REL_NS}"><w:body>${body.join(
    '',
  )}${last ? bodySection(last) : defaultSection()}</w:body></w:document>`;

  const encoder = new TextEncoder();
  const stylesXml = `${XML_DECL}<w:styles xmlns:w="${MAIN_NS}">${normalStyle()}${headingStyles()}</w:styles>`;
  const contentTypes = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>';
  const packageRels =
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>';
  const documentRels =
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    links
      .map(
        (link) =>
          `<Relationship Id="${link.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(
            link.target,
          )}" TargetMode="External"/>`,
      )
      .join('') +
    '</Relationships>';
  const coreProps = `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${escapeXml(document.title)}</dc:title>` +
    '<dc:creator>AI Document Translator</dc:creator>' +
    `<dc:language>${escapeXml(document.targetLanguage)}</dc:language>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>` +
    '</cp:coreProperties>';

  return writeZipEntries([
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { name: '_rels/.rels', data: encoder.encode(packageRels) },
    { name: 'docProps/core.xml', data: encoder.encode(coreProps) },
    { name: 'word/document.xml', data: encoder.encode(documentXml) },
    { name: 'word/styles.xml', data: encoder.encode(stylesXml) },
    { name: 'word/_rels/document.xml.rels', data: encoder.encode(documentRels) },
  ]);
}

function blockXml(
  block: ExportBlockInput,
  flowWidth: number,
  links: LinkSink,
  list: ListState,
): string {
  const text = block.translatedText ?? block.sourceText;
  const level = headingLevel(block);

  if (block.table) {
    list.ordered = 0;
    return tableXml(block.table, flowWidth);
  }
  if (level !== null) {
    list.ordered = 0;
    return paragraph(
      `<w:pPr><w:pStyle w:val="Heading${level}"/>${justification(block.alignment)}</w:pPr>`,
      text,
      block,
      links,
    );
  }
  if (block.listOrdered !== null) {
    const prefix = block.listOrdered ? `${(list.ordered += 1)}. ` : '\u2022 ';
    if (!block.listOrdered) list.ordered = 0;
    return paragraph(
      `<w:pPr>${justification(block.alignment)}</w:pPr>`,
      `${prefix}${text}`,
      block,
      links,
    );
  }

  list.ordered = 0;
  return paragraph(
    `<w:pPr>${justification(block.alignment)}</w:pPr>`,
    text,
    block,
    links,
    block.link ?? undefined,
  );
}

function paragraph(
  paragraphProperties: string,
  text: string,
  block: ExportBlockInput,
  links: LinkSink,
  link?: string,
): string {
  const run = runXml(text, block);
  if (link) {
    const id = registerLink(link, links);
    return `<w:p>${paragraphProperties}<w:hyperlink r:id="${id}">${run}</w:hyperlink></w:p>`;
  }
  return `<w:p>${paragraphProperties}${run}</w:p>`;
}

function runXml(text: string, block: ExportBlockInput): string {
  const size = Math.max(2, Math.round(block.font.size * 2)); // half-points
  const mono = block.kind === 'code';
  const fonts = mono ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>' : '';
  const style = `${block.font.bold ? '<w:b/>' : ''}${block.font.italic ? '<w:i/>' : ''}`;
  return `<w:r><w:rPr>${fonts}${style}<w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${escapeXml(
    text,
  )}</w:t></w:r>`;
}

function tableXml(table: NonNullable<ExportBlockInput['table']>, flowWidth: number): string {
  const columns = Math.max(1, table.columns);
  const columnWidth = Math.max(480, Math.round((flowWidth * 20) / columns));
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${columnWidth}"/>`).join('');
  const borders =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((edge) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`)
      .join('') +
    '</w:tblBorders>';
  const rows = table.rows
    .map((row) => {
      const cells = row.cells
        .map(
          (cell) =>
            `<w:tc><w:tcPr><w:tcW w:w="${columnWidth}" w:type="dxa"/></w:tcPr>` +
            `<w:p><w:r><w:t xml:space="preserve">${escapeXml(cell.text)}</w:t></w:r></w:p></w:tc>`,
        )
        .join('');
      return `<w:tr>${cells}</w:tr>`;
    })
    .join('');

  return (
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`
  );
}

function justification(alignment: BlockAlignment): string {
  const value =
    alignment === 'center' ? 'center' : alignment === 'right' ? 'right' : alignment === 'justify' ? 'both' : null;
  return value ? `<w:jc w:val="${value}"/>` : '';
}

function headingLevel(block: ExportBlockInput): number | null {
  const level = block.headingLevel;
  return typeof level === 'number' && level >= 1 ? Math.min(6, level) : null;
}

function registerLink(target: string, links: LinkSink): string {
  const existing = links.find((link) => link.target === target);
  if (existing) return existing.id;
  const id = `rId${links.length + 2}`; // rId1 = styles.xml
  links.push({ id, target });
  return id;
}

function pageGeometry(page: ExportPageInput): string {
  const landscape = page.rotation === 90 || page.rotation === 270;
  const width = landscape ? page.height : page.width;
  const height = landscape ? page.width : page.height;
  const size = `<w:pgSz w:w="${Math.round(width * 20)}" w:h="${Math.round(height * 20)}"${
    landscape ? ' w:orient="landscape"' : ''
  }/>`;
  const margins = `<w:pgMar w:top="${MARGIN_TWIPS}" w:right="${MARGIN_TWIPS}" w:bottom="${MARGIN_TWIPS}" w:left="${MARGIN_TWIPS}" w:header="720" w:footer="720" w:gutter="0"/>`;
  return size + margins;
}

function sectionParagraph(page: ExportPageInput): string {
  return `<w:p><w:pPr><w:sectPr><w:type w:val="nextPage"/>${pageGeometry(page)}</w:sectPr></w:pPr></w:p>`;
}

function bodySection(page: ExportPageInput): string {
  return `<w:sectPr>${pageGeometry(page)}</w:sectPr>`;
}

function defaultSection(): string {
  return (
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1120" w:right="1120" w:bottom="1120" w:left="1120" w:header="720" w:footer="720" w:gutter="0"/>' +
    '</w:sectPr>'
  );
}

function normalStyle(): string {
  return (
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
    '<w:name w:val="Normal"/><w:qFormat/></w:style>'
  );
}

function headingStyles(): string {
  const sizes = [32, 28, 26, 24, 22, 20];
  return sizes
    .map(
      (size, index) =>
        `<w:style w:type="paragraph" w:styleId="Heading${index + 1}">` +
        `<w:name w:val="heading ${index + 1}"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
        `<w:pPr><w:keepNext/><w:outlineLvl w:val="${index}"/></w:pPr>` +
        `<w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`,
    )
    .join('');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
