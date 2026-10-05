/** Generates collision-resistant identifiers without external dependencies. */
export function newId(prefix?: string): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : fallbackUuid();
  return prefix ? `${prefix}_${uuid}` : uuid;
}

function fallbackUuid(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Short, human-friendly identifier for lists and logs. */
export function shortId(id: string): string {
  const cleaned = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
  return cleaned.slice(0, 8);
}
