import { describe, expect, it } from 'vitest';
import { crc32, readZipEntries, writeZipEntries } from './zip';

const encoder = new TextEncoder();

describe('zip writer (Phase 5: DOCX export)', () => {
  it('round-trips entries through the existing reader', async () => {
    const archive = await writeZipEntries([
      { name: '[Content_Types].xml', data: encoder.encode('<?xml version="1.0"?><Types/>') },
      {
        name: 'word/document.xml',
        data: encoder.encode(`<w:document>${'content '.repeat(200)}</w:document>`),
      },
      { name: 'empty.txt', data: new Uint8Array(0) },
    ]);

    const read = await readZipEntries(archive);

    expect([...read.keys()]).toEqual(['[Content_Types].xml', 'word/document.xml', 'empty.txt']);
    expect(new TextDecoder().decode(read.get('word/document.xml')?.data ?? new Uint8Array())).toContain(
      '<w:document>',
    );
    expect(read.get('empty.txt')?.data.byteLength).toBe(0);
  });

  it('compresses repetitive payloads instead of storing them raw', async () => {
    const data = encoder.encode('the same words '.repeat(500));

    const archive = await writeZipEntries([{ name: 'doc.xml', data }]);

    expect(archive.byteLength).toBeLessThan(data.byteLength);
    const read = await readZipEntries(archive);
    expect(read.get('doc.xml')?.data.byteLength).toBe(data.byteLength);
  });

  it('uses the standard CRC-32 checksum', () => {
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});
