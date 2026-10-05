import { appEvents } from '../core/events/eventBus';
import { AppError } from '../core/errors/appError';
import { logger } from '../core/logging/logger';
import { apiKeysRepo, keyRuntimeRepo } from '../db/repositories';
import type { ApiKeyMetadata, KeyRuntime } from '../db/entities';
import { backoffDelayMs } from '../domain/provider/backoff';
import {
  selectKey,
  type KeyCandidate,
  type KeyRuntimeEvent,
} from '../domain/provider/keySelection';
import type { ErrorState } from '../domain/types';
import type {
  KeyFailure,
  KeyPoolRuntime,
  KeySelectionRequest,
  PoolExhaustion,
  PoolSelection,
  RateLimitState,
} from '../providers/aiProvider';
import { getProviderDescriptor } from '../providers/registry';
import type { ProviderId } from '../providers/types';
import { keyVault } from '../security/keyVault';
import { providerConfigService } from './providerConfigService';

/**
 * The multi-key failover pool (Phase 3).
 *
 * Responsibilities:
 * - persist per-key runtime (health, cooldowns, counters, rolling window),
 * - expose health-aware weighted `select` (never sequential rotation),
 * - record outcomes with class-specific cooldown policy,
 * - derive pool-level exhaustion so the engine can distinguish
 *   "wait a moment" (rate limit) from "Provider quota exhausted" (pause).
 *
 * Cooldown policy (deliberate):
 * - rate_limit:      Retry-After or jittered exponential backoff (max 5 min),
 * - quota:           >= 15 min, doubling per repeated hit (max 6 h) - the keys
 *                    share an upstream account, so cooling them individually
 *                    just walks the whole pool into the same wall,
 * - server_error:    jittered backoff from consecutive failures (max 5 min),
 * - auth:            health -> `invalid` (no cooldown; re-verify restores it),
 * - timeout/network/invalid_model/content_policy/rejected:
 *                    counters only - cooling a key cannot fix these.
 */

const MAX_EVENTS = 120;
const WINDOW_MS = 60_000;
const EVENT_MAX_AGE_MS = 10 * 60_000;

const RATE_LIMIT_BASE_MS = 5_000;
const RATE_LIMIT_MAX_MS = 5 * 60_000;
const QUOTA_BASE_MS = 15 * 60_000;
const QUOTA_MAX_MS = 6 * 60 * 60_000;
const SERVER_BASE_MS = 10_000;
const SERVER_MAX_MS = 5 * 60_000;
const DEGRADED_AFTER_FAILURES = 3;

export interface KeyPoolDeps {
  readonly random?: () => number;
  readonly now?: () => number;
}

function defaultRuntime(id: string, providerId: ProviderId): KeyRuntime {
  const timestamp = Date.now();
  return {
    id,
    providerId,
    enabled: true,
    health: 'healthy',
    cooldownUntil: 0,
    cooldownReason: null,
    lastUsedAt: null,
    requestCount: 0,
    tokenEstimate: 0,
    successfulRequests: 0,
    failedRequests: 0,
    rateLimitHits: 0,
    lastError: null,
    events: [],
    updatedAt: timestamp,
  };
}

function pruneEvents(events: readonly KeyRuntimeEvent[], now: number): KeyRuntimeEvent[] {
  const cutoff = now - EVENT_MAX_AGE_MS;
  const kept = events.filter((event) => event.at >= cutoff);
  return kept.slice(-MAX_EVENTS);
}

function windowEvents(events: readonly KeyRuntimeEvent[], now: number): KeyRuntimeEvent[] {
  const cutoff = now - WINDOW_MS;
  return events.filter((event) => event.at >= cutoff);
}

function consecutiveFailures(events: readonly KeyRuntimeEvent[]): number {
  let count = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.outcome === 'ok') break;
    count += 1;
  }
  return count;
}

function toErrorState(failure: KeyFailure): ErrorState {
  return {
    code: failure.error.code,
    message: failure.error.message,
    at: Date.now(),
    retryable: failure.error.retryable,
  };
}

class KeyPoolService implements KeyPoolRuntime {
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(deps: KeyPoolDeps = {}) {
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
  }

  /** Loads (and lazily creates) the runtime record for one key. */
  async ensure(keyId: string, providerId: ProviderId): Promise<KeyRuntime> {
    const existing = await keyRuntimeRepo.get(keyId);
    if (existing) return existing;
    const fresh = defaultRuntime(keyId, providerId);
    await keyRuntimeRepo.put(fresh);
    return fresh;
  }

  async list(providerId?: ProviderId): Promise<KeyRuntime[]> {
    const all = providerId
      ? ((await keyRuntimeRepo.queryByIndex('by_provider', providerId)) ?? [])
      : await keyRuntimeRepo.getAll();
    return all.sort((a, b) => a.id.localeCompare(b.id));
  }

  async setEnabled(keyId: string, enabled: boolean): Promise<void> {
    // loadRuntime (not raw get): the runtime row may not exist until the key
    // is first used, but toggling must work from the very first click.
    const runtime = await this.loadRuntime(keyId);
    if (!runtime) return;
    await keyRuntimeRepo.put({ ...runtime, enabled, updatedAt: this.now() });
    appEvents.emit('apiKeys:changed', {});
  }

  /** Clears cooldowns/stats pressure after a manual intervention. */
  async reset(keyId: string): Promise<void> {
    const runtime = await this.loadRuntime(keyId);
    if (!runtime) return;
    await keyRuntimeRepo.put({
      ...runtime,
      health: runtime.health === 'invalid' ? 'healthy' : runtime.health,
      cooldownUntil: 0,
      cooldownReason: null,
      updatedAt: this.now(),
    });
    appEvents.emit('apiKeys:changed', {});
  }

  // ------------------------------------------------------------- selection

  async select(request: KeySelectionRequest): Promise<PoolSelection> {
    const now = this.now();
    const config = await providerConfigService.ensure(request.providerId);
    const keys = (await apiKeysRepo.queryByIndex('by_provider', request.providerId)) ?? [];

    if (!config.enabled || keys.length === 0) {
      return {
        keyId: null,
        reason: 'no_candidates',
        rejections: [],
        nextAvailableAt: null,
        exhaustion: 'no_keys',
      };
    }

    const descriptor = getProviderDescriptor(request.providerId);
    const requestsPerMinute =
      config.rateLimitOverride?.requestsPerMinute ?? descriptor.rateLimit.requestsPerMinute ?? null;
    const tokensPerMinute =
      config.rateLimitOverride?.tokensPerMinute ?? descriptor.rateLimit.tokensPerMinute ?? null;
    // A per-account policy means a second key does NOT double the quota: the
    // window must be measured across every key of the provider.
    const sharedWindow = descriptor.rateLimit.basis === 'per-account';

    const runtimes = await Promise.all(keys.map((key) => this.ensure(key.id, request.providerId)));
    const runtimeById = new Map(runtimes.map((runtime) => [runtime.id, runtime]));

    let sharedRequests = 0;
    let sharedTokens = 0;
    if (sharedWindow) {
      for (const runtime of runtimes) {
        sharedRequests += windowEvents(runtime.events, now).length;
        sharedTokens += windowEvents(runtime.events, now).reduce((sum, event) => sum + event.tokens, 0);
      }
    }

    const candidates: KeyCandidate[] = keys.map((key) => {
      const runtime = runtimeById.get(key.id) ?? defaultRuntime(key.id, request.providerId);
      const events = windowEvents(runtime.events, now);
      const recentRateLimits = events.filter(
        (event) => event.outcome === 'rate_limit' || event.outcome === 'quota',
      ).length;
      const enabledModels = config.enabledModels;
      const supportsModel = enabledModels.length === 0 || enabledModels.includes(request.model);

      return {
        keyId: key.id,
        enabled: runtime.enabled,
        verification: key.status,
        health: runtime.health,
        cooldownUntil: runtime.cooldownUntil,
        cooldownReason: runtime.cooldownReason,
        lastUsedAt: runtime.lastUsedAt,
        recentFailures: consecutiveFailures(runtime.events),
        recentRateLimits,
        requestsInWindow: sharedWindow ? sharedRequests : events.length,
        tokensInWindow: sharedWindow ? sharedTokens : events.reduce((sum, event) => sum + event.tokens, 0),
        rpmLimit: requestsPerMinute,
        tpmLimit: tokensPerMinute,
        supportsModel,
        estimatedTokens: request.estimatedTokens,
      };
    });

    const selection = selectKey(candidates, { now, random: this.random });
    return {
      keyId: selection.keyId,
      reason: selection.reason,
      rejections: selection.rejections,
      nextAvailableAt: selection.nextAvailableAt,
      exhaustion: this.deriveExhaustion(keys, runtimes, selection.rejections, now),
    };
  }

  /**
   * Pool-level exhaustion: the engine distinguishes waiting (`rate_limited`)
   * from "Provider quota exhausted" (`quota` -> pause the job) from a
   * configuration problem (`invalid` / `no_keys` -> fail with a clear message).
   */
  private deriveExhaustion(
    keys: readonly ApiKeyMetadata[],
    runtimes: readonly KeyRuntime[],
    rejections: readonly { readonly keyId: string; readonly reason: string }[],
    now: number,
  ): PoolExhaustion {
    if (keys.length === 0) return 'no_keys';
    if (rejections.length === 0) return 'none';

    if (rejections.every((entry) => entry.reason === 'disabled')) return 'no_keys';
    if (rejections.every((entry) => entry.reason === 'verification_failed')) return 'invalid';

    const coolingIds = new Set(
      rejections.filter((entry) => entry.reason === 'cooling').map((entry) => entry.keyId),
    );
    const onlyWaitable = rejections.every(
      (entry) =>
        entry.reason === 'cooling' ||
        entry.reason === 'rpm_exhausted' ||
        entry.reason === 'tpm_exhausted',
    );
    if (onlyWaitable) {
      const coolingRuntimes = runtimes.filter(
        (runtime) => coolingIds.has(runtime.id) && runtime.cooldownUntil > now,
      );
      const allQuota =
        coolingRuntimes.length > 0 &&
        coolingRuntimes.every((runtime) => runtime.cooldownReason === 'quota') &&
        coolingIds.size === rejections.length;
      return allQuota ? 'quota' : 'rate_limited';
    }
    return 'none';
  }

  // -------------------------------------------------------------- outcomes

  async recordSuccess(keyId: string, outcome: { readonly tokens: number }): Promise<void> {
    const now = this.now();
    const runtime = await this.loadRuntime(keyId);
    if (!runtime) return;

    const event: KeyRuntimeEvent = { at: now, tokens: outcome.tokens, outcome: 'ok' };
    await keyRuntimeRepo.put({
      ...runtime,
      health: 'healthy', // a successful call is direct evidence the key works
      cooldownUntil: 0,
      cooldownReason: null,
      lastUsedAt: now,
      requestCount: runtime.requestCount + 1,
      tokenEstimate: runtime.tokenEstimate + outcome.tokens,
      successfulRequests: runtime.successfulRequests + 1,
      events: pruneEvents([...runtime.events, event], now),
      updatedAt: now,
    });
    appEvents.emit('apiKeys:changed', {});
  }

  async recordFailure(keyId: string, failure: KeyFailure): Promise<void> {
    const now = this.now();
    const runtime = await this.loadRuntime(keyId);
    if (!runtime) return;

    const event: KeyRuntimeEvent = {
      at: now,
      tokens: failure.tokens,
      outcome:
        failure.errorClass === 'rate_limit'
          ? 'rate_limit'
          : failure.errorClass === 'quota_exceeded'
            ? 'quota'
            : 'error',
    };
    const events = pruneEvents([...runtime.events, event], now);
    const window = windowEvents(events, now);
    const failures = consecutiveFailures(events);

    let health = runtime.health;
    let cooldownUntil = runtime.cooldownUntil;
    let cooldownReason = runtime.cooldownReason;
    let rateLimitHits = runtime.rateLimitHits;

    switch (failure.errorClass) {
      case 'rate_limit': {
        rateLimitHits += 1;
        const backoff = backoffDelayMs({
          attempt: Math.min(rateLimitHits, 6),
          baseMs: RATE_LIMIT_BASE_MS,
          maxMs: RATE_LIMIT_MAX_MS,
          random: this.random,
        });
        cooldownUntil = now + Math.max(failure.retryAfterMs ?? 0, backoff);
        cooldownReason = 'rate_limit';
        break;
      }
      case 'quota_exceeded': {
        rateLimitHits += 1;
        const quotaHits = window.filter((entry) => entry.outcome === 'quota').length;
        const escalation = Math.min(Math.max(quotaHits - 1, 0), 4); // x1,2,4,8,16
        const requested = failure.retryAfterMs ?? 0;
        const cooldown = Math.min(Math.max(QUOTA_BASE_MS * 2 ** escalation, requested), QUOTA_MAX_MS);
        cooldownUntil = now + cooldown;
        cooldownReason = 'quota';
        break;
      }
      case 'server_error': {
        const delay = backoffDelayMs({
          attempt: Math.min(failures, 6),
          baseMs: SERVER_BASE_MS,
          maxMs: SERVER_MAX_MS,
          random: this.random,
        });
        cooldownUntil = now + delay;
        cooldownReason = 'server_error';
        if (failures >= DEGRADED_AFTER_FAILURES) health = 'degraded';
        break;
      }
      case 'auth': {
        // The key itself is rejected: gate it via health, not a timer.
        health = 'invalid';
        cooldownUntil = 0;
        cooldownReason = 'auth';
        break;
      }
      default:
        // timeout / network / invalid_model / content_policy / rejected:
        // counters only. Cooling the key cannot fix any of these.
        break;
    }

    await keyRuntimeRepo.put({
      ...runtime,
      health,
      cooldownUntil,
      cooldownReason,
      rateLimitHits,
      requestCount: runtime.requestCount + 1,
      failedRequests: runtime.failedRequests + 1,
      lastError: toErrorState(failure),
      events,
      updatedAt: now,
    });
    logger.warn('Key pool recorded a failure', {
      keyId,
      providerId: runtime.providerId,
      errorClass: failure.errorClass,
      code: failure.error.code,
      cooldownUntil,
      cooldownReason,
      // Never the key itself: only its id, class and typed code.
    });
    appEvents.emit('apiKeys:changed', {});
  }

  async retrieveSecret(keyId: string): Promise<string | null> {
    await keyVault.ready();
    return keyVault.retrieveSecret(keyId);
  }

  async rateLimitState(providerId: ProviderId, keyId?: string): Promise<RateLimitState> {
    const now = this.now();
    const keys = (await apiKeysRepo.queryByIndex('by_provider', providerId)) ?? [];
    const runtimes = await Promise.all(keys.map((key) => this.ensure(key.id, providerId)));

    const cooling = runtimes.filter((runtime) => runtime.cooldownUntil > now);
    const invalid = runtimes.filter(
      (runtime, index) =>
        runtime.health === 'invalid' ||
        keys[index]?.status === 'invalid' ||
        keys[index]?.status === 'revoked',
    );
    const enabled = runtimes.filter((runtime) => runtime.enabled);
    const eligible = enabled.filter(
      (runtime) => runtime.cooldownUntil <= now && runtime.health !== 'invalid',
    );
    const nextAvailableAt =
      cooling.length > 0 ? Math.min(...cooling.map((runtime) => runtime.cooldownUntil)) : null;

    let exhaustion: PoolExhaustion = 'none';
    if (keys.length === 0 || enabled.length === 0) {
      exhaustion = 'no_keys';
    } else if (eligible.length === 0 && cooling.length > 0) {
      exhaustion = cooling.every((runtime) => runtime.cooldownReason === 'quota') ? 'quota' : 'rate_limited';
    } else if (eligible.length === 0 && invalid.length === keys.length) {
      exhaustion = 'invalid';
    }

    const focus = keyId ? runtimes.find((runtime) => runtime.id === keyId) : undefined;
    return {
      providerId,
      keyId: keyId ?? null,
      health: focus ? focus.health : null,
      cooldownUntil: focus?.cooldownUntil ?? 0,
      cooldownReason: focus?.cooldownReason ?? null,
      keys: {
        total: keys.length,
        enabled: enabled.length,
        eligible: eligible.length,
        cooling: cooling.length,
        invalid: invalid.length,
      },
      exhaustion,
      nextAvailableAt,
      checkedAt: now,
    };
  }

  /** True when every usable key of the provider is cooling on shared quota. */
  async isQuotaExhausted(providerId: ProviderId): Promise<boolean> {
    const state = await this.rateLimitState(providerId);
    return state.exhaustion === 'quota';
  }

  private async loadRuntime(keyId: string): Promise<KeyRuntime | null> {
    const existing = await keyRuntimeRepo.get(keyId);
    if (existing) return existing;
    const metadata = await apiKeysRepo.get(keyId);
    if (!metadata) return null;
    const fresh = defaultRuntime(keyId, metadata.providerId);
    await keyRuntimeRepo.put(fresh);
    return fresh;
  }
}

export { KeyPoolService };
export const keyPoolService = new KeyPoolService();

/** Convenience: throws `AppError` when a provider has no usable keys at all. */
export async function requireProviderUsable(providerId: ProviderId): Promise<void> {
  const state = await keyPoolService.rateLimitState(providerId);
  if (state.exhaustion === 'no_keys') {
    throw new AppError('No API keys are configured for this provider', {
      code: 'provider_unavailable',
      retryable: false,
    });
  }
}
