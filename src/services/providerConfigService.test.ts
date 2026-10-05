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
    const candidates = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'];
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
    const saved = await providerConfigService.save('deepseek', {
      enabledModels: ['deepseek-chat', 'deepseek-reasoner'],
    });
    expect(saved.enabledModels).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('rejects non-https base URLs', async () => {
    await expect(
      providerConfigService.save('openai_compatible', { baseUrl: 'http://insecure.example' }),
    ).rejects.toThrowError(/https/);
  });
});
