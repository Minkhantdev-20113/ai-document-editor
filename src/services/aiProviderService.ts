import { createAIProvider, type AIProvider } from '../providers/aiProvider';
import type { ProviderId } from '../providers/types';
import { keyPoolService } from './keyPoolService';
import { providerConfigService } from './providerConfigService';
import { usageService } from './usageService';

/**
 * Wires the pure `createAIProvider` factory to the app's runtime services
 * (key pool, vault access, usage store, provider config).
 *
 * This is the only place that connects AIProvider to the storage layer, so
 * every caller - engine, jobs, UI - gets the same failover-aware provider and
 * tests can inject fakes directly into `TranslationService` instead.
 */
export async function getAIProvider(providerId: ProviderId): Promise<AIProvider> {
  const config = await providerConfigService.ensure(providerId);
  return createAIProvider(providerId, {
    baseUrl: config.baseUrl,
    defaultModel: config.defaultModel,
    pool: keyPoolService,
    usage: {
      totalsFor: (id) => usageService.totalsFor(id),
    },
  });
}
