import { describe, expect, it } from 'vitest';
import type { AppError } from '../../core/errors/appError';
import {
  buildTranslationMessages,
  instructionTokens,
  parseTranslationResponse,
} from './translationPrompt';

function captureError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected the call to throw');
}

const OPTIONS = {
  sourceLanguage: 'en',
  targetLanguage: 'my',
  documentType: 'pdf' as const,
};

describe('buildTranslationMessages', () => {
  const units = [
    { id: 'u1', text: 'Server: https://example.com' },
    { id: 'u2', text: 'Smith (2021) proved that E = mc^2.' },
  ];

  it('includes the JSON contract and every unit payload', () => {
    const messages = buildTranslationMessages(units, OPTIONS);
    expect(messages.user).toContain('"translations"');
    expect(messages.user).toContain('"u1"');
    expect(messages.user).toContain('"u2"');
    expect(messages.user).toContain('https://example.com');
    expect(messages.user).toContain('{"translations":[{"id":"<unit id>","text":"<translated text>"}]}');
  });

  it('states the Burmese-specific preservation rules for the primary use case', () => {
    const messages = buildTranslationMessages(units, OPTIONS);
    expect(messages.system).toContain('Burmese');
    expect(messages.system).toContain('Burmese numerals');
    expect(messages.user).toContain('Burmese (my)');
  });

  it('omits Burmese-only rules for other targets', () => {
    const messages = buildTranslationMessages(units, { ...OPTIONS, targetLanguage: 'de' });
    expect(messages.system).not.toContain('Burmese numerals');
    expect(messages.user).toContain('Output language: de.');
  });

  it('always demands the preservation set (numbers, code, URLs, citations, markers)', () => {
    const { system } = buildTranslationMessages(units, OPTIONS);
    for (const needle of ['numbers', 'formulas', 'code snippets', 'URLs', 'citation markers', 'Markdown']) {
      expect(system).toContain(needle);
    }
  });

  it('costs a stable number of instruction tokens', () => {
    const cost = instructionTokens(OPTIONS);
    expect(cost).toBeGreaterThan(100);
    expect(instructionTokens(OPTIONS)).toBe(cost);
  });
});

describe('glossary section (Phase 4)', () => {
  const units = [{ id: 'u1', text: 'Click the Submit button to save.' }];
  const GLOSSARY = [
    { source: 'the Submit button', preferred: 'တင်သည့်ခလုတ်', forbidden: 'တင်ရန်', notes: 'UI control' },
    { source: 'dashboard', preferred: 'ဒက်ရှ်ဘုတ်' },
  ];

  it('appends mandatory glossary rules after the fixed rules', () => {
    const { system } = buildTranslationMessages(units, { ...OPTIONS, glossary: GLOSSARY });
    expect(system).toContain('Project glossary (mandatory');
    expect(system).toContain('"the Submit button" must be translated as "တင်သည့်ခလုတ်".');
    expect(system).toContain('Never use "တင်ရန်" for this term.');
    expect(system).toContain('(UI control)');
    expect(system).toContain('"dashboard" must be translated as "ဒက်ရှ်ဘုတ်".');
    // Optional fields never render empty fragments.
    expect(system).not.toContain('undefined');
    // Placed last so the terminology reads as the final word.
    expect(system.indexOf('Project glossary')).toBeGreaterThan(system.indexOf('Respond with ONLY'));
  });

  it('emits no glossary section when rules are absent or empty', () => {
    const without = buildTranslationMessages(units, OPTIONS);
    expect(without.system).not.toContain('Project glossary');
    const empty = buildTranslationMessages(units, { ...OPTIONS, glossary: [] });
    expect(empty.system).toBe(without.system);
  });

  it('counts glossary rules in the instruction token cost (batching sees them)', () => {
    const base = instructionTokens(OPTIONS);
    const withRules = instructionTokens({ ...OPTIONS, glossary: GLOSSARY });
    expect(withRules).toBeGreaterThan(base);
  });
});

describe('parseTranslationResponse', () => {
  const expected = ['u1', 'u2'];

  it('parses the canonical shape in id order', () => {
    const result = parseTranslationResponse(
      JSON.stringify({ translations: [{ id: 'u2', text: 'ဒုတိယ' }, { id: 'u1', text: 'ပထမ' }] }),
      expected,
    );
    expect([...result.keys()]).toEqual(expected);
    expect(result.get('u1')).toBe('ပထမ');
    expect(result.get('u2')).toBe('ဒုတိယ');
  });

  it('tolerates markdown fences around the JSON', () => {
    const result = parseTranslationResponse(
      '```json\n{"translations":[{"id":"u1","text":"တစ်"},{"id":"u2","text":"နှစ်"}]}\n```',
      expected,
    );
    expect(result.size).toBe(2);
  });

  it('extracts JSON wrapped in prose (never accepts the prose itself)', () => {
    const result = parseTranslationResponse(
      'Sure! Here is the translation: {"translations":[{"id":"u1","text":"A"},{"id":"u2","text":"B"}]} Hope it helps.',
      expected,
    );
    expect(result.get('u1')).toBe('A');
  });

  it('accepts the flat {"id": "text"} fallback shape', () => {
    const result = parseTranslationResponse('{"u1":"A","u2":"B"}', expected);
    expect(result.get('u2')).toBe('B');
  });

  it('throws retryable provider_rejected for pure prose', () => {
    const error = captureError(() => parseTranslationResponse('I translated everything for you!', expected));
    expect(error.code).toBe('provider_rejected');
    expect(error.retryable).toBe(true);
  });

  it('throws when units are missing from the response', () => {
    const error = captureError(() =>
      parseTranslationResponse(JSON.stringify({ translations: [{ id: 'u1', text: 'A' }] }), expected),
    );
    expect(error.code).toBe('provider_rejected');
    expect(error.message).toContain('1 of 2');
  });

  it('throws when a returned translation is empty', () => {
    const error = captureError(() =>
      parseTranslationResponse(
        JSON.stringify({ translations: [{ id: 'u1', text: '   ' }, { id: 'u2', text: 'B' }] }),
        expected,
      ),
    );
    expect(error.code).toBe('provider_rejected');
  });

  it('drops ids that were never requested', () => {
    const result = parseTranslationResponse(
      JSON.stringify({
        translations: [
          { id: 'u1', text: 'A' },
          { id: 'u2', text: 'B' },
          { id: 'hallucinated', text: 'X' },
        ],
      }),
      expected,
    );
    expect(result.has('hallucinated')).toBe(false);
    expect(result.size).toBe(2);
  });
});
