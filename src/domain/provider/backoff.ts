/**
 * Exponential backoff with equal jitter.
 *
 * Used for provider-level retries (429, 5xx, timeout). Two properties matter:
 * - a random half of the delay prevents a tight retry loop that would burn
 *   quota faster, and
 * - the random half also spreads concurrent workers apart (no thundering herd).
 *
 * Pure and injectable: `random` and all timings are parameters, so tests are
 * deterministic without timers.
 */
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_MAX_MS = 60_000;

export interface BackoffOptions {
  /** 0-based attempt number of the failed try. */
  readonly attempt: number;
  readonly baseMs?: number;
  readonly maxMs?: number;
  /** Returns a value in [0, 1). Defaults to Math.random. */
  readonly random?: () => number;
}

export function backoffDelayMs(options: BackoffOptions): number {
  const random = options.random ?? Math.random;
  const base = options.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const max = options.maxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const attempt = Math.min(Math.max(0, Math.floor(options.attempt)), 30);
  const ceiling = Math.min(max, base * 2 ** attempt);
  // Equal jitter: half fixed, half random. The result is always >= ceiling / 2,
  // so consecutive attempts can never collapse into a tight loop.
  const jittered = ceiling / 2 + random() * (ceiling / 2);
  return Math.max(1, Math.round(jittered));
}
