import { appEvents } from '../core/events/eventBus';
import { AppError, toAppError } from '../core/errors/appError';
import { providerConfigsRepo } from '../db/repositories';
import type { ProviderConfig } from '../db/entities';
import { getProviderDescriptor } from '../providers/registry';
import { defaultBaseUrl } from '../providers/catalog';
import type { ProviderId } from '../providers/types';

export interface ProviderConfigPatch {
  readonly label?: string;
  readonly enabled?: boolean;
  readonly baseUrl?: string | null;
  readonly defaultModel?: string | null;
  readonly enabledModels?: readonly string[];
}

function defaultConfig(providerId: ProviderId): ProviderConfig {
  const descriptor = getProviderDescriptor(providerId);
  const timestamp = Date.now();
  return {
    id: `pcfg_${providerId}`,
    providerId,
    label: descriptor.label,
    enabled: false,
    baseUrl: defaultBaseUrl(providerId),
    defaultModel: descriptor.models.find((model) => model.recommended)?.id ?? descriptor.models[0]?.id ?? null,
    enabledModels: descriptor.models.filter((model) => model.recommended).map((model) => model.id),
    rateLimitOverride: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/** Per-provider settings (endpoint, default model, enablement). */
class ProviderConfigService {
  async list(): Promise<ProviderConfig[]> {
    const configs = await providerConfigsRepo.getAll();
    return configs.sort((a, b) => a.label.localeCompare(b.label));
  }

  async get(providerId: ProviderId): Promise<ProviderConfig | undefined> {
    const configs = await providerConfigsRepo.queryByIndex('by_provider', providerId);
    return configs[0];
  }

  /** Returns the stored config, creating a disabled default when absent. */
  async ensure(providerId: ProviderId): Promise<ProviderConfig> {
    const existing = await this.get(providerId);
    if (existing) return existing;
    const created = defaultConfig(providerId);
    await providerConfigsRepo.put(created);
    return created;
  }

  async save(providerId: ProviderId, patch: ProviderConfigPatch): Promise<ProviderConfig> {
    const current = await this.ensure(providerId);
    const merged: ProviderConfig = {
      ...current,
      ...(patch.label !== undefined ? { label: patch.label.trim() || current.label } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl?.trim() || null } : {}),
      ...(patch.defaultModel !== undefined ? { defaultModel: patch.defaultModel } : {}),
      ...(patch.enabledModels !== undefined ? { enabledModels: [...patch.enabledModels] } : {}),
      updatedAt: Date.now(),
    };
    // Invariant: the default model is always usable. The key pool rejects
    // models outside `enabledModels`, so a chosen default must be in the list
    // (users pick defaults from the model dropdown, which lists everything).
    const next: ProviderConfig = ((): ProviderConfig => {
      if (!merged.defaultModel) return merged;
      const models = merged.enabledModels ?? [];
      if (models.includes(merged.defaultModel)) return merged;
      return { ...merged, enabledModels: [...models, merged.defaultModel] };
    })();
    if (next.baseUrl && !/^https:\/\//i.test(next.baseUrl)) {
      throw new AppError('Base URL must start with https://', { code: 'validation', retryable: false });
    }
    try {
      await providerConfigsRepo.put(next);
    } catch (error) {
      throw toAppError(error, 'db_operation_failed');
    }
    appEvents.emit('providers:changed', { providerId });
    return next;
  }

  async remove(providerId: ProviderId): Promise<void> {
    const config = await this.get(providerId);
    if (!config) return;
    await providerConfigsRepo.delete(config.id);
    appEvents.emit('providers:changed', { providerId });
  }

  /** Number of providers currently switched on (dashboard signal). */
  async enabledCount(): Promise<number> {
    const configs = await this.list();
    return configs.filter((config) => config.enabled).length;
  }
}

export const providerConfigService = new ProviderConfigService();
