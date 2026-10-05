/**
 * Secret redaction.
 *
 * Applied to every log record and every persisted error before it leaves the
 * app, so a raw API key can never end up in the console, IndexedDB, or an
 * error message.
 */

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bAIza[0-9A-Za-z_-]{10,}\b/g,
  /\bsk-[0-9A-Za-z_-]{16,}\b/g,
  /\bgsk_[0-9A-Za-z]{16,}\b/g,
  /\bsk-or-v1-[0-9a-f]{16,}\b/g,
  /\b(ghp|gho|ghu|ghs|github_pat)_[0-9A-Za-z]{16,}\b/g,
  /\bBearer\s+[0-9A-Za-z._~+/=-]{16,}\b/gi,
  /\b(x-goog-api-key|api[-_]?key|apikey|authorization|access[-_]?token|secret)\s*[=:]\s*["']?[^\s"',&]{8,}/gi,
];

const REDACTED = '[redacted]';

export function redactSecrets(value: string): string {
  let output = value;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, group: string | undefined) => {
      if (typeof group === 'string' && group.length > 0 && !match.startsWith(group)) {
        // Keep the field name so logs stay readable: "api_key=[redacted]".
        return match.slice(0, match.indexOf(group) + group.length) + '=' + REDACTED;
      }
      return REDACTED;
    });
  }
  return output;
}

/** Deterministic, non-reversible hint used for display only: `AIza••••abcd`. */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  const visibleStart = secret.slice(0, Math.min(4, Math.max(1, Math.floor(secret.length / 4))));
  const visibleEnd = secret.length > 8 ? secret.slice(-4) : '';
  return `${visibleStart}${'•'.repeat(8)}${visibleEnd}`;
}

/** Structured deep redaction for objects that are logged or persisted. */
export function deepRedact<T>(input: T): T {
  return deepRedactValue(input, 0) as T;
}

function deepRedactValue(input: unknown, depth: number): unknown {
  if (depth > 6) return '[depth-limit]';
  if (typeof input === 'string') return redactSecrets(input);
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((item) => deepRedactValue(item, depth + 1));
  if (input instanceof Error) return redactSecrets(`${input.name}: ${input.message}`);
  if (input instanceof Blob || input instanceof ArrayBuffer) return `[${input.constructor.name}]`;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = deepRedactValue(value, depth + 1);
  }
  return output;
}

function isSecretKey(key: string): boolean {
  return /key|token|secret|password|passphrase|credential|authorization/i.test(key);
}
