import { appEvents } from '../core/events/eventBus';
import { AppError, toAppError } from '../core/errors/appError';
import { logger } from '../core/logging/logger';
import { newId } from '../core/utils/id';
import { maskSecret } from '../core/utils/redact';
import { apiKeysRepo, keyRuntimeRepo } from '../db/repositories';
import type { ApiKeyMetadata, ApiKeyStatus } from '../db/entities';
import { keyVault } from '../security/keyVault';
import { getAdapter, looksLikeKey } from '../providers/registry';
import { verifyKey, type KeyVerification } from '../providers/verify';
import type { ProviderId } from '../providers/types';
import { providerConfigService } from './providerConfigService';

export interface AddKeyInput {
  readonly providerId: ProviderId;
  readonly label: string;
  readonly key: string;
}

/**
 * API key management.
 *
 * The raw secret exists in exactly two places: the input field while typing,
 * and the encrypted vault afterwards. Metadata (label, masked hint, status) is
 * stored separately so lists and dashboards never need the vault unlocked.
 */
class ApiKeyService {
  async list(): Promise<ApiKeyMetadata[]> {
    const keys = await apiKeysRepo.getAll();
    return keys.sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(id: string): Promise<ApiKeyMetadata | undefined> {
    return apiKeysRepo.get(id);
  }

  async listForProvider(providerId: ProviderId): Promise<ApiKeyMetadata[]> {
    const keys = (await apiKeysRepo.queryByIndex('by_provider', providerId)) ?? [];
    return keys.sort((a, b) => b.createdAt - a.createdAt);
  }

  async add(input: AddKeyInput): Promise<ApiKeyMetadata> {
    const key = input.key.trim();
    const label = input.label.trim() || `${input.providerId} key`;

    if (!key) {
      throw new AppError('API key is required', { code: 'validation', retryable: false });
    }
    if (!looksLikeKey(input.providerId, key)) {
      const descriptor = getAdapter(input.providerId).descriptor;
      throw new AppError(`This does not look like a ${descriptor.label} API key`, {
        code: 'validation',
        retryable: false,
      });
    }

    await keyVault.ready();
    if (!keyVault.isUnlocked()) {
      throw new AppError('Unlock the key vault first', { code: 'vault_locked', retryable: false });
    }

    const id = newId('key');
    await keyVault.storeSecret(id, key);

    const timestamp = Date.now();
    const metadata: ApiKeyMetadata = {
      id,
      providerId: input.providerId,
      label,
      hint: maskSecret(key),
      status: 'unverified',
      lastVerifiedAt: null,
      lastUsedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      await apiKeysRepo.put(metadata);
    } catch (error) {
      await keyVault.deleteSecret(id).catch(() => undefined);
      throw toAppError(error, 'db_operation_failed');
    }

    // Never log the key itself - provider, label and masked hint only.
    logger.info('API key stored', { provider: input.providerId, label, hint: metadata.hint });
    appEvents.emit('apiKeys:changed', {});
    return metadata;
  }

  /** Verifies a stored key; the secret is read from the vault only for this call. */
  async verify(id: string): Promise<KeyVerification> {
    const metadata = await this.get(id);
    if (!metadata) {
      return {
        ok: false,
        error: new AppError('Key not found', { code: 'not_found', retryable: false }),
      };
    }
    const secret = await keyVault.retrieveSecret(id);
    if (!secret) {
      await this.updateStatus(id, 'revoked');
      return {
        ok: false,
        error: new AppError('The encrypted key is no longer available', {
          code: 'vault_locked',
          retryable: false,
        }),
      };
    }

    const config = await providerConfigService.ensure(metadata.providerId);
    const adapter = getAdapter(metadata.providerId, config.baseUrl);
    const result = await verifyKey(adapter, secret);

    await this.updateStatus(
      id,
      result.ok ? 'valid' : result.error.code === 'provider_invalid_key' ? 'invalid' : 'unverified',
      result.ok,
    );
    return result;
  }

  /** Copies the secret to the clipboard without ever rendering it in the UI. */
  async copyToClipboard(id: string): Promise<void> {
    const secret = await keyVault.retrieveSecret(id);
    if (!secret) {
      throw new AppError('The encrypted key is no longer available', { code: 'vault_locked', retryable: false });
    }
    await navigator.clipboard.writeText(secret);
    await this.touch(id);
    logger.info('API key copied to clipboard', { keyId: id });
  }

  async remove(id: string): Promise<void> {
    await apiKeysRepo.delete(id);
    // Failover state belongs to a key: without this the `keyRuntime` row
    // (health, cooldown, counters) outlives the key it describes, and the pool
    // would keep a candidate that no longer exists in any list.
    await keyRuntimeRepo.delete(id).catch((error: unknown) => {
      logger.warn('Key runtime state could not be removed', { keyId: id, error: String(error) });
    });
    await keyVault.deleteSecret(id).catch((error: unknown) => {
      logger.warn('Encrypted secret could not be removed', { keyId: id, error: String(error) });
    });
    appEvents.emit('apiKeys:changed', {});
    logger.info('API key removed', { keyId: id });
  }

  async count(): Promise<number> {
    return apiKeysRepo.count();
  }

  private async updateStatus(id: string, status: ApiKeyStatus, verified = false): Promise<void> {
    const metadata = await this.get(id);
    if (!metadata) return;
    const timestamp = Date.now();
    await apiKeysRepo.put({
      ...metadata,
      status,
      lastVerifiedAt: verified ? timestamp : metadata.lastVerifiedAt,
      updatedAt: timestamp,
    });
    appEvents.emit('apiKeys:changed', {});
  }

  private async touch(id: string): Promise<void> {
    const metadata = await this.get(id);
    if (!metadata) return;
    await apiKeysRepo.put({ ...metadata, lastUsedAt: Date.now(), updatedAt: Date.now() });
  }
}

export const apiKeyService = new ApiKeyService();
