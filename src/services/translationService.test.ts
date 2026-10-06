import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../core/errors/appError';
import type { DocumentRecord, TranslationUnit } from '../db/entities';
import {
  apiKeysRepo,
  documentsRepo,
  glossaryEntriesRepo,
  keyRuntimeRepo,
  projectsRepo,
  providerConfigsRepo,
  translationUnitsRepo,
  usageRepo,
} from '../db/repositories';
import type {
  AIProvider,
  GenerateOptions,
  TranslationCall,
  TranslationCallResult,
} from '../providers/aiProvider';
import { getProviderDescriptor } from '../providers/registry';
import type { ProviderId } from '../providers/types';
import { keyPoolService } from './keyPoolService';
import { providerConfigService } from './providerConfigService';
import { settingsService } from './settingsService';
import { usageService } from './usageService';
import {
  DEFAULT_STRATEGY,
  isTranslationStrategy,
  TranslationService,
  type TranslationProgress,
  type TranslationServiceDeps,
} from './translationService';

const T0 = 1_700_000_000_000;
let clock = T0;

const DOCUMENT: DocumentRecord = {
  id: 'doc_1',
  projectId: 'proj_1',
  kind: 'text',
  fileName: 'notes.md',
  fileSize: 1_024,
  mimeType: 'text/markdown',
  lastModified: T0,
  checksum: null,
  payload: null,
  payloadStored: false,
  sourceLanguage: 'en',
  targetLanguage: 'my',
  pageCount: 1,
  charCount: 2_000,
  inspectionState: 'ready',
  createdAt: T0,
  updatedAt: T0,
};

function makeUnit(index: number, overrides: Partial<TranslationUnit> = {}): TranslationUnit {
  return {
    id: `u_${index}`,
    projectId: 'proj_1',
    documentId: 'doc_1',
    pageId: 'page_1',
    blockId: `b_${index}`,
    orderIndex: index,
    sourceText: `Source sentence number ${index}. It exists so translation has real work to do.`,
    sourceLanguage: 'en',
    targetLanguage: 'my',
    translatedText: null,
    status: 'pending',
    retryCount: 0,
    provider: null,
    model: null,
    keyId: null,
    estimatedTokens: null,
    actualTokens: null,
    error: null,
    sourceChecksum: 'checksum',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

async function seedKey(id: string, providerId: ProviderId): Promise<void> {
  await apiKeysRepo.put({
    id,
    providerId,
    label: id,
    hint: 'AIza••••test',
    status: 'valid',
    lastVerifiedAt: T0,
    lastUsedAt: null,
    createdAt: T0,
    updatedAt: T0,
  });
}

async function enableProvider(providerId: ProviderId, model: string): Promise<void> {
  await providerConfigService.save(providerId, {
    enabled: true,
    defaultModel: model,
    enabledModels: [model],
  });
}

type TranslateHandler = (
  call: TranslationCall,
  options?: GenerateOptions,
) => Promise<TranslationCallResult>;
type Handlers = Partial<Record<ProviderId, TranslateHandler>>;

function fakeProvider(providerId: ProviderId, translate: TranslateHandler): AIProvider {
  return {
    id: providerId,
    descriptor: getProviderDescriptor(providerId),
    defaultModel: null,
    // The engine only ever calls `translate`; the rest exist so the fake
    // satisfies the full contract without `as`-casts hiding real mistakes.
    validateKey: () => {
      throw new Error('not used by the translation engine');
    },
    listModels: () => Promise.resolve([]),
    getCapabilities: () => ({ chat: true, vision: false, jsonMode: true, streaming: false, pdf: false }),
    estimateTokens: (text: string) => Math.ceil(text.length / 4),
    generate: () => {
      throw new Error('not used by the translation engine');
    },
    translate,
    getUsage: () =>
      Promise.resolve({
        providerReported: false,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        asOf: T0,
      }),
    getRateLimitState: () => {
      throw new Error('not used by the translation engine');
    },
    classifyError: () => {
      throw new Error('not used by the translation engine');
    },
  };
}

function successResult(call: TranslationCall): TranslationCallResult {
  return {
    translations: new Map(call.units.map((unit) => [unit.id, `«${unit.text}»`])),
    model: call.model,
    keyId: 'k_pool',
    usage: { inputTokens: 120, outputTokens: 80, cachedTokens: 0 },
    structured: true,
  };
}

interface Harness {
  readonly service: TranslationService;
  /** Backoff waits the engine took (injectable - no real timers). */
  readonly waits: number[];
}

function makeService(handlers: Handlers, extra: Partial<TranslationServiceDeps> = {}): Harness {
  const waits: number[] = [];
  const service = new TranslationService({
    createProvider: async (providerId) => {
      const handler = handlers[providerId];
      if (!handler) throw new Error(`unexpected provider requested: ${providerId}`);
      return fakeProvider(providerId, handler);
    },
    random: () => 0.5,
    now: () => clock,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    ...extra,
  });
  return { service, waits };
}

async function unitsOf(): Promise<TranslationUnit[]> {
  const units = (await translationUnitsRepo.queryByIndex('by_document', 'doc_1')) ?? [];
  return units.sort((a, b) => a.orderIndex - b.orderIndex);
}

beforeEach(async () => {
  clock = T0;
  await projectsRepo.clear();
  await documentsRepo.clear();
  await translationUnitsRepo.clear();
  await glossaryEntriesRepo.clear();
  await providerConfigsRepo.clear();
  await apiKeysRepo.clear();
  await keyRuntimeRepo.clear();
  await usageRepo.clear();
  await documentsRepo.put(DOCUMENT);
  // Opt-in features default off; individual tests enable them explicitly.
  await settingsService.set('memoryAutoApply', false);
});

describe('translation engine (Phase 3)', () => {
  it('translates every pending unit and records provider-reported usage', async () => {
    await translationUnitsRepo.putMany([makeUnit(1), makeUnit(2), makeUnit(3)]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    const received: string[][] = [];
    const { service } = makeService({
      gemini: async (call) => {
        received.push(call.units.map((unit) => unit.id));
        return successResult(call);
      },
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    expect(outcome.translated).toBe(3);
    expect(outcome.skipped).toBe(0);
    expect(outcome.failed).toBe(0);
    expect(outcome.providerId).toBe('gemini');
    expect(outcome.model).toBe('gemini-3.8-flash');
    expect(received.flat()).toEqual(['u_1', 'u_2', 'u_3']);

    const units = await unitsOf();
    for (const unit of units) {
      expect(unit.status).toBe('translated');
      expect(unit.translatedText).toContain('«');
      expect(unit.provider).toBe('gemini');
      expect(unit.keyId).toBe('k_pool');
      expect(unit.error).toBeNull();
    }

    const usage = await usageService.totalsFor('gemini');
    expect(usage.providerReported).toBe(true);
    expect(usage.requests).toBe(1);
    expect(usage.inputTokens).toBe(120);
    expect(usage.outputTokens).toBe(80);
  });

  it('sends the project glossary with every batch call (Phase 4)', async () => {
    await translationUnitsRepo.putMany([makeUnit(1), makeUnit(2)]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');
    await glossaryEntriesRepo.put({
      id: 'glo_1',
      projectId: 'proj_1',
      sourceTerm: 'the Submit button',
      preferredTranslation: 'တင်သည့်ခလုတ်',
      forbiddenTranslation: 'တင်ရန်',
      notes: 'UI control',
      createdAt: T0,
      updatedAt: T0,
    });

    const calls: TranslationCall[] = [];
    const { service } = makeService({
      gemini: async (call) => {
        calls.push(call);
        return successResult(call);
      },
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.glossary).toEqual([
        {
          source: 'the Submit button',
          preferred: 'တင်သည့်ခလုတ်',
          forbidden: 'တင်ရန်',
          notes: 'UI control',
        },
      ]);
    }
  });

  it('omits the glossary field entirely when the project has no rules', async () => {
    await translationUnitsRepo.putMany([makeUnit(1)]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    const calls: TranslationCall[] = [];
    const { service } = makeService({
      gemini: async (call) => {
        calls.push(call);
        return successResult(call);
      },
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    expect(calls.length).toBe(1);
    expect('glossary' in (calls[0] ?? {})).toBe(false);
  });

  it('never touches manually edited units on a later run (Phase 4)', async () => {
    await translationUnitsRepo.putMany([
      makeUnit(1, {
        status: 'translated',
        translatedText: 'လူကိုယ်တိုင် ပြင်ဆင်ထားသော စာသား',
        editedAt: T0 + 5,
        provider: null,
        model: null,
      }),
      makeUnit(2),
    ]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    const received: string[][] = [];
    const { service } = makeService({
      gemini: async (call) => {
        received.push(call.units.map((unit) => unit.id));
        return successResult(call);
      },
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    expect(outcome.skipped).toBe(1);
    expect(outcome.translated).toBe(1);
    // The manual unit never reached the provider and kept its exact text.
    expect(received.flat()).toEqual(['u_2']);
    const manual = (await unitsOf()).find((unit) => unit.id === 'u_1');
    expect(manual?.translatedText).toBe('လူကိုယ်တိုင် ပြင်ဆင်ထားသော စာသား');
    expect(manual?.editedAt).toBe(T0 + 5);
    expect(manual?.status).toBe('translated');
  });

  it('fills high-confidence memory matches locally when opted in (Phase 4)', async () => {
    await settingsService.set('memoryAutoApply', true);
    const boilerplate = 'Click the Submit button to save the document.';
    await translationUnitsRepo.putMany([
      makeUnit(1, {
        sourceText: boilerplate,
        status: 'translated',
        translatedText: 'စာရွက်သိမ်းရန် တင်သည့်ခလုတ်ကို နှိပ်ပါ',
        provider: 'gemini',
      }),
      makeUnit(2, { sourceText: boilerplate }),
      makeUnit(3, { sourceText: 'A completely different sentence about the weather in Mandalay.' }),
    ]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    const calls: TranslationCall[] = [];
    const { service } = makeService({
      gemini: async (call) => {
        calls.push(call);
        return successResult(call);
      },
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    expect(outcome.memoryFilled).toBe(1);
    expect(outcome.translated).toBe(1);
    // Only the unmatched unit reached the provider.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.units.map((unit) => unit.id)).toEqual(['u_3']);

    const units = await unitsOf();
    const filled = units.find((unit) => unit.id === 'u_2');
    expect(filled?.status).toBe('translated');
    expect(filled?.translatedText).toBe('စာရွက်သိမ်းရန် တင်သည့်ခလုတ်ကို နှိပ်ပါ');
    // Honest provenance: no AI produced this text.
    expect(filled?.provider).toBeNull();
    expect(filled?.model).toBeNull();
    expect(filled?.error).toBeNull();

    // Memory fills cost nothing; the single provider batch is the only usage.
    const usage = await usageService.totalsFor('gemini');
    expect(usage.requests).toBe(1);
  });

  it('sends every pending unit to the provider when memory auto-apply is off (default)', async () => {
    const boilerplate = 'Click the Submit button to save the document.';
    await translationUnitsRepo.putMany([
      makeUnit(1, {
        sourceText: boilerplate,
        status: 'translated',
        translatedText: 'စာရွက်သိမ်းရန် တင်သည့်ခလုတ်ကို နှိပ်ပါ',
      }),
      makeUnit(2, { sourceText: boilerplate }),
    ]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    const calls: TranslationCall[] = [];
    const { service } = makeService({
      gemini: async (call) => {
        calls.push(call);
        return successResult(call);
      },
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    expect(outcome.memoryFilled).toBe(0);
    expect(outcome.translated).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.units.map((unit) => unit.id)).toEqual(['u_2']);
    // The unit got an AI translation, not the memory one.
    const unit = (await unitsOf()).find((entry) => entry.id === 'u_2');
    expect(unit?.translatedText).toContain('«');
    expect(unit?.provider).toBe('gemini');
  });

  it('applies the strategy temperature to every request (Phase 4)', async () => {
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');
    const temperatures: Array<number | undefined> = [];
    const { service } = makeService({
      gemini: async (call, options) => {
        temperatures.push(options?.temperature);
        return successResult(call);
      },
    });

    // Default strategy (standard) -> 0.2.
    await translationUnitsRepo.put(makeUnit(1));
    expect((await service.translateDocument({ documentId: 'doc_1' })).status).toBe('completed');
    // precise -> 0.1 (stricter preservation).
    await translationUnitsRepo.put(makeUnit(1));
    expect(
      (await service.translateDocument({ documentId: 'doc_1', strategy: 'precise' })).status,
    ).toBe('completed');
    // draft -> 0.4 (freer, throughput-first).
    await translationUnitsRepo.put(makeUnit(1));
    expect(
      (await service.translateDocument({ documentId: 'doc_1', strategy: 'draft' })).status,
    ).toBe('completed');

    expect(temperatures).toEqual([0.2, 0.1, 0.4]);
  });

  it('rejects unknown strategy values instead of passing them on', () => {
    expect(isTranslationStrategy('draft')).toBe(true);
    expect(isTranslationStrategy('standard')).toBe(true);
    expect(isTranslationStrategy('precise')).toBe(true);
    expect(isTranslationStrategy('turbo')).toBe(false);
    expect(isTranslationStrategy(undefined)).toBe(false);
    expect(isTranslationStrategy(7)).toBe(false);
    expect(DEFAULT_STRATEGY).toBe('standard');
  });

  it('runs validation after a completed run and persists findings (Phase 4)', async () => {
    await translationUnitsRepo.putMany([makeUnit(1), makeUnit(2)]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    // A model that drops every number and repeats itself - exactly what
    // validation must catch without touching the text.
    const { service } = makeService({
      gemini: async (call) => ({
        translations: new Map(call.units.map((unit) => [unit.id, 'ဘာသာပြန်ချက် စာသား'])),
        model: call.model,
        keyId: 'k_pool',
        usage: { inputTokens: 10, outputTokens: 10, cachedTokens: 0 },
        structured: true,
      }),
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    for (const unit of await unitsOf()) {
      const codes = (unit.warnings ?? []).map((warning) => warning.code);
      expect(codes).toContain('numbers_changed');
      expect(codes).toContain('duplicated_text');
    }
  });

  it('records the provider text as the AI suggestion (Phase 4)', async () => {
    await translationUnitsRepo.putMany([makeUnit(1)]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');
    const { service } = makeService({ gemini: async (call) => successResult(call) });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    const units = await unitsOf();
    // The provider's wording is kept as the inspectable "AI suggestion" even
    // though a later manual edit may replace `translatedText`.
    expect(units[0]?.aiText).toBe(units[0]?.translatedText);
    expect(units[0]?.aiText).toBeTruthy();
    expect(units[0]?.editedAt).toBeNull();
  });

  it('handles a mixed-language technical document (Phase 4)', async () => {
    await translationUnitsRepo.putMany([
      makeUnit(1, {
        sourceText: 'The API key (sk-123) at https://example.com/docs costs 5 USD per month.',
      }),
      makeUnit(2, {
        sourceText: 'The ကူးညီ converter handles both English and မြန်မာ text.',
      }),
    ]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');
    // Fake model that echoes every token through - preservation by design.
    const { service } = makeService({
      gemini: async (call) => ({
        translations: new Map(call.units.map((unit) => [unit.id, `ဘာသာပြန်ချက် ${unit.text}`])),
        model: call.model,
        keyId: 'k_pool',
        usage: { inputTokens: 20, outputTokens: 20, cachedTokens: 0 },
        structured: true,
      }),
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    expect(outcome.translated).toBe(2);
    // Nothing that must survive a mixed-language run may trip validation.
    for (const unit of await unitsOf()) {
      const codes = (unit.warnings ?? []).map((warning) => warning.code);
      expect(codes).not.toContain('numbers_changed');
      expect(codes).not.toContain('urls_changed');
      expect(codes).not.toContain('code_changed');
      expect(codes).not.toContain('structure_mismatch');
      expect(codes).not.toContain('untranslated');
    }
  });

  it('waits for connectivity after an offline error, then retries (Phase 4)', async () => {
    await translationUnitsRepo.putMany([makeUnit(1)]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    const onlineWaits: number[] = [];
    let attempts = 0;
    const { service, waits } = makeService(
      {
        gemini: async (call) => {
          attempts += 1;
          if (attempts === 1) {
            throw new AppError('You are offline', { code: 'network_offline', retryable: true });
          }
          return successResult(call);
        },
      },
      {
        waitForOnline: async () => {
          onlineWaits.push(attempts);
        },
      },
    );

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    expect(outcome.translated).toBe(1);
    // Offline pauses AI requests exactly once, then the normal retry runs.
    expect(onlineWaits).toEqual([1]);
    expect(waits.length).toBeGreaterThanOrEqual(1);
    const units = await unitsOf();
    expect(units[0]?.status).toBe('translated');
    expect(units[0]?.error).toBeNull();
  });

  it('reports page/unit progress with provider, model and key id (Phase 4)', async () => {
    await translationUnitsRepo.putMany([makeUnit(1), makeUnit(2)]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    const events: TranslationProgress[] = [];
    const { service } = makeService({ gemini: async (call) => successResult(call) });
    const outcome = await service.translateDocument({
      documentId: 'doc_1',
      onProgress: (progress) => events.push(progress),
    });

    expect(outcome.status).toBe('completed');
    expect(events).toHaveLength(1); // one batch -> one progress tick
    const last = events.at(-1);
    expect(last?.processed).toBe(2);
    expect(last?.total).toBe(2);
    expect(last?.batchIndex).toBe(1);
    expect(last?.batchCount).toBe(1);
    expect(last?.providerId).toBe('gemini');
    expect(last?.model).toBe('gemini-3.8-flash');
    // The key id (masked by the UI) - never the key itself.
    expect(last?.keyId).toBe('k_pool');
    // All units share one page here: 1/1 complete.
    expect(last?.totalPages).toBe(1);
    expect(last?.completedPages).toBe(1);
  });

  it('skips units already translated on resume', async () => {
    await translationUnitsRepo.putMany([
      makeUnit(1, { status: 'translated', translatedText: 'ယခင်ဘာသာပြန်ပြီး' }),
      makeUnit(2, { status: 'translated', translatedText: 'ယခင်ဘာသာပြန်ပြီး' }),
      makeUnit(3),
    ]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    const received: string[][] = [];
    const { service } = makeService({
      gemini: async (call) => {
        received.push(call.units.map((unit) => unit.id));
        return successResult(call);
      },
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    expect(outcome.translated).toBe(1);
    expect(outcome.skipped).toBe(2);
    expect(received.flat()).toEqual(['u_3']);
  });

  it('retries a 429 with jittered backoff - never a tight loop', async () => {
    await translationUnitsRepo.putMany([makeUnit(1)]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    let attempts = 0;
    const { service, waits } = makeService({
      gemini: async (call) => {
        attempts += 1;
        if (attempts === 1) {
          throw new AppError('429 Too Many Requests', {
            code: 'provider_rate_limited',
            retryable: true,
          });
        }
        return successResult(call);
      },
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    expect(attempts).toBe(2);
    expect(waits).toHaveLength(1);
    // attempt 0 -> base 5s, jittered into [2.5s, 5s]
    expect(waits[0]).toBeGreaterThanOrEqual(2_500);
    expect(waits[0]).toBeLessThanOrEqual(5_000);
  });

  it('recovers from timeout and network failures on the same provider', async () => {
    await translationUnitsRepo.putMany([makeUnit(1)]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    const failures = [
      new AppError('request timed out', { code: 'provider_timeout', retryable: true }),
      new AppError('network unreachable', { code: 'network_offline', retryable: true }),
    ];
    const { service, waits } = makeService({
      gemini: async (call) => {
        const next = failures.shift();
        if (next) throw next;
        return successResult(call);
      },
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    expect(outcome.translated).toBe(1);
    expect(failures).toHaveLength(0);
    expect(waits).toHaveLength(2);
    for (const waitMs of waits) expect(waitMs).toBeGreaterThanOrEqual(2_500);
  });

  it('fails over to the next provider when a key is rejected', async () => {
    await translationUnitsRepo.putMany([makeUnit(1), makeUnit(2)]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await enableProvider('groq', 'openai/gpt-oss-120b');
    await seedKey('k_gemini', 'gemini');
    await seedKey('k_groq', 'groq');

    let geminiCalls = 0;
    const { service } = makeService({
      gemini: async () => {
        geminiCalls += 1;
        throw new AppError('The API key was rejected', {
          code: 'provider_invalid_key',
          retryable: false,
        });
      },
      groq: async (call) => successResult(call),
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    expect(outcome.providerId).toBe('groq');
    // Configuration problems fail over immediately - no wasted retries.
    expect(geminiCalls).toBe(1);

    const units = await unitsOf();
    expect(units.every((unit) => unit.provider === 'groq')).toBe(true);
  });

  it('fails units with their error when nothing can serve them, then resumes', async () => {
    await translationUnitsRepo.putMany([makeUnit(1), makeUnit(2), makeUnit(3)]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    const rejecting = makeService({
      gemini: async () => {
        throw new AppError('content policy refusal', {
          code: 'provider_content_policy',
          retryable: false,
        });
      },
    });
    const failedRun = await rejecting.service.translateDocument({ documentId: 'doc_1' });

    expect(failedRun.status).toBe('failed');
    expect(failedRun.failed).toBe(3);
    expect(failedRun.translated).toBe(0);
    const failedUnits = await unitsOf();
    expect(failedUnits.every((unit) => unit.status === 'failed')).toBe(true);
    expect(failedUnits[0]?.error?.code).toBe('provider_content_policy');

    // Recovery: a later run (new session) picks the failed units up again.
    const { service } = makeService({ gemini: async (call) => successResult(call) });
    const recovered = await service.translateDocument({ documentId: 'doc_1' });

    expect(recovered.status).toBe('completed');
    expect(recovered.translated).toBe(3);
    expect(recovered.skipped).toBe(0);
    expect((await unitsOf()).every((unit) => unit.status === 'translated')).toBe(true);
  });

  it('a refresh mid-translation keeps completed units and resumes the rest', async () => {
    const many = Array.from({ length: 40 }, (_, index) => makeUnit(index + 1));
    await translationUnitsRepo.putMany(many);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    // 40 units exceed the 32-unit batch cap -> two batches, so the first run
    // can be interrupted after real work is persisted.
    const controller = new AbortController();
    let progressCalls = 0;
    const first = makeService({ gemini: async (call) => successResult(call) });
    const outcome1 = await first.service.translateDocument({
      documentId: 'doc_1',
      signal: controller.signal,
      onProgress: () => {
        progressCalls += 1;
        if (progressCalls === 1) controller.abort(); // simulate refresh/close
      },
    });

    expect(outcome1.status).toBe('aborted');
    expect(outcome1.translated).toBe(32);

    const afterAbort = await unitsOf();
    expect(afterAbort.filter((unit) => unit.status === 'translated')).toHaveLength(32);
    expect(afterAbort.filter((unit) => unit.status === 'pending')).toHaveLength(8);

    // "Reload": a fresh instance with a differently-behaved provider.
    const received: string[][] = [];
    const second = makeService({
      gemini: async (call) => {
        received.push(call.units.map((unit) => unit.id));
        return {
          ...successResult(call),
          translations: new Map(call.units.map((unit) => [unit.id, `SECOND:${unit.id}`])),
        };
      },
    });
    const outcome2 = await second.service.translateDocument({ documentId: 'doc_1' });

    expect(outcome2.status).toBe('completed');
    expect(outcome2.translated).toBe(8);
    expect(outcome2.skipped).toBe(32);
    // Exactly the unfinished units were re-sent - no duplicate work.
    expect(received.flat()).toEqual(Array.from({ length: 8 }, (_, i) => `u_${33 + i}`));

    const finalUnits = await unitsOf();
    // Earlier results survive the reload untouched.
    expect(finalUnits[0]?.translatedText).toContain('«');
    expect(finalUnits[39]?.translatedText).toBe('SECOND:u_40');
    expect(finalUnits.every((unit) => unit.status === 'translated')).toBe(true);
  });

  it('pauses when every candidate provider reports quota exhausted', async () => {
    await translationUnitsRepo.putMany([makeUnit(1), makeUnit(2)]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await enableProvider('groq', 'openai/gpt-oss-120b');
    await seedKey('k_gemini', 'gemini');
    await seedKey('k_groq', 'groq');

    const quotaError = (): never => {
      throw new AppError('You exceeded your current quota', {
        code: 'provider_quota_exceeded',
        retryable: false,
      });
    };
    const { service } = makeService({
      gemini: async () => quotaError(),
      groq: async () => quotaError(),
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('paused_quota');
    expect(outcome.translated).toBe(0);
    // Quota is not a content failure: units stay resumable, not failed.
    const units = await unitsOf();
    expect(units.every((unit) => unit.status === 'in_progress' || unit.status === 'pending')).toBe(true);
  });

  it('stays paused while every key is quota-cooled (resume does not fail)', async () => {
    await translationUnitsRepo.putMany([makeUnit(1)]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await enableProvider('groq', 'openai/gpt-oss-120b');
    await seedKey('k_gemini', 'gemini');
    await seedKey('k_groq', 'groq');

    for (const [keyId, providerId] of [
      ['k_gemini', 'gemini'],
      ['k_groq', 'groq'],
    ] as const) {
      await keyPoolService.recordFailure(keyId, {
        error: new AppError('You exceeded your current quota', {
          code: 'provider_quota_exceeded',
          retryable: false,
        }),
        errorClass: 'quota_exceeded',
        tokens: 0,
      });
      expect(await keyPoolService.isQuotaExhausted(providerId)).toBe(true);
    }

    let providerCalls = 0;
    const mustNotRun = async (): Promise<TranslationCallResult> => {
      providerCalls += 1;
      throw new Error('quota-cooled pools must never be called');
    };
    const { service } = makeService({ gemini: mustNotRun, groq: mustNotRun });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('paused_quota');
    // Nothing was even attempted: quota-cooled pools are excluded up front.
    expect(providerCalls).toBe(0);
  });

  it('fails loudly when no provider with usable keys is configured', async () => {
    await translationUnitsRepo.putMany([makeUnit(1)]);

    let providerCalls = 0;
    const mustNotRun = async (): Promise<TranslationCallResult> => {
      providerCalls += 1;
      throw new Error('provider must not be called without keys');
    };
    const { service } = makeService({ gemini: mustNotRun });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('provider_unavailable');
    expect(providerCalls).toBe(0);
  });

  it('stops after the first batch when the configured model is unavailable', async () => {
    await translationUnitsRepo.putMany(Array.from({ length: 40 }, (_, index) => makeUnit(index + 1)));
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    let providerCalls = 0;
    const { service } = makeService({
      gemini: async () => {
        providerCalls += 1;
        throw new AppError('No endpoints found for the requested model.', {
          code: 'provider_invalid_model',
          retryable: false,
        });
      },
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('failed');
    // 40 units plan as two batches (32 + 8). The configuration error must not
    // be repeated on every batch: the old behaviour issued one doomed request
    // after another until the whole document was marked failed.
    expect(providerCalls).toBe(1);
    expect(outcome.error?.code).toBe('provider_invalid_model');
    // The message names the model and where to change it.
    expect(outcome.error?.message).toContain('gemini-3.8-flash');
    expect(outcome.error?.message).toContain('Google Gemini');

    const units = await unitsOf();
    expect(units.filter((unit) => unit.status === 'failed')).toHaveLength(32);
    // The batch that never ran stays pending, so fixing the model and
    // re-running translates everything.
    expect(units.filter((unit) => unit.status === 'pending')).toHaveLength(8);
  });

  it('attempts oversized units alone and flags them instead of dropping them', async () => {
    const oversized = makeUnit(2, { sourceText: 'x'.repeat(45_000) });
    await translationUnitsRepo.putMany([makeUnit(1), oversized]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    const batchSizes: number[] = [];
    const { service } = makeService({
      gemini: async (call) => {
        batchSizes.push(call.units.length);
        return successResult(call);
      },
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    expect(outcome.translated).toBe(2);
    expect(outcome.oversizedUnitIds).toContain('u_2');
    // The oversized unit went out in its own request, not as part of a batch.
    expect(batchSizes).toContain(1);
    expect((await unitsOf()).find((unit) => unit.id === 'u_2')?.status).toBe('translated');
  });

  it('halves a rejected batch instead of failing its units - and never backs off', async () => {
    await translationUnitsRepo.putMany([makeUnit(1), makeUnit(2), makeUnit(3)]);
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    const batchSizes: number[] = [];
    const { service, waits } = makeService({
      gemini: async (call) => {
        batchSizes.push(call.units.length);
        // A chatty model: it only copes with the JSON contract on short input.
        if (call.units.length > 1) {
          throw new AppError('Translation response was not valid JSON [finish_reason=stop]', {
            code: 'provider_rejected',
            retryable: true,
          });
        }
        return successResult(call);
      },
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    expect(outcome.translated).toBe(3);
    // 3 -> (1 + 2) -> 1 + 1 + 1: every surviving request carried one unit.
    expect(batchSizes.filter((size) => size === 1)).toHaveLength(3);
    expect(batchSizes).toContain(3);
    expect(batchSizes.every((size) => size <= 3)).toBe(true);
    // A contract failure is not transient: no 5s/10s/20s/40s ladder.
    expect(waits).toHaveLength(0);
    expect((await unitsOf()).every((unit) => unit.status === 'translated')).toBe(true);
  });

  it('runs the batches after the canary in parallel', async () => {
    // 70 units plan as three batches (32 + 32 + 6): one canary, two in flight.
    await translationUnitsRepo.putMany(Array.from({ length: 70 }, (_, index) => makeUnit(index + 1)));
    await enableProvider('gemini', 'gemini-3.8-flash');
    await seedKey('k_gemini', 'gemini');

    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let release: (() => void) | null = null;
    const overlap = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Sequential execution would still finish, just slowly - and fail below.
    const failSafe = new Promise<void>((resolve) => {
      setTimeout(resolve, 1_000);
    });

    const { service } = makeService({
      gemini: async (call) => {
        calls += 1;
        if (calls === 1) return successResult(call); // canary runs alone
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (inFlight >= 2) release?.();
        await Promise.race([overlap, failSafe]);
        inFlight -= 1;
        return successResult(call);
      },
    });

    const outcome = await service.translateDocument({ documentId: 'doc_1' });

    expect(outcome.status).toBe('completed');
    expect(outcome.translated).toBe(70);
    expect(calls).toBe(3);
    // Two batches were in flight at the same time.
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });
});
