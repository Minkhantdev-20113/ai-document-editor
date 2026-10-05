import { describe, expect, it } from 'vitest';
import { backoffDelayMs } from './backoff';

describe('backoffDelayMs', () => {
  it('grows exponentially with the attempt number', () => {
    const random = () => 0; // lower half only: delay === ceiling / 2
    expect(backoffDelayMs({ attempt: 0, baseMs: 1_000, random })).toBe(500);
    expect(backoffDelayMs({ attempt: 1, baseMs: 1_000, random })).toBe(1_000);
    expect(backoffDelayMs({ attempt: 2, baseMs: 1_000, random })).toBe(2_000);
    expect(backoffDelayMs({ attempt: 4, baseMs: 1_000, random })).toBe(8_000);
  });

  it('stays within [ceiling / 2, ceiling] for any random value', () => {
    for (const random of [() => 0, () => 0.5, () => 0.999999]) {
      const delay = backoffDelayMs({ attempt: 3, baseMs: 1_000, random });
      expect(delay).toBeGreaterThanOrEqual(4_000);
      expect(delay).toBeLessThanOrEqual(8_000);
    }
  });

  it('never collapses into a tight loop (half the ceiling is always reserved)', () => {
    const delay = backoffDelayMs({ attempt: 0, baseMs: 1_000, random: () => 0 });
    expect(delay).toBeGreaterThanOrEqual(500);
  });

  it('respects the maximum cap on large attempt counts', () => {
    const delay = backoffDelayMs({ attempt: 50, baseMs: 1_000, maxMs: 60_000, random: () => 0.999999 });
    expect(delay).toBeLessThanOrEqual(60_000);
    expect(delay).toBeGreaterThanOrEqual(30_000);
  });

  it('is deterministic with an injected random source', () => {
    const options = { attempt: 5, baseMs: 250, random: () => 0.42 };
    expect(backoffDelayMs(options)).toBe(backoffDelayMs(options));
  });
});
