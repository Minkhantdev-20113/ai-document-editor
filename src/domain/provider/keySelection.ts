/**
 * Health-aware weighted key selection.
 *
 * The historical failure this replaces: sequential round-robin across keys.
 * That looks like it multiplies quota, but provider limits often sit at the
 * project/account/model level - rotating keys then just walks every key into
 * the same shared wall at maximum speed.
 *
 * Selection instead:
 *  1. hard-gates unusable keys (disabled, invalid, cooling, unsupported model,
 *     locally known RPM/TPM windows exhausted), and
 *  2. weights the remaining candidates by health, verification, recent
 *     failures, recent 429s, remaining rate-limit headroom and idle time, then
 *     samples randomly.
 *
 * The random sample (instead of "pick the best") keeps load spread across
 * independent keys while making bad keys proportionally rarer - so one
 * exhausted key cannot dominate, and the pool never thrashes in lockstep.
 */
import type { ErrorState } from '../types';

export type KeyHealth = 'healthy' | 'degraded' | 'cooling' | 'invalid';

/** Why a key is temporarily (or, for `auth`, effectively) unusable. */
export type CooldownReason = 'rate_limit' | 'quota' | 'server_error' | 'auth' | 'manual';

export type KeyVerification = 'unverified' | 'valid' | 'invalid' | 'revoked';

export interface KeyRuntimeEvent {
  readonly at: number;
  readonly tokens: number;
  readonly outcome: 'ok' | 'error' | 'rate_limit' | 'quota';
}

/**
 * Persisted per-key runtime state (mirrored by the `keyRuntime` store).
 * Lives in the domain so selection, persistence and UI share one shape.
 */
export interface KeyRuntimeState {
  readonly id: string;
  readonly providerId: string;
  readonly enabled: boolean;
  readonly health: KeyHealth;
  readonly cooldownUntil: number;
  readonly cooldownReason: CooldownReason | null;
  readonly lastUsedAt: number | null;
  readonly requestCount: number;
  readonly tokenEstimate: number;
  readonly successfulRequests: number;
  readonly failedRequests: number;
  readonly rateLimitHits: number;
  readonly lastError: ErrorState | null;
  /** Rolling window of the most recent outcomes (capped), newest last. */
  readonly events: readonly KeyRuntimeEvent[];
  readonly updatedAt: number;
}

/** The view of one key that selection needs. Derived from runtime + config. */
export interface KeyCandidate {
  readonly keyId: string;
  readonly enabled: boolean;
  readonly verification: KeyVerification;
  readonly health: KeyHealth;
  readonly cooldownUntil: number;
  readonly cooldownReason: CooldownReason | null;
  readonly lastUsedAt: number | null;
  /** Failures since the last success (consecutive failure pressure). */
  readonly recentFailures: number;
  /** 429/quota hits in the rolling window. */
  readonly recentRateLimits: number;
  readonly requestsInWindow: number;
  readonly tokensInWindow: number;
  /** Known/observed limits; `null` means unknown (never assumed). */
  readonly rpmLimit: number | null;
  readonly tpmLimit: number | null;
  /** Whether the key's provider/model config can serve the requested model. */
  readonly supportsModel: boolean;
  readonly estimatedTokens: number;
}

export interface SelectionContext {
  readonly now: number;
  /** Returns a value in [0, 1). Injectable for deterministic tests. */
  readonly random?: () => number;
}

export type SelectionRejection =
  | 'disabled'
  | 'verification_failed'
  | 'cooling'
  | 'unsupported_model'
  | 'rpm_exhausted'
  | 'tpm_exhausted';

export interface KeySelection {
  /** Chosen key, or `null` when nothing is eligible right now. */
  readonly keyId: string | null;
  readonly reason: 'selected' | 'no_candidates' | 'all_rejected';
  /** Scored weights of eligible candidates (diagnostics + tests). */
  readonly weights: Readonly<Record<string, number>>;
  readonly rejections: readonly { readonly keyId: string; readonly reason: SelectionRejection }[];
  /** When the earliest cooling key becomes eligible again; `null` if none. */
  readonly nextAvailableAt: number | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Gate a key: returns the rejection reason, or `null` when it may be scored. */
export function rejectionReason(candidate: KeyCandidate, now: number): SelectionRejection | null {
  if (!candidate.enabled) return 'disabled';
  if (candidate.verification === 'invalid' || candidate.verification === 'revoked') return 'verification_failed';
  if (candidate.health === 'invalid') return 'verification_failed';
  if (candidate.cooldownUntil > now) return 'cooling';
  if (!candidate.supportsModel) return 'unsupported_model';
  if (candidate.rpmLimit !== null && candidate.requestsInWindow >= candidate.rpmLimit) return 'rpm_exhausted';
  if (candidate.tpmLimit !== null && candidate.tokensInWindow + candidate.estimatedTokens > candidate.tpmLimit) {
    return 'tpm_exhausted';
  }
  return null;
}

/** Score of an eligible candidate. Exported for tests and UI explanations. */
export function candidateWeight(candidate: KeyCandidate, now: number): number {
  const healthFactor = candidate.health === 'healthy' ? 1 : candidate.health === 'degraded' ? 0.35 : 0.15;
  const verificationFactor = candidate.verification === 'valid' ? 1.25 : 0.6;
  // Recent failures and 429s shrink the key's share instead of removing it -
  // the pool degrades gracefully rather than flapping between extremes.
  const failureFactor = 1 / (1 + 0.5 * candidate.recentFailures + 0.75 * candidate.recentRateLimits);

  let rpmHeadroom = 1;
  if (candidate.rpmLimit !== null && candidate.rpmLimit > 0) {
    rpmHeadroom = clamp(1 - candidate.requestsInWindow / candidate.rpmLimit, 0, 1);
    rpmHeadroom = 0.3 + 0.7 * rpmHeadroom;
  }
  let tpmHeadroom = 1;
  if (candidate.tpmLimit !== null && candidate.tpmLimit > 0) {
    const remaining = clamp(
      (candidate.tpmLimit - candidate.tokensInWindow - candidate.estimatedTokens) / candidate.tpmLimit,
      0,
      1,
    );
    tpmHeadroom = 0.3 + 0.7 * remaining;
  }

  // Least-recently-used boost: idle keys get up to +50%, which spreads requests
  // across independent keys without ever becoming strict round-robin.
  const idleMs = candidate.lastUsedAt === null ? Number.POSITIVE_INFINITY : Math.max(0, now - candidate.lastUsedAt);
  const idleFactor = 1 + 0.5 * clamp(idleMs / 300_000, 0, 1);

  return healthFactor * verificationFactor * failureFactor * rpmHeadroom * tpmHeadroom * idleFactor;
}

/**
 * Selects one key from the candidates.
 *
 * `keyId: null` with `reason` tells the caller what happened:
 * - `no_candidates`: nothing was offered (no keys configured),
 * - `all_rejected`: keys exist but none may be used right now -
 *   `rejections` and `nextAvailableAt` say why and when to check back.
 */
export function selectKey(candidates: readonly KeyCandidate[], context: SelectionContext): KeySelection {
  const random = context.random ?? Math.random;
  const now = context.now;

  if (candidates.length === 0) {
    return { keyId: null, reason: 'no_candidates', weights: {}, rejections: [], nextAvailableAt: null };
  }

  const weights: Record<string, number> = {};
  const rejections: { keyId: string; reason: SelectionRejection }[] = [];
  const eligible: { readonly keyId: string; readonly weight: number }[] = [];
  let nextAvailableAt: number | null = null;

  for (const candidate of candidates) {
    const rejection = rejectionReason(candidate, now);
    if (rejection) {
      rejections.push({ keyId: candidate.keyId, reason: rejection });
      if (rejection === 'cooling') {
        nextAvailableAt =
          nextAvailableAt === null ? candidate.cooldownUntil : Math.min(nextAvailableAt, candidate.cooldownUntil);
      }
      continue;
    }
    const weight = Math.max(candidateWeight(candidate, now), 1e-6);
    weights[candidate.keyId] = weight;
    eligible.push({ keyId: candidate.keyId, weight });
  }

  if (eligible.length === 0) {
    return { keyId: null, reason: 'all_rejected', weights, rejections, nextAvailableAt };
  }

  const total = eligible.reduce((sum, entry) => sum + entry.weight, 0);
  const threshold = random() * total;
  let cumulative = 0;
  let picked: string | null = null;
  for (const entry of eligible) {
    cumulative += entry.weight;
    if (cumulative >= threshold) {
      picked = entry.keyId;
      break;
    }
  }
  if (picked === null) picked = eligible[eligible.length - 1]?.keyId ?? null;
  if (picked === null) {
    return { keyId: null, reason: 'all_rejected', weights, rejections, nextAvailableAt };
  }

  return { keyId: picked, reason: 'selected', weights, rejections, nextAvailableAt };
}
