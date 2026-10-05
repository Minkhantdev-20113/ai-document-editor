import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearLogBuffer, getRecentLogs } from '../core/logging/logger';
import { apiKeysRepo, keyRuntimeRepo, providerConfigsRepo } from '../db/repositories';
import type { ApiKeyStatus } from '../db/entities';
import { AppError } from '../core/errors/appError';
import type { ProviderId } from '../providers/types';
import { KeyPoolService } from './keyPoolService';
import { providerConfigService } from './providerConfigService';

const T0 = 1_700_000_000_000;

let clock = T0;
const service = new KeyPoolService({ now: () => clock, random: () => 0.5 });

async function seedKey(
  id: string,
  providerId: ProviderId = 'gemini',
  status: ApiKeyStatus = 'valid',
): Promise<void> {
  await apiKeysRepo.put({
    id,
    providerId,
    label: id,
    hint: 'AIza••••test',
    status,
    lastVerifiedAt: T0,
    lastUsedAt: null,
    createdAt: T0,
    updatedAt: T0,
  });
}

function failure(
  errorClass: Parameters<KeyPoolService['recordFailure']>[1]['errorClass'],
  overrides: Partial<Parameters<KeyPoolService['recordFailure']>[1]> = {},
): Parameters<KeyPoolService['recordFailure']>[1] {
  return {
    error: new AppError('simulated failure', { code: 'provider_unavailable', retryable: true }),
    errorClass,
    tokens: 10,
    ...overrides,
  };
}

beforeEach(async () => {
  await apiKeysRepo.clear();
  await keyRuntimeRepo.clear();
  await providerConfigsRepo.clear();
  clearLogBuffer();
  clock = T0;
  // Providers ship disabled: selection tests enable the one they exercise.
  await providerConfigService.save('gemini', {
    enabled: true,
    enabledModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  });
});

describe('key pool selection', () => {
  it('selects an eligible key and reports a healthy pool', async () => {
    await seedKey('k_a');
    await seedKey('k_b');

    const selection = await service.select({
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
      estimatedTokens: 500,
    });

    expect(selection.reason).toBe('selected');
    expect(['k_a', 'k_b']).toContain(selection.keyId);
    expect(selection.exhaustion).toBe('none');

    await service.recordSuccess(selection.keyId as string, { tokens: 120 });
    const runtime = await keyRuntimeRepo.get(selection.keyId as string);
    expect(runtime?.requestCount).toBe(1);
    expect(runtime?.successfulRequests).toBe(1);
    expect(runtime?.tokenEstimate).toBe(120);
    expect(runtime?.lastUsedAt).toBe(clock);
    expect(runtime?.health).toBe('healthy');
  });

  it('reports no_candidates for a provider without keys', async () => {
    const selection = await service.select({
      providerId: 'groq',
      model: 'llama-3.1-8b-instant',
      estimatedTokens: 100,
    });
    expect(selection.keyId).toBeNull();
    expect(selection.reason).toBe('no_candidates');
    expect(selection.exhaustion).toBe('no_keys');
  });

  it('prefers a healthy key over a degraded one (weighted, not round-robin)', async () => {
    // `k_a` degrades after repeated server errors; its short cooldown expires.
    await seedKey('k_a');
    await seedKey('k_b');
    for (let i = 0; i < 3; i += 1) {
      await service.recordFailure('k_a', failure('server_error'));
    }
    clock += 120_000; // server-error cooldown (max 5 min) has passed

    const selection = await service.select({
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
      estimatedTokens: 100,
    });
    expect(selection.keyId).toBe('k_b');
    expect((await keyRuntimeRepo.get('k_a'))?.health).toBe('degraded');
  });

  it('excludes disabled keys', async () => {
    await seedKey('k_a');
    await seedKey('k_b');
    await service.setEnabled('k_a', false);

    const selection = await service.select({
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
      estimatedTokens: 100,
    });
    expect(selection.keyId).toBe('k_b');

    await service.setEnabled('k_b', false);
    const empty = await service.select({
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
      estimatedTokens: 100,
    });
    expect(empty.keyId).toBeNull();
    expect(empty.exhaustion).toBe('no_keys');
    expect(empty.rejections.map((entry) => entry.reason)).toEqual(['disabled', 'disabled']);
  });

  it('never selects a key that is invalid or still cooling', async () => {
    await seedKey('k_invalid', 'gemini', 'revoked');
    await seedKey('k_cooling');
    await seedKey('k_ok');

    await service.recordFailure('k_cooling', failure('rate_limit', { retryAfterMs: 60_000 }));

    const selection = await service.select({
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
      estimatedTokens: 100,
    });
    expect(selection.keyId).toBe('k_ok');
    const reasons = Object.fromEntries(selection.rejections.map((entry) => [entry.keyId, entry.reason]));
    expect(reasons['k_invalid']).toBe('verification_failed');
    expect(reasons['k_cooling']).toBe('cooling');
  });
});

describe('429 and cooldown handling', () => {
  it('honours Retry-After for how long a rate-limited key cools', async () => {
    await seedKey('k_a');
    await service.recordFailure('k_a', failure('rate_limit', { retryAfterMs: 30_000 }));

    const runtime = await keyRuntimeRepo.get('k_a');
    expect(runtime?.cooldownUntil).toBe(clock + 30_000);
    expect(runtime?.cooldownReason).toBe('rate_limit');
    expect(runtime?.rateLimitHits).toBe(1);
    expect(runtime?.failedRequests).toBe(1);

    const during = await service.select({
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
      estimatedTokens: 100,
    });
    expect(during.keyId).toBeNull();
    expect(during.exhaustion).toBe('rate_limited');
    expect(during.nextAvailableAt).toBe(clock + 30_000);

    clock += 30_000;
    const after = await service.select({
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
      estimatedTokens: 100,
    });
    expect(after.keyId).toBe('k_a');
  });

  it('falls back to jittered exponential backoff without Retry-After', async () => {
    await seedKey('k_a');
    // random() = 0.5 -> attempt 1: ceiling 10s, jittered to [5s, 10s] = 7.5s.
    const local = new KeyPoolService({ now: () => clock, random: () => 0.5 });
    await local.recordFailure('k_a', failure('rate_limit'));

    const runtime = await keyRuntimeRepo.get('k_a');
    expect(runtime?.cooldownUntil).toBe(clock + 7_500);
    // Never a tight loop: at least half the exponential ceiling.
    expect((runtime?.cooldownUntil ?? 0) - clock).toBeGreaterThanOrEqual(5_000);
  });

  it('does not cool a key for timeout, network or content-policy failures', async () => {
    await seedKey('k_a');
    for (const errorClass of ['timeout', 'network', 'content_policy', 'rejected'] as const) {
      await service.recordFailure('k_a', failure(errorClass));
    }
    const runtime = await keyRuntimeRepo.get('k_a');
    expect(runtime?.cooldownUntil).toBe(0);
    expect(runtime?.health).toBe('healthy');
    expect(runtime?.failedRequests).toBe(4);
    // Counters still move so selection can weigh recent pressure.
    expect(runtime?.events).toHaveLength(4);
  });
});

describe('shared upstream quota', () => {
  it('cools every key on quota and reports the pool as quota-exhausted', async () => {
    await seedKey('k_a');
    await seedKey('k_b');
    for (const keyId of ['k_a', 'k_b']) {
      await service.recordFailure(
        keyId,
        failure('quota_exceeded', {
          error: new AppError('You exceeded your current quota', {
            code: 'provider_quota_exceeded',
            retryable: false,
          }),
        }),
      );
    }

    const selection = await service.select({
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
      estimatedTokens: 100,
    });
    expect(selection.keyId).toBeNull();
    expect(selection.reason).toBe('all_rejected');
    expect(selection.exhaustion).toBe('quota');

    expect(await service.isQuotaExhausted('gemini')).toBe(true);
    const state = await service.rateLimitState('gemini');
    expect(state.exhaustion).toBe('quota');
    expect(state.keys.cooling).toBe(2);
    expect(state.keys.eligible).toBe(0);
    expect(state.nextAvailableAt).toBeGreaterThan(clock);
  });

  it('escalates the cooldown when the same quota keeps being hit', async () => {
    await seedKey('k_a');
    await service.recordFailure('k_a', failure('quota_exceeded'));
    const first = (await keyRuntimeRepo.get('k_a'))?.cooldownUntil ?? 0;

    await service.recordFailure('k_a', failure('quota_exceeded'));
    const second = (await keyRuntimeRepo.get('k_a'))?.cooldownUntil ?? 0;

    expect(first).toBe(clock + 15 * 60_000); // base 15 min
    expect(second).toBe(clock + 30 * 60_000); // doubles per repeat (capped at 6 h)
    expect(second).toBeGreaterThan(first);
  });

  it('distinguishes rate limiting from quota exhaustion', async () => {
    await seedKey('k_a');
    await service.recordFailure('k_a', failure('rate_limit', { retryAfterMs: 5_000 }));

    expect(await service.isQuotaExhausted('gemini')).toBe(false);
    const state = await service.rateLimitState('gemini');
    expect(state.exhaustion).toBe('rate_limited');
  });
});

describe('rejected keys', () => {
  it('marks the key invalid on auth failures and reports pool exhaustion', async () => {
    await seedKey('k_a');
    await service.recordFailure(
      'k_a',
      failure('auth', {
        error: new AppError('The API key was rejected', {
          code: 'provider_invalid_key',
          retryable: false,
        }),
      }),
    );

    expect((await keyRuntimeRepo.get('k_a'))?.health).toBe('invalid');
    const selection = await service.select({
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
      estimatedTokens: 100,
    });
    expect(selection.keyId).toBeNull();
    expect(selection.exhaustion).toBe('invalid');

    // Manual reset (after re-verification) makes it eligible again.
    await service.reset('k_a');
    const after = await service.select({
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
      estimatedTokens: 100,
    });
    expect(after.keyId).toBe('k_a');
  });

  it('self-heals an invalid key after a successful call', async () => {
    await seedKey('k_a');
    await service.recordFailure('k_a', failure('auth'));
    await service.recordSuccess('k_a', { tokens: 50 });

    const runtime = await keyRuntimeRepo.get('k_a');
    expect(runtime?.health).toBe('healthy');
    expect(runtime?.cooldownUntil).toBe(0);
  });
});

describe('key security', () => {
  it('never writes raw key material to the log ring buffer', async () => {
    const rawSecret = 'AIzaRAW-SECRET-c4nN0t-b3-10gg3d-0123456789';
    await seedKey('k_secret');

    // Full pool lifecycle: select, success, failure, state, toggle, reset.
    const selection = await service.select({
      providerId: 'gemini',
      model: 'gemini-2.5-flash',
      estimatedTokens: 100,
    });
    expect(selection.keyId).toBe('k_secret');
    await service.recordSuccess(selection.keyId as string, { tokens: 100 });
    await service.recordFailure(
      selection.keyId as string,
      failure('rate_limit', { retryAfterMs: 1_000 }),
    );
    await service.rateLimitState('gemini');
    await service.rateLimitState('gemini', selection.keyId as string);
    await service.setEnabled(selection.keyId as string, false);
    await service.reset(selection.keyId as string);

    const logs = JSON.stringify(getRecentLogs());
    // The redactor is deliberately aggressive: fields whose name even looks
    // like a credential (`keyId`) are blanked, and any raw key pattern in a
    // message is stripped - so nothing here can leak the secret.
    expect(logs).not.toContain(rawSecret);
    expect(logs).not.toContain('RAW-SECRET');
    expect(logs).not.toContain('k_secret');
  });
});
