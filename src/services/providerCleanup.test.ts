import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiKeyMetadata, ProviderConfig, SecretRecord } from '../db/entities';
import { apiKeysRepo, keyRuntimeRepo, providerConfigsRepo, secretsRepo } from '../db/repositories';
import type { ProviderId } from '../providers/types';
import { keyPoolService } from './keyPoolService';
import { removeUnsupportedProviderState } from './providerCleanup';

/**
 * DeepSeek was removed from provider support in 0.6.0 (no free tier), so
 * whatever an older build stored for it can never be used again. These tests
 * pin the sweep that deletes it - and only it.
 */

const T0 = 1_700_000_000_000;
/** Typed as `string` on purpose: this id is no longer part of `ProviderId`. */
const DROPPED: string = 'deepseek';

function storedConfig(providerId: string, enabled = true): ProviderConfig {
  return {
    id: `pcfg_${providerId}`,
    providerId: providerId as ProviderId,
    label: providerId,
    enabled,
    baseUrl: null,
    defaultModel: 'some-model',
    enabledModels: ['some-model'],
    rateLimitOverride: null,
    createdAt: T0,
    updatedAt: T0,
  };
}

function storedKey(id: string, providerId: string): ApiKeyMetadata {
  return {
    id,
    providerId: providerId as ProviderId,
    label: `${providerId} key`,
    hint: 'sk-••••1234',
    status: 'valid',
    lastVerifiedAt: T0,
    lastUsedAt: T0,
    createdAt: T0,
    updatedAt: T0,
  };
}

function storedSecret(id: string): SecretRecord {
  return { id, ciphertext: 'AAAA', iv: 'BBBB', version: 1, createdAt: T0, updatedAt: T0 };
}

beforeEach(async () => {
  await Promise.all([
    providerConfigsRepo.clear(),
    apiKeysRepo.clear(),
    keyRuntimeRepo.clear(),
    secretsRepo.clear(),
  ]);
});

describe('removeUnsupportedProviderState', () => {
  it('deletes the config, key, ciphertext and runtime of a dropped provider', async () => {
    await providerConfigsRepo.put(storedConfig(DROPPED, true));
    await providerConfigsRepo.put(storedConfig('gemini', true));
    await apiKeysRepo.put(storedKey('key_dropped', DROPPED));
    await apiKeysRepo.put(storedKey('key_gemini', 'gemini'));
    await secretsRepo.put(storedSecret('key_dropped'));
    await secretsRepo.put(storedSecret('key_gemini'));
    await keyPoolService.ensure('key_dropped', DROPPED as ProviderId);
    await keyPoolService.ensure('key_gemini', 'gemini');

    await removeUnsupportedProviderState();

    // Gone: it would only mislead the UI and inflate the enabled count.
    expect(await providerConfigsRepo.get(`pcfg_${DROPPED}`)).toBeUndefined();
    expect(await apiKeysRepo.get('key_dropped')).toBeUndefined();
    expect(await secretsRepo.get('key_dropped')).toBeUndefined();
    expect(await keyRuntimeRepo.get('key_dropped')).toBeUndefined();

    // Kept: supported providers are never touched by the sweep.
    expect(await providerConfigsRepo.get('pcfg_gemini')).toBeDefined();
    expect(await apiKeysRepo.get('key_gemini')).toBeDefined();
    expect(await secretsRepo.get('key_gemini')).toBeDefined();
    expect(await keyRuntimeRepo.get('key_gemini')).toBeDefined();
  });

  it('is a no-op when every stored provider is still supported', async () => {
    await providerConfigsRepo.put(storedConfig('groq', true));
    await apiKeysRepo.put(storedKey('key_groq', 'groq'));
    await secretsRepo.put(storedSecret('key_groq'));

    await removeUnsupportedProviderState();

    expect(await providerConfigsRepo.get('pcfg_groq')).toBeDefined();
    expect(await apiKeysRepo.get('key_groq')).toBeDefined();
    expect(await secretsRepo.get('key_groq')).toBeDefined();
    // Nothing to report means nothing was deleted - running it twice is safe.
    await removeUnsupportedProviderState();
    expect(await providerConfigsRepo.get('pcfg_groq')).toBeDefined();
  });
});
