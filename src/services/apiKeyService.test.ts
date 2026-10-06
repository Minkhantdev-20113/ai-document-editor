import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiKeyMetadata } from '../db/entities';
import { apiKeysRepo, keyRuntimeRepo, secretsRepo } from '../db/repositories';
import { apiKeyService } from './apiKeyService';
import { keyPoolService } from './keyPoolService';

/**
 * Deleting a key must delete everything that only exists to describe it:
 * metadata, ciphertext and the `keyRuntime` failover row. The runtime row was
 * the one that used to survive (the bootstrap sweep only covered dropped
 * providers), leaving the pool a cooldown/health record for a key no UI can
 * list any more.
 */

const T0 = 1_700_000_000_000;

function storedKey(id: string): ApiKeyMetadata {
  return {
    id,
    providerId: 'gemini',
    label: 'gemini key',
    hint: 'AIza••••1234',
    status: 'valid',
    lastVerifiedAt: T0,
    lastUsedAt: T0,
    createdAt: T0,
    updatedAt: T0,
  };
}

beforeEach(async () => {
  await Promise.all([apiKeysRepo.clear(), keyRuntimeRepo.clear(), secretsRepo.clear()]);
});

describe('apiKeyService.remove', () => {
  it('deletes the failover state with the key', async () => {
    await apiKeysRepo.put(storedKey('key_a'));
    await keyPoolService.ensure('key_a', 'gemini');
    expect(await keyRuntimeRepo.get('key_a')).toBeDefined();

    await apiKeyService.remove('key_a');

    expect(await apiKeysRepo.get('key_a')).toBeUndefined();
    expect(await keyRuntimeRepo.get('key_a')).toBeUndefined();
  });

  it('stays safe when there is nothing left to delete', async () => {
    await apiKeysRepo.put(storedKey('key_b'));
    await keyPoolService.ensure('key_b', 'gemini');
    await apiKeyService.remove('key_b');

    await expect(apiKeyService.remove('key_b')).resolves.toBeUndefined();
    expect(await keyRuntimeRepo.get('key_b')).toBeUndefined();
  });
});
