import { describe, expect, it } from 'vitest';
import { maskSecret, redactSecrets } from './redact';

// Shaped like an AI Studio Auth key but obviously synthetic - never commit a
// real key, GitHub push protection will (correctly) block it.
const GOOGLE_AUTH_KEY = 'AQ.AFakeKeyUsedOnlyInUnitTests00000000000000000000';

describe('redactSecrets', () => {
  it('redacts Google Auth keys (AQ.…)', () => {
    const line = `POST /v1beta failed for key ${GOOGLE_AUTH_KEY} at 12:00`;
    const redacted = redactSecrets(line);
    expect(redacted).not.toContain(GOOGLE_AUTH_KEY);
    expect(redacted).not.toContain('FakeKeyUsedOnlyInUnit');
    expect(redacted).toContain('[redacted]');
  });

  it('redacts legacy Standard keys (AIza…)', () => {
    const key = 'AIzaSyExampleExampleExampleExample12';
    expect(redactSecrets(`token=${key}`)).not.toContain(key);
  });

  it('redacts header-form secrets', () => {
    expect(redactSecrets(`x-goog-api-key: ${GOOGLE_AUTH_KEY}`)).not.toContain('FakeKeyUsed');
  });

  it('leaves ordinary prose untouched', () => {
    expect(redactSecrets('The model AQ.Xy is not a key by itself.')).toBe(
      'The model AQ.Xy is not a key by itself.',
    );
  });
});

describe('maskSecret', () => {
  it('shows only the head and tail of an Auth key', () => {
    const hint = maskSecret(GOOGLE_AUTH_KEY);
    expect(hint.startsWith('AQ.A')).toBe(true);
    expect(hint.endsWith('0000')).toBe(true);
    expect(hint).not.toContain('FakeKeyUsedOnlyInUnit');
  });
});
