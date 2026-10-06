import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { providerConfigsRepo } from '../db/repositories';
import { providerConfigService } from './providerConfigService';

beforeEach(async () => {
  await providerConfigsRepo.clear();
});

describe('provider config save', () => {
  it('keeps the default model inside enabledModels', async () => {
    const created = await providerConfigService.ensure('gemini');
    const initiallyEnabled = created.enabledModels ?? [];

    // Pick a real model that is not in the enabled list yet.
    const candidates = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];
    const notEnabled = candidates.find((model) => !initiallyEnabled.includes(model));
    expect(notEnabled).toBeDefined();

    const saved = await providerConfigService.save('gemini', { defaultModel: notEnabled });
    expect(saved.defaultModel).toBe(notEnabled);
    // The pool rejects models outside enabledModels, so the default must be in.
    expect(saved.enabledModels).toContain(notEnabled);
    for (const model of initiallyEnabled) {
      expect(saved.enabledModels).toContain(model);
    }
  });

  it('never persists an empty enabled-model list', async () => {
    const saved = await providerConfigService.save('gemini', { enabledModels: [] });
    expect(saved.enabledModels?.length ?? 0).toBeGreaterThan(0);
    expect(saved.defaultModel).toBeTruthy();
    expect(saved.enabledModels).toContain(saved.defaultModel);
  });

  it('applies explicit enabled-model patches verbatim otherwise', async () => {
    const saved = await providerConfigService.save('groq', {
      enabledModels: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
    });
    expect(saved.enabledModels).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  });

  it('rejects non-https base URLs', async () => {
    await expect(
      providerConfigService.save('openai_compatible', { baseUrl: 'http://insecure.example' }),
    ).rejects.toThrowError(/https/);
  });
});

describe('provider config healing', () => {
  it('replaces a stored default model the provider no longer serves', async () => {
    // A config saved before OpenRouter retired `google/gemini-2.0-flash-001`
    // (the 404 that used to fail whole translation jobs).
    await providerConfigService.save('openrouter', {
      enabled: true,
      defaultModel: 'google/gemini-2.0-flash-001',
      enabledModels: ['google/gemini-2.0-flash-001'],
    });

    const healed = await providerConfigService.ensure('openrouter');
    expect(healed.defaultModel).toBe('openai/gpt-4o-mini');
    // The replacement must be selectable too, or the key pool rejects it.
    expect(healed.enabledModels).toContain('openai/gpt-4o-mini');
    // ...and the rewrite is persisted, not just returned.
    expect((await providerConfigService.get('openrouter'))?.defaultModel).toBe('openai/gpt-4o-mini');
  });

  it('keeps the rest of the enabled-model list when healing', async () => {
    await providerConfigService.save('gemini', {
      enabled: true,
      defaultModel: 'gemini-2.0-flash',
      enabledModels: ['gemini-2.0-flash', 'gemini-3.5-flash-lite'],
    });
    const healed = await providerConfigService.ensure('gemini');
    expect(healed.defaultModel).toBe('gemini-3.8-flash');
    // The user's other choices survive; only the retired default is replaced.
    expect(healed.enabledModels).toEqual(['gemini-2.0-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash']);
  });

  it('leaves unknown models on a self-hosted OpenAI-compatible endpoint alone', async () => {
    await providerConfigService.save('openai_compatible', {
      enabled: true,
      defaultModel: 'my-endpoint-model-v2',
      enabledModels: ['my-endpoint-model-v2'],
    });
    const config = await providerConfigService.ensure('openai_compatible');
    expect(config.defaultModel).toBe('my-endpoint-model-v2');
    expect(config.enabledModels).toEqual(['my-endpoint-model-v2']);
  });
});
