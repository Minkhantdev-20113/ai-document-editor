/**
 * Minimal ZIP reader (STORE + DEFLATE) built on the platform's native
 * `DecompressionStream`, so DOCX parsing needs no third-party dependency.
 * Only the central-directory fields required for extraction are parsed.
 *
 * {@link writeZipEntries} mirrors it for output (DOCX export), also using only
 * platform primitives (`CompressionStream`).
 */

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

/** One file to write into an archive. */
export interface ZipWriteEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT = 0xffff;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/** Reads all non-directory entries of a ZIP container. Throws on invalid data. */
export async function readZipEntries(bytes: Uint8Array): Promise<Map<string, ZipEntry>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // EOCD is at the end, optionally followed by a comment of up to 64 KB.
  let eocd = -1;
  const scanLimit = Math.max(0, bytes.byteLength - 22 - MAX_COMMENT);
  for (let index = bytes.byteLength - 22; index >= scanLimit; index -= 1) {
    if (index < 0) break;
    if (view.getUint32(index, true) === EOCD_SIGNATURE) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('Not a ZIP archive (end-of-central-directory not found)');
  }

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map<string, ZipEntry>();

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      break;
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) continue;
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) continue;
    const compressed = bytes.subarray(dataStart, dataEnd);

    let data: Uint8Array;
    if (method === 0) {
      data = compressed.slice();
    } else if (method === 8) {
      data = await inflateRaw(compressed);
    } else {
      continue; // Unsupported compression (e.g. bzip2): skip the entry.
    }
    entries.set(name, { name, data });
  }

  return entries;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[value] = crc >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE) of `data`; the checksum every ZIP entry records. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.byteLength; index += 1) {
    const byte = data[index] ?? 0;
    crc = ((CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface WrittenEntry {
  readonly nameBytes: Uint8Array;
  readonly checksum: number;
  readonly method: number;
  readonly compressed: Uint8Array;
  readonly size: number;
  readonly offset: number;
}

/**
 * Writes a ZIP archive (STORE or DEFLATE per entry, whichever is smaller).
 * Entries are stored in the given order, UTF-8 names are flagged, and the
 * result round-trips through {@link readZipEntries}.
 */
export async function writeZipEntries(entries: readonly ZipWriteEntry[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const written: WrittenEntry[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const checksum = crc32(entry.data);
    let method = 0;
    let payload = entry.data;

    if (entry.data.byteLength > 0) {
      const deflated = await deflateRaw(entry.data);
      if (deflated.byteLength < entry.data.byteLength) {
        method = 8;
        payload = deflated;
      }
    }

    const local = new Uint8Array(30 + nameBytes.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true); // version needed (deflate)
    localView.setUint16(6, 0x0800, true); // general purpose: UTF-8 names
    localView.setUint16(8, method, true);
    localView.setUint16(10, 0, true); // mod time
    localView.setUint16(12, 0x0021, true); // mod date (1980-01-01)
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, payload.byteLength, true);
    localView.setUint32(22, entry.data.byteLength, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    localView.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);

    localParts.push(local, payload);
    written.push({
      nameBytes,
      checksum,
      method,
      compressed: payload,
      size: entry.data.byteLength,
      offset,
    });
    offset += local.byteLength + payload.byteLength;
  }

  const centralParts: Uint8Array[] = [];
  let centralSize = 0;
  for (const entry of written) {
    const central = new Uint8Array(46 + entry.nameBytes.byteLength);
    const view = new DataView(central.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true); // version made by (MS-DOS)
    view.setUint16(6, 20, true); // version needed
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, entry.method, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0x0021, true);
    view.setUint32(16, entry.checksum, true);
    view.setUint32(20, entry.compressed.byteLength, true);
    view.setUint32(24, entry.size, true);
    view.setUint16(28, entry.nameBytes.byteLength, true);
    view.setUint16(30, 0, true); // extra length
    view.setUint16(32, 0, true); // comment length
    view.setUint16(34, 0, true); // disk number
    view.setUint16(36, 0, true); // internal attributes
    view.setUint32(38, 0, true); // external attributes
    view.setUint32(42, entry.offset, true);
    central.set(entry.nameBytes, 46);
    centralParts.push(central);
    centralSize += central.byteLength;
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true); // this disk
  eocdView.setUint16(6, 0, true); // disk with central directory
  eocdView.setUint16(8, written.length, true);
  eocdView.setUint16(10, written.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);
  eocdView.setUint16(20, 0, true); // comment length

  const parts = [...localParts, ...centralParts, eocd];
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const archive = new Uint8Array(total);
  let position = 0;
  for (const part of parts) {
    archive.set(part, position);
    position += part.byteLength;
  }
  return archive;
}
