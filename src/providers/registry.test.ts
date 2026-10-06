import { describe, expect, it } from 'vitest';
import { isProviderId } from './types';
import { listProviderDescriptors, looksLikeKey } from './registry';

// Google AI Studio issues Auth keys (`AQ.…`) instead of Standard keys
// (`AIza…`) since mid-2026; both must pass the client-side format check.
const GOOGLE_AUTH_KEY = 'AQ.AFakeKeyUsedOnlyInUnitTests00000000000000000000';
const GOOGLE_STANDARD_KEY = 'AIzaSyFExampleExampleExampleExample12';

describe('looksLikeKey', () => {
  it('accepts the legacy Google Standard key (AIza…)', () => {
    expect(looksLikeKey('gemini', GOOGLE_STANDARD_KEY)).toBe(true);
  });

  it('accepts the Auth key shape AI Studio issues today (AQ.…)', () => {
    expect(looksLikeKey('gemini', GOOGLE_AUTH_KEY)).toBe(true);
    // Trailing whitespace from pasting must not matter.
    expect(looksLikeKey('gemini', `  ${GOOGLE_AUTH_KEY}\n`)).toBe(true);
  });

  it('still rejects keys of the wrong shape', () => {
    expect(looksLikeKey('gemini', 'sk-or-v1-abcdef')).toBe(false);
    expect(looksLikeKey('gemini', 'AQ.short')).toBe(false);
    expect(looksLikeKey('gemini', 'not-a-key')).toBe(false);
    expect(looksLikeKey('gemini', '')).toBe(false);
    // A Gemini key must not satisfy another provider's pattern either.
    expect(looksLikeKey('openrouter', GOOGLE_AUTH_KEY)).toBe(false);
  });

  it('keeps the other providers on their own shapes', () => {
    expect(looksLikeKey('openrouter', `sk-or-v1-${'a'.repeat(32)}`)).toBe(true);
    expect(looksLikeKey('groq', `gsk_${'a'.repeat(32)}`)).toBe(true);
    // A self-hosted endpoint declares no format, so only length is checked.
    expect(looksLikeKey('openai_compatible', 'a'.repeat(16))).toBe(true);
    expect(looksLikeKey('openai_compatible', 'short')).toBe(false);
  });
});

describe('provider list', () => {
  it('offers exactly the supported providers (DeepSeek was dropped: no free tier)', () => {
    expect(listProviderDescriptors().map((descriptor) => descriptor.id)).toEqual([
      'gemini',
      'groq',
      'openrouter',
      'openai_compatible',
    ]);
    expect(isProviderId('deepseek')).toBe(false);
  });
});
