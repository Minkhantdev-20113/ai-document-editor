import { AppError } from '../core/errors/appError';
import { PROVIDER_CATALOG } from './catalog';
import type { ModelDescriptor, ProviderId } from './types';

/**
 * Model registry.
 *
 * One place answers "what is this model, what can it do, what does it cost?"
 * so the UI never hard-codes provider facts and provider-specific logic never
 * leaks into components.
 *
 * Honesty rules baked into the types:
 * - `pricingType` has three UI values (FREE / FREE TIER / PAID) but the UI must
 *   always show the "pricing changes; verify with the provider" note - nothing
 *   here claims a model is permanently free.
 * - `supportsPDF` is never inferred: a model is only PDF-capable when the
 *   capability is explicitly declared below or in an imported catalog update.
 * - `source` tracks whether a spec came from the built-in catalog or from a
 *   user-imported overlay, so the UI can label modified entries.
 */

export type PricingType = 'free' | 'free_tier' | 'paid';
export type Level = 'high' | 'medium' | 'low';
export type SpeedLevel = 'fast' | 'medium' | 'slow';

export interface ModelSpec {
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly displayName: string;
  readonly pricingType: PricingType;
  /** Whether a free allowance exists (never "free forever"). */
  readonly freeTier: boolean;
  /** Whether paid usage exists for this model. */
  readonly paid: boolean;
  readonly contextLength: number;
  readonly maxOutputTokens: number;
  readonly supportsText: boolean;
  /** Explicit declaration only - PDF support is never assumed. */
  readonly supportsPDF: boolean;
  readonly supportsImage: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsVision: boolean;
  readonly qualityLevel: Level;
  readonly speedLevel: SpeedLevel;
  readonly enabled: boolean;
  readonly source: 'builtin' | 'catalog_update';
}

export type ModelSpecPatch = Partial<
  Pick<
    ModelSpec,
    | 'displayName'
    | 'pricingType'
    | 'freeTier'
    | 'paid'
    | 'contextLength'
    | 'maxOutputTokens'
    | 'supportsText'
    | 'supportsPDF'
    | 'supportsImage'
    | 'supportsStructuredOutput'
    | 'supportsVision'
    | 'qualityLevel'
    | 'speedLevel'
  >
>;

export interface CatalogOverlayEntry {
  readonly providerId: ProviderId;
  readonly modelId: string;
  readonly patch: ModelSpecPatch;
}

interface ModelMeta {
  readonly pricing: PricingType;
  readonly quality: Level;
  readonly speed: SpeedLevel;
  /** Declared capabilities beyond the provider-level ones. */
  readonly pdf?: boolean;
  readonly image?: boolean;
  readonly vision?: boolean;
  readonly structuredOutput?: boolean;
}

/**
 * Built-in facts, keyed `${providerId}/${modelId}`.
 *
 * PDF/image declarations follow each provider's published model documentation
 * at the time of writing; anything not listed stays `false` (never assume).
 * Entries are intentionally conservative: a missed capability is a missing
 * badge, an invented one is a broken feature.
 */
const MODEL_META: Readonly<Record<string, ModelMeta>> = {
  // Ids mirror PROVIDER_CATALOG; flags follow each provider's model docs.
  'gemini/gemini-3.8-flash': { pricing: 'free_tier', quality: 'high', speed: 'fast', pdf: true, image: true, vision: true },
  'gemini/gemini-3.5-flash': { pricing: 'free_tier', quality: 'medium', speed: 'fast', pdf: true, image: true, vision: true },
  'gemini/gemini-3.5-flash-lite': { pricing: 'free_tier', quality: 'medium', speed: 'fast', pdf: true, image: true, vision: true },
  'groq/openai/gpt-oss-120b': { pricing: 'free_tier', quality: 'medium', speed: 'fast' },
  'groq/openai/gpt-oss-20b': { pricing: 'free_tier', quality: 'low', speed: 'fast' },
  'openrouter/openai/gpt-4o-mini': { pricing: 'paid', quality: 'medium', speed: 'fast', image: true, vision: true },
  'openrouter/anthropic/claude-sonnet-5.5': { pricing: 'paid', quality: 'high', speed: 'medium' },
  'openrouter/google/gemini-3.5-flash': { pricing: 'paid', quality: 'medium', speed: 'fast', image: true, vision: true },
  'deepseek/deepseek-flash': { pricing: 'paid', quality: 'medium', speed: 'fast' },
  'deepseek/deepseek-v4-pro': { pricing: 'paid', quality: 'high', speed: 'medium' },
  'openai_compatible/gpt-4o-mini': { pricing: 'paid', quality: 'medium', speed: 'fast' },
  'openai_compatible/gpt-4o': { pricing: 'paid', quality: 'high', speed: 'medium' },
};

/** Lookup with an explicit fallback for models not listed (e.g. `:free` routes). */
function metaFor(providerId: ProviderId, modelId: string): ModelMeta {
  const meta = MODEL_META[`${providerId}/${modelId}`];
  if (meta) return meta;
  if (modelId.endsWith(':free')) {
    return { pricing: 'free', quality: 'medium', speed: 'fast' };
  }
  return { pricing: 'paid', quality: 'medium', speed: 'medium' };
}

function pricingFlags(pricing: PricingType): { freeTier: boolean; paid: boolean } {
  switch (pricing) {
    case 'free':
      return { freeTier: true, paid: false };
    case 'free_tier':
      return { freeTier: true, paid: true };
    case 'paid':
      return { freeTier: false, paid: true };
  }
}

export interface ModelSpecOptions {
  /** Model ids the user enabled for the provider; `null`/absent = all enabled. */
  readonly enabledModels?: readonly string[] | null;
  readonly overlay?: readonly CatalogOverlayEntry[];
}

function specFor(descriptorModels: readonly ModelDescriptor[], providerId: ProviderId, options: ModelSpecOptions): ModelSpec[] {
  const overlays = new Map<string, ModelSpecPatch>();
  for (const entry of options.overlay ?? []) {
    if (entry.providerId === providerId) overlays.set(entry.modelId, entry.patch);
  }

  return descriptorModels.map((model) => {
    const meta = metaFor(providerId, model.id);
    const flags = pricingFlags(meta.pricing);
    const jsonMode = PROVIDER_CATALOG[providerId].capabilities.jsonMode;
    const enabledModels = options.enabledModels;

    const base: ModelSpec = {
      providerId,
      modelId: model.id,
      displayName: model.label,
      pricingType: meta.pricing,
      freeTier: flags.freeTier,
      paid: flags.paid,
      contextLength: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      supportsText: true,
      supportsPDF: meta.pdf ?? false,
      supportsImage: meta.image ?? false,
      supportsStructuredOutput: meta.structuredOutput ?? jsonMode,
      supportsVision: meta.vision ?? false,
      qualityLevel: meta.quality,
      speedLevel: meta.speed,
      enabled: enabledModels ? enabledModels.includes(model.id) : true,
      source: 'builtin',
    };

    const patch = overlays.get(model.id);
    if (!patch) return base;

    const merged: ModelSpec = { ...base, ...patch, source: 'catalog_update' };
    // Keep the pricing booleans consistent when a patch changes only one of them.
    if (patch.pricingType && patch.freeTier === undefined && patch.paid === undefined) {
      const nextFlags = pricingFlags(merged.pricingType);
      return { ...merged, ...nextFlags };
    }
    return merged;
  });
}

/** All specs for one provider, overlay applied, in catalog order. */
export function modelSpecs(providerId: ProviderId, options: ModelSpecOptions = {}): ModelSpec[] {
  const descriptor = PROVIDER_CATALOG[providerId];
  return specFor(descriptor.models, providerId, options);
}

export function allModelSpecs(options: ModelSpecOptions = {}): ModelSpec[] {
  return (Object.keys(PROVIDER_CATALOG) as ProviderId[]).flatMap((providerId) => modelSpecs(providerId, options));
}

/** Finds a spec by provider + model id (throws on unknown model). */
export function requireModelSpec(providerId: ProviderId, modelId: string, options: ModelSpecOptions = {}): ModelSpec {
  const spec = modelSpecs(providerId, options).find((entry) => entry.modelId === modelId);
  if (!spec) {
    throw new AppError(`Unknown model "${modelId}" for ${providerId}`, {
      code: 'provider_invalid_model',
      retryable: false,
    });
  }
  return spec;
}

const PATCH_KEYS = new Set<string>([
  'displayName',
  'pricingType',
  'freeTier',
  'paid',
  'contextLength',
  'maxOutputTokens',
  'supportsText',
  'supportsPDF',
  'supportsImage',
  'supportsStructuredOutput',
  'supportsVision',
  'qualityLevel',
  'speedLevel',
]);

const PRICING_VALUES: readonly PricingType[] = ['free', 'free_tier', 'paid'];
const LEVEL_VALUES: readonly Level[] = ['high', 'medium', 'low'];
const SPEED_VALUES: readonly SpeedLevel[] = ['fast', 'medium', 'slow'];

/**
 * Validates a user-imported catalog update (the "catalog is updateable"
 * requirement). Unknown providers, unknown models and unknown fields are all
 * rejected loudly - a bad import must never silently corrupt the registry.
 */
export function validateOverlay(raw: unknown): CatalogOverlayEntry[] {
  if (typeof raw !== 'object' || raw === null) {
    throw new AppError('Catalog file must be a JSON object', { code: 'import_invalid', retryable: false });
  }
  const entries = (raw as { models?: unknown }).models;
  if (!Array.isArray(entries)) {
    throw new AppError('Catalog file must contain a "models" array', { code: 'import_invalid', retryable: false });
  }

  const validated: CatalogOverlayEntry[] = [];
  entries.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new AppError(`Entry ${index} is not an object`, { code: 'import_invalid', retryable: false });
    }
    const record = entry as Record<string, unknown>;
    const providerId = record['providerId'];
    const modelId = record['modelId'];
    const patch = record['patch'];
    if (typeof providerId !== 'string' || !(providerId in PROVIDER_CATALOG)) {
      throw new AppError(`Entry ${index} has an unknown provider`, { code: 'import_invalid', retryable: false });
    }
    if (typeof modelId !== 'string' || modelId.trim() === '') {
      throw new AppError(`Entry ${index} has no modelId`, { code: 'import_invalid', retryable: false });
    }
    const catalog = PROVIDER_CATALOG[providerId as ProviderId];
    if (!catalog.models.some((model) => model.id === modelId)) {
      // The overlay patches existing specs only - a typo'd model id would
      // otherwise be stored and silently never apply.
      throw new AppError(`Entry ${index} references an unknown model "${modelId}"`, {
        code: 'import_invalid',
        retryable: false,
      });
    }
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new AppError(`Entry ${index} has no patch object`, { code: 'import_invalid', retryable: false });
    }

    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (!PATCH_KEYS.has(key)) {
        throw new AppError(`Entry ${index} modifies unknown field "${key}"`, {
          code: 'import_invalid',
          retryable: false,
        });
      }
      if (key === 'pricingType' && !PRICING_VALUES.includes(value as PricingType)) {
        throw new AppError(`Entry ${index} has an invalid pricingType`, { code: 'import_invalid', retryable: false });
      }
      if (key === 'qualityLevel' && !LEVEL_VALUES.includes(value as Level)) {
        throw new AppError(`Entry ${index} has an invalid qualityLevel`, { code: 'import_invalid', retryable: false });
      }
      if (key === 'speedLevel' && !SPEED_VALUES.includes(value as SpeedLevel)) {
        throw new AppError(`Entry ${index} has an invalid speedLevel`, { code: 'import_invalid', retryable: false });
      }
      if (
        (key === 'contextLength' || key === 'maxOutputTokens') &&
        (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
      ) {
        throw new AppError(`Entry ${index} has an invalid ${key}`, { code: 'import_invalid', retryable: false });
      }
      if (
        (key === 'freeTier' ||
          key === 'paid' ||
          key === 'supportsText' ||
          key === 'supportsPDF' ||
          key === 'supportsImage' ||
          key === 'supportsStructuredOutput' ||
          key === 'supportsVision') &&
        typeof value !== 'boolean'
      ) {
        throw new AppError(`Entry ${index}: ${key} must be a boolean`, { code: 'import_invalid', retryable: false });
      }
      if (key === 'displayName' && (typeof value !== 'string' || value.trim() === '')) {
        throw new AppError(`Entry ${index} has an empty displayName`, { code: 'import_invalid', retryable: false });
      }
      clean[key] = value;
    }

    validated.push({
      providerId: providerId as ProviderId,
      modelId,
      patch: clean as ModelSpecPatch,
    });
  });

  return validated;
}

/** Serialisable payload written back to storage after a successful import. */
export function serializeOverlay(entries: readonly CatalogOverlayEntry[]): string {
  return JSON.stringify({ version: 1, models: entries }, null, 2);
}
