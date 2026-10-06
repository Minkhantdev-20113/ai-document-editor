import { describe, expect, it } from 'vitest';
import { AppError } from '../core/errors/appError';
import { getProviderDescriptor, listProviderDescriptors } from './registry';
import { PROVIDER_IDS } from './types';
import {
  allModelSpecs,
  modelSpecs,
  modelSupportsJsonMode,
  requireModelSpec,
  serializeOverlay,
  validateOverlay,
  type CatalogOverlayEntry,
} from './modelRegistry';

function expectInvalid(raw: unknown): AppError {
  try {
    validateOverlay(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('import_invalid');
    return error as AppError;
  }
  throw new Error('expected validateOverlay to reject');
}

describe('model registry facts', () => {
  it('exposes every Phase 3 registry field for every catalog model', () => {
    const specs = allModelSpecs();
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec.providerId).toBeTruthy();
      expect(spec.modelId).toBeTruthy();
      expect(spec.displayName).toBeTruthy();
      expect(['free', 'free_tier', 'paid']).toContain(spec.pricingType);
      expect(typeof spec.freeTier).toBe('boolean');
      expect(typeof spec.paid).toBe('boolean');
      expect(spec.contextLength).toBeGreaterThan(0);
      expect(spec.maxOutputTokens).toBeGreaterThan(0);
      expect(typeof spec.supportsText).toBe('boolean');
      expect(typeof spec.supportsPDF).toBe('boolean');
      expect(typeof spec.supportsImage).toBe('boolean');
      expect(typeof spec.supportsStructuredOutput).toBe('boolean');
      expect(typeof spec.supportsVision).toBe('boolean');
      expect(['high', 'medium', 'low']).toContain(spec.qualityLevel);
      expect(['fast', 'medium', 'slow']).toContain(spec.speedLevel);
      expect(typeof spec.recommended).toBe('boolean');
      expect(typeof spec.enabled).toBe('boolean');
      expect(spec.source).toBe('builtin');
      // Pricing flags must agree with the pricing class.
      expect(spec.freeTier || spec.paid).toBe(true);
      if (spec.pricingType === 'paid') expect(spec.freeTier).toBe(false);
      if (spec.pricingType === 'free') expect(spec.paid).toBe(false);
    }
  });

  it('never assumes PDF support - only explicitly declared models get it', () => {
    const specs = allModelSpecs();
    const pdfModels = specs.filter((spec) => spec.supportsPDF).map((spec) => `${spec.providerId}/${spec.modelId}`);
    // Built-in declarations: only the current Gemini chat models declare PDF
    // input - every one of their model cards lists PDF among the accepted
    // input types.
    expect(pdfModels).toEqual([
      'gemini/gemini-3.8-flash',
      'gemini/gemini-3.7-flash',
      'gemini/gemini-3.6-flash',
      'gemini/gemini-3.5-flash',
      'gemini/gemini-3.5-flash-lite',
      'gemini/gemini-3.1-flash-lite',
    ]);
    // A text-only provider model must never claim PDF or vision.
    const groq = requireModelSpec('groq', 'openai/gpt-oss-20b');
    expect(groq.supportsPDF).toBe(false);
    expect(groq.supportsVision).toBe(false);
    expect(groq.supportsImage).toBe(false);
  });

  it('derives the enabled flag from the provider enabled-model list', () => {
    expect(modelSpecs('groq').every((spec) => spec.enabled)).toBe(true);
    const filtered = modelSpecs('groq', { enabledModels: ['openai/gpt-oss-20b'] });
    expect(filtered.find((spec) => spec.modelId === 'openai/gpt-oss-20b')?.enabled).toBe(true);
    expect(filtered.find((spec) => spec.modelId === 'openai/gpt-oss-120b')?.enabled).toBe(false);
  });

  it('offers every provider at least one model a non-paying user can run', () => {
    for (const providerId of PROVIDER_IDS) {
      const specs = modelSpecs(providerId);
      expect(specs.length).toBeGreaterThan(0);
      expect(specs.some((spec) => spec.freeTier)).toBe(true);
      // Rate limits are shown in the UI, so each policy must explain itself.
      expect(getProviderDescriptor(providerId).rateLimit.notes.length).toBeGreaterThan(40);
    }
    // Hosted providers publish numbers; the self-hosted one deliberately
    // publishes none, because the app cannot know an endpoint's policy.
    expect(getProviderDescriptor('gemini').rateLimit).toMatchObject({
      basis: 'per-account',
      requestsPerMinute: 15,
    });
    expect(getProviderDescriptor('groq').rateLimit).toMatchObject({
      basis: 'per-account',
      requestsPerMinute: 30,
      requestsPerDay: 1_000,
    });
    expect(getProviderDescriptor('openrouter').rateLimit).toMatchObject({
      basis: 'per-account',
      requestsPerMinute: 20,
    });
    const compatible = getProviderDescriptor('openai_compatible').rateLimit;
    expect(compatible.requestsPerMinute).toBeUndefined();
    expect(compatible.requestsPerDay).toBeUndefined();
  });

  it('labels only real `:free` routes FREE - and never a paid route', () => {
    const specs = modelSpecs('openrouter');
    const free = specs.filter((spec) => spec.pricingType === 'free');
    expect(free.length).toBeGreaterThanOrEqual(5);
    expect(free.every((spec) => spec.modelId.endsWith(':free'))).toBe(true);
    expect(free.every((spec) => spec.freeTier && !spec.paid)).toBe(true);
    expect(specs.find((spec) => spec.modelId === 'openai/gpt-4o-mini')?.pricingType).toBe('paid');
  });

  it('recommends exactly one model per provider, and it is the catalog one', () => {
    for (const providerId of PROVIDER_IDS) {
      const recommended = modelSpecs(providerId).filter((spec) => spec.recommended);
      expect(recommended).toHaveLength(1);
      // The registry badge and the default-model dropdown must name the same
      // model, or "Recommended" points at something `defaultConfig` never picks.
      expect(recommended[0]?.modelId).toBe(
        getProviderDescriptor(providerId).models.find((model) => model.recommended)?.id,
      );
    }
  });
});

describe('per-model JSON mode (response_format gate)', () => {
  it('follows the provider-wide flag where no model-specific fact exists', () => {
    // Gemini and Groq advertise JSON mode across their catalogs.
    expect(modelSupportsJsonMode('gemini', 'gemini-3.8-flash')).toBe(true);
    expect(modelSupportsJsonMode('groq', 'openai/gpt-oss-120b')).toBe(true);
    // OpenRouter as a whole does NOT - so nothing may be assumed for it.
    expect(getProviderDescriptor('openrouter').capabilities.jsonMode).toBe(false);
  });

  it('enables JSON mode per model on OpenRouter, only where the route declares it', () => {
    const verified = [
      'openai/gpt-4o-mini',
      'anthropic/claude-sonnet-5.5',
      'google/gemini-3.5-flash',
      'google/gemma-4-31b-it:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
    ];
    for (const model of verified) {
      expect(modelSupportsJsonMode('openrouter', model), model).toBe(true);
    }

    // Routes that do not accept `response_format` must never receive it: an
    // unsupported parameter can fail the whole request.
    const rejected = [
      'thinkingmachines/inkling:free',
      'thinkingmachines/inkling-small:free',
      'nvidia/nemotron-3.5-lightning:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
    ];
    for (const model of rejected) {
      expect(modelSupportsJsonMode('openrouter', model), model).toBe(false);
    }
  });

  it('falls back to the provider flag for ids it does not know', () => {
    // Never assume for a new route or a self-hosted model id.
    expect(modelSupportsJsonMode('openrouter', 'some/new-route:free')).toBe(false);
    expect(modelSupportsJsonMode('gemini', 'gemini-experimental')).toBe(true);
    expect(modelSupportsJsonMode('openai_compatible', 'user-typed-model')).toBe(false);
  });

  it('keeps every model of a jsonMode-off provider off until verified', () => {
    const off = listProviderDescriptors().filter((descriptor) => !descriptor.capabilities.jsonMode);
    expect(off.length).toBeGreaterThan(0);
    for (const descriptor of off) {
      for (const spec of modelSpecs(descriptor.id)) {
        if (descriptor.id === 'openrouter') continue; // checked above, per model
        expect(modelSupportsJsonMode(descriptor.id, spec.modelId), `${descriptor.id}/${spec.modelId}`).toBe(false);
      }
    }
  });
});

describe('catalog overlay validation', () => {
  const validEntry: CatalogOverlayEntry = {
    providerId: 'gemini',
    modelId: 'gemini-3.8-flash',
    patch: { pricingType: 'free', contextLength: 1_000_000, supportsPDF: false },
  };

  it('accepts a well-formed catalog file and round-trips it', () => {
    const entries = validateOverlay({ version: 1, models: [validEntry] });
    expect(entries).toEqual([validEntry]);
    const roundTripped = validateOverlay(JSON.parse(serializeOverlay(entries)) as unknown);
    expect(roundTripped).toEqual(entries);
  });

  it('rejects files that are not an object with a models array', () => {
    expectInvalid(null);
    expectInvalid('not an object');
    expectInvalid({ models: 'nope' });
    expectInvalid([validEntry]);
  });

  it('rejects malformed entries', () => {
    expectInvalid({ models: ['nope'] });
    expectInvalid({ models: [{ providerId: 'gemini' }] });
    // Unknown provider.
    expectInvalid({ models: [{ ...validEntry, providerId: 'madeup' }] });
    // Missing / empty modelId.
    expectInvalid({ models: [{ ...validEntry, modelId: '' }] });
    // Unknown model for a known provider (typo guard).
    const unknownModel = expectInvalid({ models: [{ ...validEntry, modelId: 'gemini-9.9-ultra' }] });
    expect(unknownModel.message).toContain('unknown model');
    // Missing patch.
    expectInvalid({ models: [{ providerId: 'gemini', modelId: 'gemini-3.8-flash' }] });
    expectInvalid({ models: [{ ...validEntry, patch: [] }] });
  });

  it('rejects unknown fields and invalid enum/typed values', () => {
    // Unknown field.
    expectInvalid({ models: [{ ...validEntry, patch: { colour: 'red' } }] });
    // Invalid enums.
    expectInvalid({ models: [{ ...validEntry, patch: { pricingType: 'cheap' } }] });
    expectInvalid({ models: [{ ...validEntry, patch: { qualityLevel: 'ok' } }] });
    expectInvalid({ models: [{ ...validEntry, patch: { speedLevel: 'instant' } }] });
    // Invalid numbers.
    expectInvalid({ models: [{ ...validEntry, patch: { contextLength: 0 } }] });
    expectInvalid({ models: [{ ...validEntry, patch: { contextLength: Number.NaN } }] });
    expectInvalid({ models: [{ ...validEntry, patch: { maxOutputTokens: -1 } }] });
    // Non-booleans where booleans are required.
    expectInvalid({ models: [{ ...validEntry, patch: { supportsPDF: 'yes' } }] });
    expectInvalid({ models: [{ ...validEntry, patch: { freeTier: 1 } }] });
    // Empty display name.
    expectInvalid({ models: [{ ...validEntry, patch: { displayName: '  ' } }] });
  });

  it('applies an imported patch with source labelling and coherent pricing', () => {
    const overlay = validateOverlay({
      models: [
        { providerId: 'gemini', modelId: 'gemini-3.8-flash', patch: { pricingType: 'free' } },
        { providerId: 'groq', modelId: 'openai/gpt-oss-20b', patch: { supportsPDF: true } },
      ],
    });

    const flash = requireModelSpec('gemini', 'gemini-3.8-flash', { overlay });
    expect(flash.source).toBe('catalog_update');
    expect(flash.pricingType).toBe('free');
    // pricingType alone must keep the boolean flags consistent.
    expect(flash.freeTier).toBe(true);
    expect(flash.paid).toBe(false);

    // An imported capability declaration DOES enable the badge (explicit > assumed).
    const oss20 = requireModelSpec('groq', 'openai/gpt-oss-20b', { overlay });
    expect(oss20.supportsPDF).toBe(true);
    expect(oss20.source).toBe('catalog_update');

    // Models without a patch stay built-in.
    const pro = requireModelSpec('groq', 'openai/gpt-oss-120b', { overlay });
    expect(pro.source).toBe('builtin');
  });

  it('rejects unknown models in the registry lookup too', () => {
    expect(() => requireModelSpec('gemini', 'gemini-9.9-ultra')).toThrowError(AppError);
    // The provider list used by the UI matches the registry.
    expect(listProviderDescriptors().length).toBeGreaterThan(0);
  });
});
