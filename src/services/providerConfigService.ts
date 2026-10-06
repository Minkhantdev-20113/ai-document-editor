import { appEvents } from '../core/events/eventBus';
import { AppError, toAppError } from '../core/errors/appError';
import { logger } from '../core/logging/logger';
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
    if (existing) return this.healRetiredModel(providerId, existing);
    const created = defaultConfig(providerId);
    await providerConfigsRepo.put(created);
    return created;
  }

  /**
   * Migrates a stored default model that the provider no longer serves.
   *
   * Providers retire model ids (Google shut down `gemini-2.0-flash` on
   * 2026-06-01, OpenRouter dropped `google/gemini-2.0-flash-001`, Groq and
   * DeepSeek did the same to their llama/chat ids) while a user's saved
   * config keeps pointing at them - which turned every translation into a
   * 404 that failed the whole job. The config is rewritten to the provider's
   * current model once, silently from the user's point of view.
   *
   * `openai_compatible` is exempt: that endpoint may serve any model id the
   * catalog has never heard of, so "unknown" there is not "retired".
   */
  private async healRetiredModel(providerId: ProviderId, config: ProviderConfig): Promise<ProviderConfig> {
    if (providerId === 'openai_compatible') return config;
    const storedModel = config.defaultModel;
    if (!storedModel) return config;
    const descriptor = getProviderDescriptor(providerId);
    if (descriptor.models.some((model) => model.id === storedModel)) return config;
    const replacement =
      descriptor.models.find((model) => model.recommended)?.id ?? descriptor.models[0]?.id;
    if (!replacement || replacement === storedModel) return config;

    // `enabledModels: []`/null means "every model", never narrow it down.
    const enabled = config.enabledModels;
    const healed: ProviderConfig = {
      ...config,
      defaultModel: replacement,
      enabledModels:
        !enabled || enabled.length === 0 || enabled.includes(replacement)
          ? enabled
          : [...enabled, replacement],
      updatedAt: Date.now(),
    };
    await providerConfigsRepo.put(healed);
    logger.warn('Stored default model is no longer served by the provider', {
      providerId,
      from: storedModel,
      to: replacement,
    });
    appEvents.emit('providers:changed', { providerId });
    return healed;
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
