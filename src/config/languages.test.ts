import { describe, expect, it } from 'vitest';
import {
  LANGUAGES,
  availableTargetLanguages,
  findLanguage,
  languageLabel,
} from './languages';

describe('availableTargetLanguages (Phase 4 configurable list)', () => {
  it('keeps only known codes, in catalog order', () => {
    const result = availableTargetLanguages(['ja', 'xx-invalid', 'en', 'ja']);
    expect(result.map((language) => language.code)).toEqual(['my', 'en', 'ja']);
  });

  it('always includes Burmese as the first-class target', () => {
    const result = availableTargetLanguages(['en', 'th']);
    expect(result[0]?.code).toBe('my');
    expect(result.some((language) => language.code === 'en')).toBe(true);
  });

  it('falls back to every language when the list is empty or unusable', () => {
    expect(availableTargetLanguages([])).toHaveLength(LANGUAGES.length);
    expect(availableTargetLanguages(['nope', 'also-nope'])).toHaveLength(LANGUAGES.length);
  });

  it('does not duplicate Burmese when explicitly configured', () => {
    const result = availableTargetLanguages(['my', 'my', 'en']);
    expect(result.filter((language) => language.code === 'my')).toHaveLength(1);
  });
});

describe('language helpers', () => {
  it('labels known languages and passes unknown codes through', () => {
    expect(languageLabel('my')).toContain('မြန်မာ');
    expect(languageLabel('zz')).toBe('zz');
    expect(findLanguage('th')?.englishName).toBe('Thai');
    expect(findLanguage('zz')).toBeUndefined();
  });
});
