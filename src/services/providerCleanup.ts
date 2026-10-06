import { logger } from '../core/logging/logger';
import { keyRuntimeRepo } from '../db/repositories';
import { PROVIDER_IDS } from '../providers/types';
import { apiKeyService } from './apiKeyService';
import { providerConfigService } from './providerConfigService';

/**
 * Drops stored state that belongs to a provider this build no longer supports.
 *
 * A provider disappears from `PROVIDER_IDS` when it stops being usable for the
 * people this app is for (DeepSeek was removed in 0.6.0: it has no free tier),
 * while IndexedDB keeps whatever it accumulated - the config row (which still
 * counts towards "providers enabled"), the key metadata, the ciphertext in the
 * vault and the key runtime. Translation candidates come from `PROVIDER_IDS`,
 * so none of it is ever used again; it can only mislead the UI (the API keys
 * table asks `getProviderDescriptor` for every stored row) and get exported
 * for no reason.
 *
 * Usage history and `translationUnits.provider` are deliberately left alone:
 * they record money and tokens actually spent, they are not support for a
 * provider.
 *
 * Runs at bootstrap before the job queue starts, and after a data import -
 * an older bundle can reintroduce rows for a provider that has since been
 * dropped. It never throws: a failed cleanup must not stop the app.
 */
export async function removeUnsupportedProviderState(): Promise<void> {
  try {
    const supported = new Set<string>(PROVIDER_IDS);
    let providerConfigs = 0;
    let apiKeys = 0;

    for (const config of await providerConfigService.list()) {
      if (supported.has(config.providerId)) continue;
      await providerConfigService.remove(config.providerId);
      providerConfigs += 1;
    }

    const orphanKeyIds: string[] = [];
    for (const key of await apiKeyService.list()) {
      if (supported.has(key.providerId)) continue;
      // Metadata and the encrypted secret; neither can ever be used again.
      await apiKeyService.remove(key.id);
      orphanKeyIds.push(key.id);
      apiKeys += 1;
    }
    if (orphanKeyIds.length > 0) await keyRuntimeRepo.deleteMany(orphanKeyIds);

    // Failover state without a key is dead state: `apiKeyMetadata` is the
    // source of truth for "this key exists". Older builds removed a key and
    // left its `keyRuntime` row behind (health, cooldown, counters), and a
    // partially imported file can do the same - so sweep by key id, not by
    // provider, which also covers rows this run has just orphaned.
    const liveKeyIds = new Set((await apiKeyService.list()).map((key) => key.id));
    const orphanRuntimeIds = (await keyRuntimeRepo.getAll())
      .filter((runtime) => !liveKeyIds.has(runtime.id))
      .map((runtime) => runtime.id);
    if (orphanRuntimeIds.length > 0) {
      await keyRuntimeRepo.deleteMany(orphanRuntimeIds);
      logger.info('Dropped failover state of keys that no longer exist', {
        keyRuntime: orphanRuntimeIds.length,
      });
    }

    if (providerConfigs > 0 || apiKeys > 0) {
      logger.info('Dropped stored state of unsupported providers', {
        providerConfigs,
        apiKeys,
      });
    }
  } catch (error) {
    logger.warn('Unsupported-provider cleanup skipped', { error: String(error) });
  }
}
