import { describe, expect, it } from 'vitest';
import { AppError } from '../core/errors/appError';
import { getProviderDescriptor, listProviderDescriptors } from './registry';
import { PROVIDER_IDS } from './types';
import {
  allModelSpecs,
  modelSpecs,
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
