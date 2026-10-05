import { describe, expect, it } from 'vitest';
import {
  candidateWeight,
  rejectionReason,
  selectKey,
  type KeyCandidate,
} from './keySelection';

const NOW = 1_700_000_000_000;

function candidate(overrides: Partial<KeyCandidate> & { keyId: string }): KeyCandidate {
  return {
    enabled: true,
    verification: 'valid',
    health: 'healthy',
    cooldownUntil: 0,
    cooldownReason: null,
    lastUsedAt: null,
    recentFailures: 0,
    recentRateLimits: 0,
    requestsInWindow: 0,
    tokensInWindow: 0,
    rpmLimit: null,
    tpmLimit: null,
    supportsModel: true,
    estimatedTokens: 0,
    ...overrides,
  };
}

/** Deterministic PRNG so distribution tests are stable. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('key gating', () => {
  it('rejects each unusable state with a specific reason', () => {
    expect(rejectionReason(candidate({ keyId: 'k', enabled: false }), NOW)).toBe('disabled');
    expect(rejectionReason(candidate({ keyId: 'k', verification: 'revoked' }), NOW)).toBe('verification_failed');
    expect(rejectionReason(candidate({ keyId: 'k', health: 'invalid' }), NOW)).toBe('verification_failed');
    expect(rejectionReason(candidate({ keyId: 'k', cooldownUntil: NOW + 1 }), NOW)).toBe('cooling');
    expect(rejectionReason(candidate({ keyId: 'k', supportsModel: false }), NOW)).toBe('unsupported_model');
    expect(rejectionReason(candidate({ keyId: 'k', rpmLimit: 10, requestsInWindow: 10 }), NOW)).toBe(
      'rpm_exhausted',
    );
    expect(
      rejectionReason(candidate({ keyId: 'k', tpmLimit: 1_000, tokensInWindow: 900, estimatedTokens: 200 }), NOW),
    ).toBe('tpm_exhausted');
    expect(rejectionReason(candidate({ keyId: 'k' }), NOW)).toBeNull();
  });

  it('treats a cooldown that just expired as eligible', () => {
    expect(rejectionReason(candidate({ keyId: 'k', cooldownUntil: NOW }), NOW)).toBeNull();
  });

  it('allows an unverified key but scores it below a verified one', () => {
    const unverified = candidate({ keyId: 'k', verification: 'unverified' });
    const valid = candidate({ keyId: 'k', verification: 'valid' });
    expect(candidateWeight(unverified, NOW)).toBeLessThan(candidateWeight(valid, NOW));
  });
});

describe('selectKey', () => {
  it('reports no_candidates when the pool is empty', () => {
    const selection = selectKey([], { now: NOW });
    expect(selection.keyId).toBeNull();
    expect(selection.reason).toBe('no_candidates');
  });

  it('reports all_rejected with reasons and the earliest cooldown time', () => {
    const selection = selectKey(
      [
        candidate({ keyId: 'a', cooldownUntil: NOW + 60_000, cooldownReason: 'quota' }),
        candidate({ keyId: 'b', cooldownUntil: NOW + 5_000, cooldownReason: 'rate_limit' }),
        candidate({ keyId: 'c', enabled: false }),
      ],
      { now: NOW },
    );
    expect(selection.keyId).toBeNull();
    expect(selection.reason).toBe('all_rejected');
    expect(selection.rejections.map((entry) => entry.reason)).toEqual(['cooling', 'cooling', 'disabled']);
    expect(selection.nextAvailableAt).toBe(NOW + 5_000);
  });

  it('never selects a gated key', () => {
    const selection = selectKey(
      [
        candidate({ keyId: 'bad', verification: 'invalid' }),
        candidate({ keyId: 'cooling', cooldownUntil: NOW + 1_000 }),
        candidate({ keyId: 'good' }),
      ],
      { now: NOW, random: () => 0.999999 },
    );
    expect(selection.keyId).toBe('good');
  });

  it('weights heavily toward healthy keys instead of rotating evenly (not round-robin)', () => {
    const healthy = Array.from({ length: 9 }, (_, index) =>
      candidate({ keyId: `healthy-${index}`, lastUsedAt: NOW - 600_000 }),
    );
    const degraded = candidate({ keyId: 'degraded', health: 'degraded', lastUsedAt: NOW - 600_000 });
    const random = mulberry32(1234);

    let degradedPicks = 0;
    const iterations = 2_000;
    for (let i = 0; i < iterations; i += 1) {
      const selection = selectKey([...healthy, degraded], { now: NOW, random });
      if (selection.keyId === 'degraded') degradedPicks += 1;
    }
    // Even share would be 10%; weighted scheduling must keep the degraded key
    // clearly below that while still occasionally using it.
    expect(degradedPicks / iterations).toBeLessThan(0.05);
    expect(degradedPicks / iterations).toBeGreaterThan(0);
  });

  it('spreads load across equal keys rather than hammering one', () => {
    const random = mulberry32(99);
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 3_000; i += 1) {
      const selection = selectKey(
        [candidate({ keyId: 'a' }), candidate({ keyId: 'b' }), candidate({ keyId: 'c' })],
        { now: NOW, random },
      );
      const bucket = selection.keyId ?? 'none';
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    for (const count of Object.values(counts)) {
      expect(count).toBeGreaterThan(700); // ~1000 each; never starved
      expect(count).toBeLessThan(1_400); // never dominant either
    }
  });

  it('reduces weight after recent failures and recent 429s', () => {
    const fresh = candidateWeight(candidate({ keyId: 'k' }), NOW);
    const failing = candidateWeight(candidate({ keyId: 'k', recentFailures: 3 }), NOW);
    const limited = candidateWeight(candidate({ keyId: 'k', recentRateLimits: 2 }), NOW);
    expect(failing).toBeLessThan(fresh);
    expect(limited).toBeLessThan(fresh);
    expect(limited).toBeLessThan(candidateWeight(candidate({ keyId: 'k', recentFailures: 2 }), NOW));
  });

  it('respects known RPM/TPM headroom in the score', () => {
    const idle = candidateWeight(
      candidate({ keyId: 'k', rpmLimit: 60, requestsInWindow: 0, lastUsedAt: NOW }),
      NOW,
    );
    const nearlyFull = candidateWeight(
      candidate({ keyId: 'k', rpmLimit: 60, requestsInWindow: 55, lastUsedAt: NOW }),
      NOW,
    );
    expect(nearlyFull).toBeLessThan(idle);
  });

  it('prefers the least recently used key when everything else is equal', () => {
    const justUsed = candidateWeight(candidate({ keyId: 'k', lastUsedAt: NOW - 60_000 }), NOW);
    const neverUsed = candidateWeight(candidate({ keyId: 'k', lastUsedAt: null }), NOW);
    expect(neverUsed).toBeGreaterThan(justUsed);
  });

  it('selects the only eligible key regardless of the random draw', () => {
    for (const draw of [0, 0.5, 0.999999]) {
      expect(selectKey([candidate({ keyId: 'only' })], { now: NOW, random: () => draw }).keyId).toBe('only');
    }
  });
});
