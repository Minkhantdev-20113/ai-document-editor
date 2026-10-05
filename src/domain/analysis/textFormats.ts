import type { BBox, BlockIR, BlockKind, LineIR, PageIR, PageWarningCode } from './ir';
import { pageIdFor } from './ir';

/**
 * Text-format analysis (TXT / Markdown / HTML / CSV …).
 *
 * Structure here comes from the source syntax itself (headings, lists, code,
 * tables) rather than from layout heuristics, and a deterministic synthetic
 * layout is generated so previews, thumbnails and exporters see the same IR
 * shape as PDF pages. Long documents are paginated at a nominal A4 size.
 */

export type TextFormat = 'text' | 'markdown' | 'html';

export interface StructuredBlock {
  readonly kind: BlockKind;
  readonly text: string;
  /** Heading level 1..6. */
  readonly level?: number;
  /** List marker style. */
  readonly ordered?: boolean;
  /** Table rows (cells already split). */
  readonly tableRows?: readonly (readonly string[])[];
  readonly bold?: boolean;
  readonly italic?: boolean;
}

export interface ParsedTextDocument {
  readonly blocks: readonly StructuredBlock[];
  readonly title: string | null;
}

export const NOMINAL_PAGE = { width: 595, height: 842 } as const;
const MARGIN = 56;

export function detectTextFormat(fileName: string): TextFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  return 'text';
}

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const SETEXT_H1 = /^\s{0,3}=+\s*$/;
const SETEXT_H2 = /^\s{0,3}-{1,}\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const ORDERED_ITEM = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const BULLET_ITEM = /^(\s*)([-*+])\s+(.*)$/;
const BURMESE_ORDERED_ITEM = /^(\s*)([၀-၉]{1,4})[.)။]\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function stripMarkdownMarkers(line: string): string {
  return line
    .replace(/^\s*>\s?/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isListItem(line: string): { indent: string; ordered: boolean; marker: string; body: string } | null {
  const ordered = ORDERED_ITEM.exec(line);
  if (ordered?.[3] !== undefined) {
    return { indent: ordered[1] ?? '', ordered: true, marker: `${ordered[2]}.`, body: ordered[3] };
  }
  const burmese = BURMESE_ORDERED_ITEM.exec(line);
  if (burmese?.[3] !== undefined) {
    return { indent: burmese[1] ?? '', ordered: true, marker: `${burmese[2]}။`, body: burmese[3] };
  }
  const bullet = BULLET_ITEM.exec(line);
  if (bullet?.[3] !== undefined) {
    // `---` and `***` are rules, not bullets.
    if (HR.test(line)) return null;
    return { indent: bullet[1] ?? '', ordered: false, marker: bullet[2] ?? '-', body: bullet[3] };
  }
  return null;
}

/** Parses Markdown into structured blocks (syntax-derived classification). */
export function parseMarkdown(raw: string): ParsedTextDocument {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const blocks: StructuredBlock[] = [];
  let title: string | null = null;

  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.map(stripMarkdownMarkers).join(' ').trim();
    if (text) blocks.push({ kind: 'paragraph', text });
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const next = lines[index + 1];

    // Fenced code blocks keep their content verbatim.
    const fence = FENCE.exec(line);
    if (fence?.[1]) {
      flushParagraph();
      const closer = fence[1];
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith(closer)) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      blocks.push({ kind: 'code', text: body.join('\n'), bold: false });
      continue;
    }

    const heading = ATX_HEADING.exec(line);
    if (heading?.[1] && heading[2]) {
      flushParagraph();
      blocks.push({
        kind: 'heading',
        text: stripMarkdownMarkers(heading[2]),
        level: heading[1].length,
        bold: true,
      });
      title ??= stripMarkdownMarkers(heading[2]);
      index += 1;
      continue;
    }

    // Setext heading: text underlined with === or ---.
    if (line.trim() !== '' && next !== undefined && (SETEXT_H1.test(next) || SETEXT_H2.test(next))) {
      flushParagraph();
      const level = SETEXT_H1.test(next) ? 1 : 2;
      blocks.push({ kind: 'heading', text: stripMarkdownMarkers(line), level, bold: true });
      title ??= stripMarkdownMarkers(line);
      index += 2;
      continue;
    }

    if (HR.test(line)) {
      flushParagraph();
      index += 1;
      continue;
    }

    // Pipe tables: header row, separator row, then body rows.
    if (line.includes('|') && next !== undefined && TABLE_SEPARATOR.test(next)) {
      flushParagraph();
      const rows: string[][] = [splitTableRow(line)];
      index += 2;
      while (index < lines.length && (lines[index] ?? '').includes('|')) {
        rows.push(splitTableRow(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'table', text: '', tableRows: rows });
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) {
        quote.push(stripMarkdownMarkers(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', text: quote.join('\n'), italic: true });
      continue;
    }

    const listItem = isListItem(line);
    if (listItem) {
      flushParagraph();
      const items: string[] = [];
      const ordered = listItem.ordered;
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const parsed = isListItem(current);
        if (!parsed || parsed.ordered !== ordered) break;
        items.push(`${'  '.repeat(Math.min(6, Math.floor(parsed.indent.length / 2)))}${parsed.marker} ${parsed.body}`);
        index += 1;
      }
      blocks.push({ kind: 'list', text: items.join('\n'), ordered });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      index += 1;
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }
  flushParagraph();

  if (!title) title = blocks.find((block) => block.kind === 'paragraph')?.text.slice(0, 120) ?? null;
  return { blocks, title };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  hellip: '…',
  mdash: '—',
  ndash: '–',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

/** Crude but safe HTML → plain text (block tags become paragraphs). */
export function parseHtml(raw: string): ParsedTextDocument {
  const withoutScripts = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const withBreaks = withoutScripts
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])[^>]*>/gi, (_match, level: string) => `\n${'#'.repeat(Number(level))} `);
  const text = decodeEntities(withBreaks.replace(/<[^>]+>/g, ' '));
  const normalized = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return parseMarkdown(normalized);
}

/** Plain text: blank-line paragraphs, with light heading/list recognition. */
export function parsePlainText(raw: string): ParsedTextDocument {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const blocks: StructuredBlock[] = [];
  let title: string | null = null;
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(' ').trim();
    if (!text) return;
    const first = paragraph[0] ?? '';
    const isHeadingLike =
      paragraph.length === 1 &&
      text.length <= 80 &&
      first === first.toUpperCase() &&
      /[A-Z]/.test(first) &&
      blocks.length < 3;
    if (isHeadingLike) {
      blocks.push({ kind: 'heading', text, level: Math.min(3, blocks.length + 1), bold: true });
      title ??= text;
    } else {
      blocks.push({ kind: 'paragraph', text });
    }
    paragraph = [];
  };

  let index = 0;
  while (index < lines.length) {
    const trimmed = (lines[index] ?? '').trim();
    if (trimmed === '') {
      flush();
      index += 1;
      continue;
    }
    const listItem = isListItem(trimmed);
    if (listItem) {
      flush();
      const items: string[] = [];
      const ordered = listItem.ordered;
      while (index < lines.length) {
        const current = (lines[index] ?? '').trim();
        if (current === '') break;
        const parsed = isListItem(current);
        if (!parsed || parsed.ordered !== ordered) break;
        items.push(`${parsed.marker} ${parsed.body}`);
        index += 1;
      }
      blocks.push({ kind: 'list', text: items.join('\n'), ordered });
      continue;
    }
    paragraph.push(trimmed);
    index += 1;
  }
  flush();

  if (!title) title = blocks.find((block) => block.kind === 'paragraph')?.text.slice(0, 120) ?? null;
  return { blocks, title };
}

/** Entry point used by the analysis source for non-PDF documents. */
export function parseTextDocument(raw: string, format: TextFormat): ParsedTextDocument {
  switch (format) {
    case 'markdown':
      return parseMarkdown(raw);
    case 'html':
      return parseHtml(raw);
    default:
      return parsePlainText(raw);
  }
}

/* ------------------------------------------------------------------ */
/* Synthetic layout: structured blocks → paginated PageIR (same shape   */
/* as PDF pages, so previews/exporters need no special cases).          */
/* ------------------------------------------------------------------ */

interface RenderLine {
  readonly text: string;
  readonly fontSize: number;
}

const HEADING_SIZES: readonly number[] = [26, 22, 18, 16, 14, 13];

function styleFor(block: StructuredBlock): { size: number; family: string; bold: boolean; italic: boolean; gap: number } {
  switch (block.kind) {
    case 'heading':
      return {
        size: HEADING_SIZES[Math.min(Math.max((block.level ?? 1) - 1, 0), HEADING_SIZES.length - 1)]!,
        family: 'sans-serif',
        bold: true,
        italic: false,
        gap: 0.5,
      };
    case 'code':
      return { size: 10.5, family: 'monospace', bold: block.bold ?? false, italic: false, gap: 0.6 };
    case 'caption':
      return { size: 10, family: 'sans-serif', bold: block.bold ?? false, italic: true, gap: 0.5 };
    case 'quote':
      return { size: 12, family: 'sans-serif', bold: block.bold ?? false, italic: block.italic ?? true, gap: 0.6 };
    default:
      return {
        size: 12,
        family: 'sans-serif',
        bold: block.bold ?? false,
        italic: block.italic ?? false,
        gap: 0.55,
      };
  }
}

function isWideChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

function unionBoxes(a: BBox | null, b: BBox): BBox {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function measure(text: string, fontSize: number, monospace: boolean): number {
  let width = 0;
  for (const char of text) {
    if (monospace) width += fontSize * 0.6;
    else width += char === '\t' ? fontSize * 2 : isWideChar(char) ? fontSize : fontSize * 0.5;
  }
  return width;
}

/** Greedy word wrap with CJK/long-token character-level fallback. */
function wrapLine(text: string, fontSize: number, contentWidth: number, monospace: boolean): string[] {
  const normalized = text.replace(/\t/g, '    ');
  if (measure(normalized, fontSize, monospace) <= contentWidth) return [normalized];

  const tokens = normalized.split(/(\s+)/).filter((token) => token !== '');
  const lines: string[] = [];
  let current = '';

  const pushToken = (token: string): void => {
    if (current === '') current = token;
    else if (measure(`${current} ${token}`, fontSize, monospace) <= contentWidth) current = `${current} ${token}`;
    else {
      lines.push(current);
      current = token;
    }
  };

  const hardSplit = (token: string): void => {
    let piece = '';
    for (const char of token) {
      if (piece !== '' && measure(piece + char, fontSize, monospace) > contentWidth) {
        lines.push(piece);
        piece = char;
      } else {
        piece += char;
      }
    }
    if (piece !== '') pushToken(piece);
  };

  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      if (current !== '') current += ' ';
      continue;
    }
    if (measure(token, fontSize, monospace) > contentWidth) {
      if (current !== '') {
        lines.push(current);
        current = '';
      }
      hardSplit(token);
      continue;
    }
    pushToken(token);
  }
  if (current.trim() !== '') lines.push(current.trimEnd());
  return lines.length > 0 ? lines : [normalized];
}

function blockSourceLines(block: StructuredBlock): string[] {
  if (block.kind === 'table' && block.tableRows) {
    return block.tableRows.map((row) => row.join(' | '));
  }
  if (block.kind === 'list') {
    return block.text.split('\n');
  }
  if (block.kind === 'code') {
    return block.text.split('\n');
  }
  return block.text.split('\n');
}

interface PlacedLine {
  readonly text: string;
  readonly fontSize: number;
  readonly blockIndex: number;
}

/**
 * Flows structured blocks onto nominal A4 pages. Blocks stay together when
 * they fit; oversized blocks (long code, big tables) split across pages.
 */
export function buildTextPages(parsed: ParsedTextDocument, documentId: string): PageIR[] {
  const width = NOMINAL_PAGE.width;
  const height = NOMINAL_PAGE.height;
  const contentWidth = width - MARGIN * 2;
  const bottom = height - MARGIN;

  const placed: PlacedLine[][] = [];
  let current: PlacedLine[] = [];
  let y = MARGIN;

  const startPage = (): void => {
    if (current.length > 0) placed.push(current);
    current = [];
    y = MARGIN;
  };

  parsed.blocks.forEach((block, blockIndex) => {
    const style = styleFor(block);
    const monospace = style.family === 'monospace';
    const sourceLines = blockSourceLines(block);
    const rendered: RenderLine[] = [];
    for (const line of sourceLines) {
      for (const wrapped of wrapLine(line, style.size, contentWidth, monospace)) {
        rendered.push({ text: wrapped, fontSize: style.size });
      }
    }
    if (rendered.length === 0) return;

    const lineHeight = (line: RenderLine): number => line.fontSize * 1.4;
    const blockHeight =
      rendered.reduce((total, line) => total + lineHeight(line), 0) +
      style.size * (block.kind === 'heading' ? 0.8 : style.gap);
    const fitsHere = y + blockHeight <= bottom;
    const fitsPage = blockHeight <= bottom - MARGIN;
    if (!fitsHere && current.length > 0 && fitsPage) startPage();

    y += block.kind === 'heading' ? style.size * 0.35 : 0;
    for (const line of rendered) {
      const needed = lineHeight(line);
      if (y + needed > bottom && current.length > 0) startPage();
      current.push({ text: line.text, fontSize: line.fontSize, blockIndex });
      y += needed;
    }
    y += style.size * (block.kind === 'heading' ? 0.45 : style.gap);
  });
  startPage();

  const pageCount = Math.max(1, placed.length);
  const pages: PageIR[] = [];

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageId = pageIdFor(documentId, pageIndex);
    const pageLines = placed[pageIndex] ?? [];
    let cursorY = MARGIN;
    const byBlock = new Map<number, PlacedLine[]>();
    for (const line of pageLines) {
      const bucket = byBlock.get(line.blockIndex);
      if (bucket) bucket.push(line);
      else byBlock.set(line.blockIndex, [line]);
    }

    const blocks: BlockIR[] = [];
    let readingOrder = 0;
    let charCount = 0;
    for (const [blockIndex, lines] of [...byBlock.entries()].sort((a, b) => a[0] - b[0])) {
      const block = parsed.blocks[blockIndex];
      if (!block || lines.length === 0) continue;
      const style = styleFor(block);
      const blockId = `${pageId}_b${readingOrder}`;
      let bbox: BBox | null = null;
      const irLines: LineIR[] = [];
      let localY = cursorY;
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex]!;
        const lineWidth = measure(line.text, line.fontSize, style.family === 'monospace');
        const lineBox: BBox = { x: MARGIN, y: localY, width: Math.max(lineWidth, 1), height: line.fontSize };
        irLines.push({
          id: `${blockId}_l${lineIndex}`,
          text: line.text,
          bbox: lineBox,
          fontSize: line.fontSize,
        });
        bbox = unionBoxes(bbox, lineBox);
        charCount += line.text.trim().length;
        localY += line.fontSize * 1.4;
      }
      cursorY = localY + style.size * (block.kind === 'heading' ? 0.45 : style.gap);
      if (!bbox) continue;
      blocks.push({
        id: blockId,
        kind: block.kind,
        text: block.text || lines.map((line) => line.text).join('\n'),
        bbox,
        lines: irLines,
        font: { family: style.family, size: style.size, bold: style.bold, italic: style.italic },
        alignment: 'left',
        readingOrder,
        flags: [],
        ...(block.level !== undefined ? { headingLevel: block.level } : {}),
        ...(block.kind === 'list' ? { listOrdered: block.ordered ?? false } : {}),
        ...(block.kind === 'table' && block.tableRows
          ? {
              table: {
                columns: Math.max(...block.tableRows.map((row) => row.length), 1),
                rows: block.tableRows.map((row) => ({
                  cells: row.map((cellText) => ({
                    text: cellText,
                    bbox: {
                      x: MARGIN,
                      y: bbox.y,
                      width: Math.max(measure(cellText, style.size, false), 1),
                      height: style.size,
                    },
                  })),
                })),
              },
            }
          : {}),
      });
      readingOrder += 1;
    }

    const warnings: PageWarningCode[] = charCount < 3 ? ['empty'] : [];
    pages.push({
      id: pageId,
      index: pageIndex,
      width,
      height,
      rotation: 0,
      blocks,
      images: [],
      warnings,
      requiresOcr: false,
      charCount,
      durationMs: 0,
    });
  }

  return pages;
}
