import type { Locale } from './types';
import { en } from './dict/en';
import { flattenDictionary, formatTemplate, type TranslationParams } from './translate';

const FLAT_EN = flattenDictionary(en);

/** Intl locale used for number/date formatting per UI language. */
export function intlLocale(locale: Locale): string {
  return locale === 'my' ? 'my-MM' : 'en-US';
}

/**
 * Fallback translator for non-React code (workers, services).
 * Uses the English dictionary and degrades to the key itself.
 */
export function translateStatic(key: string, params?: TranslationParams): string {
  const template = FLAT_EN[key];
  if (template === undefined) return key;
  return formatTemplate(template, params);
}
