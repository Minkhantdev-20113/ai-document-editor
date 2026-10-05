import { describe, expect, it } from 'vitest';
import { buildTextPages, detectTextFormat, parseHtml, parseMarkdown, parsePlainText, parseTextDocument } from './textFormats';

describe('detectTextFormat', () => {
  it('maps file extensions to formats', () => {
    expect(detectTextFormat('notes.md')).toBe('markdown');
    expect(detectTextFormat('README.MARKDOWN')).toBe('markdown');
    expect(detectTextFormat('page.html')).toBe('html');
    expect(detectTextFormat('page.HTM')).toBe('html');
    expect(detectTextFormat('notes.txt')).toBe('text');
    expect(detectTextFormat('data.csv')).toBe('text');
    expect(detectTextFormat('noextension')).toBe('text');
  });
});

describe('parseMarkdown', () => {
  const source = [
    '# Project Alpha',
    '',
    'Intro paragraph with **bold** and `code` inline.',
    '',
    '## Background',
    '',
    '- first bullet',
    '- second bullet',
    '',
    '1. ordered one',
    '2. ordered two',
    '',
    '```ts',
    'const answer = 42;',
    '```',
    '',
    '> Quoted line one',
    '> Quoted line two',
    '',
    '| Name | Value |',
    '| ---- | ----- |',
    '| A    | 1     |',
    '| B    | 2     |',
    '',
    'Setext Title',
    '============',
    '',
    'Closing paragraph',
  ].join('\n');

  const parsed = parseMarkdown(source);

  it('extracts the title from the first heading', () => {
    expect(parsed.title).toBe('Project Alpha');
  });

  it('classifies ATX headings with levels', () => {
    const headings = parsed.blocks.filter((block) => block.kind === 'heading');
    expect(headings.map((block) => [block.text, block.level])).toEqual([
      ['Project Alpha', 1],
      ['Background', 2],
      ['Setext Title', 1],
    ]);
  });

  it('keeps bold/code markers out of paragraph text', () => {
    const paragraph = parsed.blocks.find((block) => block.kind === 'paragraph');
    expect(paragraph?.text).toBe('Intro paragraph with bold and code inline.');
  });

  it('merges consecutive list items into one block per marker style', () => {
    const lists = parsed.blocks.filter((block) => block.kind === 'list');
    expect(lists).toHaveLength(2);
    expect(lists[0]!.ordered).toBe(false);
    expect(lists[0]!.text).toContain('- first bullet');
    expect(lists[1]!.ordered).toBe(true);
    expect(lists[1]!.text).toContain('1. ordered one');
  });

  it('preserves code block content verbatim', () => {
    const code = parsed.blocks.find((block) => block.kind === 'code');
    expect(code?.text).toBe('const answer = 42;');
  });

  it('collects blockquotes as one quote block', () => {
    const quote = parsed.blocks.find((block) => block.kind === 'quote');
    expect(quote?.text).toBe('Quoted line one\nQuoted line two');
  });

  it('parses pipe tables into rows and cells', () => {
    const table = parsed.blocks.find((block) => block.kind === 'table');
    expect(table?.tableRows).toEqual([
      ['Name', 'Value'],
      ['A', '1'],
      ['B', '2'],
    ]);
  });

  it('recognizes Burmese markdown structure', () => {
    const burmese = parseMarkdown('# မြန်မာစာ ခေါင်းစဉ်\n\nဤစာပိုဒ်သည် စမ်းသပ်ခြင်း ဖြစ်သည်။\n\n- ပထမ အချက်\n- ဒုတိယ အချက်');
    expect(burmese.title).toBe('မြန်မာစာ ခေါင်းစဉ်');
    expect(burmese.blocks[0]!.kind).toBe('heading');
    expect(burmese.blocks[1]!.kind).toBe('paragraph');
    expect(burmese.blocks[2]!.kind).toBe('list');
  });
});

describe('parsePlainText', () => {
  it('splits paragraphs on blank lines and keeps list runs together', () => {
    const parsed = parsePlainText(
      ['First paragraph line one.', '', 'Second paragraph continues here.', '', '- item a', '- item b'].join('\n'),
    );
    expect(parsed.blocks.filter((block) => block.kind === 'paragraph')).toHaveLength(2);
    const list = parsed.blocks.find((block) => block.kind === 'list');
    expect(list?.ordered).toBe(false);
    expect(list?.text.split('\n')).toHaveLength(2);
  });

  it('recognizes an all-caps lead line as the title heading', () => {
    const parsed = parsePlainText('MONTHLY REPORT\n\nBody of the report with words.');
    expect(parsed.blocks[0]!.kind).toBe('heading');
    expect(parsed.title).toBe('MONTHLY REPORT');
  });
});

describe('parseHtml', () => {
  it('strips tags, scripts and decodes entities', () => {
    const parsed = parseHtml(
      '<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><h1>Head &amp; Title</h1><p>Body &lt;text&gt; here.</p></body></html>',
    );
    expect(parsed.title).toBe('Head & Title');
    expect(parsed.blocks.some((block) => block.text.includes('<text>'))).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('alert');
    expect(JSON.stringify(parsed)).not.toContain('color:red');
  });
});

describe('parseTextDocument', () => {
  it('routes by format', () => {
    expect(parseTextDocument('# Hi', 'markdown').blocks[0]!.kind).toBe('heading');
    expect(parseTextDocument('TITLE', 'text').blocks[0]!.kind).toBe('heading'); // all-caps lead
    expect(parseTextDocument('<p>Hi</p>', 'html').blocks[0]!.kind).toBe('paragraph');
  });
});

describe('buildTextPages', () => {
  it('produces a single paginated page with stable ids', () => {
    const parsed = parseMarkdown('# Title\n\nFirst paragraph of content.');
    const pages = buildTextPages(parsed, 'doc_x');

    expect(pages).toHaveLength(1);
    expect(pages[0]!.id).toBe('doc_x_p0');
    expect(pages[0]!.blocks[0]!.id).toBe('doc_x_p0_b0');
    expect(pages[0]!.blocks[0]!.kind).toBe('heading');
    expect(pages[0]!.blocks[0]!.headingLevel).toBe(1);
    expect(pages[0]!.blocks[0]!.font.bold).toBe(true);
    expect(pages[0]!.charCount).toBeGreaterThan(10);
    expect(pages[0]!.requiresOcr).toBe(false);
  });

  it('paginates long documents into multiple pages', () => {
    const paragraphs = Array.from(
      { length: 120 },
      (_value, index) => `Paragraph number ${index} with a reasonable amount of body text inside it.`,
    );
    const pages = buildTextPages(parsePlainText(paragraphs.join('\n\n')), 'doc_long');
    expect(pages.length).toBeGreaterThan(1);
    // Reading order restarts per page and ids stay page-scoped.
    pages.forEach((page, index) => {
      expect(page.index).toBe(index);
      expect(page.id).toBe(`doc_long_p${index}`);
      page.blocks.forEach((block, blockIndex) => {
        expect(block.readingOrder).toBe(blockIndex);
        expect(block.id).toBe(`doc_long_p${index}_b${blockIndex}`);
      });
    });
  });

  it('marks empty documents as empty pages', () => {
    const pages = buildTextPages({ blocks: [], title: null }, 'doc_empty');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.blocks).toHaveLength(0);
    expect(pages[0]!.warnings).toContain('empty');
  });

  it('keeps table structure on the synthesized page', () => {
    const parsed = parseMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
    const pages = buildTextPages(parsed, 'doc_t');
    const table = pages[0]!.blocks.find((block) => block.kind === 'table');
    expect(table?.table?.columns).toBe(2);
    expect(table?.table?.rows).toHaveLength(2);
  });

  it('lays out long Burmese text without losing content', () => {
    const burmeseParagraph =
      'မြန်မာနိုင်ငံသည် အရှေ့တောင်အာရှတွင် တည်ရှိပြီး ရှေးဟောင်းယဉ်ကျေးမှုများ စုံလင်စွာ ရှိသည်။';
    const parsed = parsePlainText(Array.from({ length: 20 }, () => burmeseParagraph).join('\n\n'));
    const pages = buildTextPages(parsed, 'doc_my');
    const text = pages.flatMap((page) => page.blocks.map((block) => block.text)).join('');
    expect(text).toContain('မြန်မာနိုင်ငံသည်');
    expect(pages.reduce((total, page) => total + page.charCount, 0)).toBeGreaterThan(500);
    for (const page of pages) {
      for (const block of page.blocks) {
        expect(block.bbox.width).toBeLessThanOrEqual(page.width + 4);
      }
    }
  });
});
