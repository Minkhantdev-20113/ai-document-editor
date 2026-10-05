export interface LanguageDef {
  readonly code: string;
  /** Name written in the language itself. */
  readonly nativeName: string;
  readonly englishName: string;
  readonly rtl?: boolean;
}

/**
 * Languages the app can operate in or translate between.
 * Burmese is the primary target language; English is the secondary UI language.
 */
export const LANGUAGES: readonly LanguageDef[] = [
  { code: 'my', nativeName: 'မြန်မာ', englishName: 'Burmese' },
  { code: 'en', nativeName: 'English', englishName: 'English' },
  { code: 'zh', nativeName: '中文', englishName: 'Chinese (Simplified)' },
  { code: 'zh-Hant', nativeName: '繁體中文', englishName: 'Chinese (Traditional)' },
  { code: 'ja', nativeName: '日本語', englishName: 'Japanese' },
  { code: 'ko', nativeName: '한국어', englishName: 'Korean' },
  { code: 'th', nativeName: 'ไทย', englishName: 'Thai' },
  { code: 'vi', nativeName: 'Tiếng Việt', englishName: 'Vietnamese' },
  { code: 'id', nativeName: 'Bahasa Indonesia', englishName: 'Indonesian' },
  { code: 'hi', nativeName: 'हिन्दी', englishName: 'Hindi' },
  { code: 'ar', nativeName: 'العربية', englishName: 'Arabic', rtl: true },
  { code: 'fa', nativeName: 'فارسی', englishName: 'Persian', rtl: true },
  { code: 'fr', nativeName: 'Français', englishName: 'French' },
  { code: 'es', nativeName: 'Español', englishName: 'Spanish' },
  { code: 'de', nativeName: 'Deutsch', englishName: 'German' },
  { code: 'pt', nativeName: 'Português', englishName: 'Portuguese' },
  { code: 'ru', nativeName: 'Русский', englishName: 'Russian' },
];

export const LANGUAGE_CODES: readonly string[] = LANGUAGES.map((language) => language.code);

export const DEFAULT_SOURCE_LANGUAGE = 'en';
export const DEFAULT_TARGET_LANGUAGE = 'my';

export function findLanguage(code: string): LanguageDef | undefined {
  return LANGUAGES.find((language) => language.code === code);
}

export function languageLabel(code: string): string {
  const language = findLanguage(code);
  if (!language) return code;
  return `${language.nativeName} (${language.englishName})`;
}

/**
 * Configurable target list (Phase 4): unknown codes are dropped, duplicates
 * collapse, Burmese is always present (first-class target), and an empty or
 * unusable configuration falls back to every known language.
 */
export function availableTargetLanguages(configured: readonly string[]): readonly LanguageDef[] {
  const codes = new Set<string>();
  for (const code of configured) {
    if (findLanguage(code)) codes.add(code);
  }
  const usable = codes.size > 0 ? LANGUAGES.filter((language) => codes.has(language.code)) : LANGUAGES;
  const burmese = findLanguage(DEFAULT_TARGET_LANGUAGE);
  const rest = usable.filter((language) => language.code !== DEFAULT_TARGET_LANGUAGE);
  return burmese ? [burmese, ...rest] : usable;
}
