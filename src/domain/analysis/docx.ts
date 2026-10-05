import { readZipEntries } from '../../core/utils/zip';
import type { ParsedTextDocument, StructuredBlock } from './textFormats';

/**
 * DOCX (Office Open XML) structure extraction.
 *
 * The document body is scanned as raw XML with balanced tag matching for the
 * elements that carry structure (paragraphs, styles, numbering, tables, hyper
 * links). Runs are joined into text, styles map to headings/quotes/captions,
 * and numbering resolves bulleted vs ordered lists.
 */

const decoder = new TextDecoder('utf-8');

interface StyleInfo {
  readonly name: string;
  readonly kind: 'heading' | 'quote' | 'caption' | 'code' | null;
  readonly level: number | null;
}

function classifyStyle(name: string): StyleInfo {
  const lower = name.toLowerCase();
  const heading = /heading\s*([1-6])/.exec(lower) ?? /h([1-6])\s*$/.exec(lower);
  if (/^title$/.test(lower)) return { name, kind: 'heading', level: 1 };
  if (heading?.[1]) return { name, kind: 'heading', level: Number(heading[1]) };
  if (lower.includes('quote')) return { name, kind: 'quote', level: null };
  if (lower.includes('caption')) return { name, kind: 'caption', level: null };
  if (lower.includes('code') || lower.includes('source')) return { name, kind: 'code', level: null };
  return { name, kind: null, level: null };
}

/** Maps styleId → classified style using word/styles.xml. */
function parseStyles(xml: string | null): Map<string, StyleInfo> {
  const map = new Map<string, StyleInfo>();
  if (!xml) return map;
  for (const match of xml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const styleId = match[1];
    if (!styleId) continue;
    const body = match[2] ?? '';
    const nameMatch = /<w:name\b[^>]*w:val="([^"]+)"/.exec(body);
    const basedOn = /<w:basedOn\b[^>]*w:val="([^"]+)"/.exec(body);
    const name = nameMatch?.[1] ?? styleId;
    const info = classifyStyle(name);
    map.set(styleId, info);
    if (info.kind === null && basedOn?.[1]) {
      const parent = map.get(basedOn[1]);
      if (parent && parent.kind !== null) map.set(styleId, { ...parent, name });
    }
  }
  return map;
}

/** Maps numId → ordered flag using word/numbering.xml. */
function parseNumbering(xml: string | null): Map<string, boolean> {
  const formats = new Map<string, string>();
  const numToAbstract = new Map<string, string>();
  if (!xml) return new Map();
  for (const match of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="([^"]+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const abstractId = match[1];
    if (!abstractId) continue;
    const levelZero = /<w:lvl\b[^>]*w:ilvl="0"[^>]*>([\s\S]*?)<\/w:lvl>/.exec(match[2] ?? '');
    const format = /<w:numFmt\b[^>]*w:val="([^"]+)"/.exec(levelZero?.[1] ?? '');
    if (format?.[1]) formats.set(abstractId, format[1]);
  }
  for (const match of xml.matchAll(/<w:num\b[^>]*w:numId="([^"]+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const numId = match[1];
    const abstractId = /<w:abstractNumId\b[^>]*w:val="([^"]+)"/.exec(match[2] ?? '');
    if (numId && abstractId?.[1]) numToAbstract.set(numId, abstractId[1]);
  }
  const ordered = new Map<string, boolean>();
  for (const [numId, abstractId] of numToAbstract) {
    ordered.set(numId, (formats.get(abstractId) ?? 'bullet') !== 'bullet');
  }
  return ordered;
}

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

function extractText(inner: string): string {
  let text = '';
  const tokenPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/g;
  for (const match of inner.matchAll(tokenPattern)) {
    const [full, captured] = match;
    if (captured !== undefined) text += decodeXmlText(captured);
    else if (full?.includes('w:tab')) text += ' ';
    else text += '\n';
  }
  return text;
}

/** Parses a DOCX file's bytes into structured blocks (same model as Markdown). */
export async function parseDocx(bytes: Uint8Array): Promise<ParsedTextDocument> {
  const entries = await readZipEntries(bytes);
  const documentEntry = entries.get('word/document.xml');
  if (!documentEntry) {
    throw new Error('DOCX is missing word/document.xml');
  }
  const documentXml = decoder.decode(documentEntry.data);
  const styles = parseStyles(entries.get('word/styles.xml') ? decoder.decode(entries.get('word/styles.xml')!.data) : null);
  const numbering = parseNumbering(
    entries.get('word/numbering.xml') ? decoder.decode(entries.get('word/numbering.xml')!.data) : null,
  );

  const blocks: StructuredBlock[] = [];
  let title: string | null = null;

  // Walk the body in document order, alternating paragraphs and tables.
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(documentXml)?.[1] ?? documentXml;
  const events: { at: number; type: 'p' | 'tbl'; match: RegExpExecArray | null }[] = [];
  for (const pattern of [/<w:p\b[^>]*>/g, /<w:tbl\b[^>]*>/g] as const) {
    for (const match of body.matchAll(pattern)) {
      events.push({ at: match.index ?? 0, type: pattern.source.startsWith('<w:p') ? 'p' : 'tbl', match });
    }
  }
  events.sort((a, b) => a.at - b.at);

  for (const event of events) {
    if (event.type === 'tbl') {
      const table = extractTable(body, event.at);
      if (table.rows.length > 0) {
        blocks.push({ kind: 'table', text: '', tableRows: table.rows });
      }
      continue;
    }
    const paragraph = extractParagraph(body, event.at, styles, numbering);
    if (!paragraph) continue;
    if (paragraph.kind === 'heading') title ??= paragraph.text.slice(0, 120);
    if (paragraph.text.trim() !== '' || paragraph.kind === 'table') blocks.push(paragraph);
  }

  if (!title) title = blocks.find((block) => block.kind === 'paragraph')?.text.slice(0, 120) ?? null;
  return { blocks, title };
}

/** Finds the matching `</w:p>` for the paragraph opening at `start`. */
function elementEnd(xml: string, start: number, tag: string): number {
  const openToken = `<${tag}`;
  const closeToken = `</${tag}>`;
  let depth = 0;
  let index = start;
  while (index < xml.length) {
    const nextOpen = xml.indexOf(openToken, index);
    const nextClose = xml.indexOf(closeToken, index);
    if (nextClose < 0) return xml.length;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      const after = xml.indexOf('>', nextOpen);
      if (after < 0) return xml.length;
      const selfClosing = xml.slice(nextOpen, after + 1).endsWith('/>');
      if (!selfClosing && xml.slice(nextOpen, nextOpen + openToken.length + 1) === `<${tag} `) depth += 1;
      else if (!selfClosing && xml.slice(nextOpen, nextOpen + openToken.length + 1) === `<${tag}>`) depth += 1;
      index = after + 1;
      continue;
    }
    depth -= 1;
    if (depth <= 0) return nextClose;
    index = nextClose + closeToken.length;
  }
  return xml.length;
}

function extractParagraph(
  xml: string,
  start: number,
  styles: Map<string, StyleInfo>,
  numbering: Map<string, boolean>,
): StructuredBlock | null {
  const openMatch = /^<w:p\b([^>]*)>/.exec(xml.slice(start));
  if (!openMatch) return null;
  const attrs = (openMatch[1] ?? '').trim();
  if (attrs.endsWith('/')) return null; // Self-closing empty paragraph.
  const end = elementEnd(xml, start, 'p');
  const inner = xml.slice(start, end);
  const text = extractText(inner).replace(/\n{3,}/g, '\n\n').trim();
  if (text === '') return null;

  const styleId = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(inner)?.[1];
  const style = styleId ? styles.get(styleId) : undefined;
  const numberingId = /<w:numId\b[^>]*w:val="([^"]+)"/.exec(inner)?.[1];
  const isList = numberingId !== undefined || /<w:numPr>/.test(inner);
  const ordered = numberingId ? (numbering.get(numberingId) ?? false) : false;
  const italic = /<w:i\s*\/>|<w:i\s[^>]*w:val="(1|true)"\s*\/>/.test(inner);
  const bold = /<w:b\s*\/>|<w:b\s[^>]*w:val="(1|true)"\s*\/>/.test(inner);

  if (isList) {
    return { kind: 'list', text, ordered, bold, italic };
  }
  if (style?.kind === 'heading') {
    return { kind: 'heading', text, level: style.level ?? 2, bold: true };
  }
  if (style?.kind === 'quote') return { kind: 'quote', text, italic: true };
  if (style?.kind === 'caption') return { kind: 'caption', text, italic: true };
  if (style?.kind === 'code') return { kind: 'code', text };
  return { kind: 'paragraph', text, bold, italic };
}

function extractTable(xml: string, start: number): { rows: string[][] } {
  const end = elementEnd(xml, start, 'tbl');
  const inner = xml.slice(start, end);
  const rows: string[][] = [];
  for (const rowMatch of inner.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
    const rowInner = rowMatch[1] ?? '';
    const cells: string[] = [];
    for (const cellMatch of rowInner.matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)) {
      cells.push(extractText(cellMatch[1] ?? '').replace(/\n+/g, ' ').trim());
    }
    if (cells.length > 0) rows.push(cells);
  }
  return { rows };
}
