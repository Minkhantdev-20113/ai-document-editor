import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { settingsService, type UiLanguage } from '../services/settingsService';
import { en } from './dict/en';
import { my } from './dict/my';
import { flattenDictionary, formatTemplate, type TranslationParams } from './translate';
import type { Dictionary, Locale } from './types';

const DICTIONARIES: Record<Locale, Dictionary> = { my, en };

const FLAT: Record<Locale, Record<string, string>> = {
  my: flattenDictionary(my),
  en: flattenDictionary(en),
};

export type TranslateFn = (key: string, params?: TranslationParams) => string;

interface I18nContextValue {
  locale: Locale;
  t: TranslateFn;
  dictionary: Dictionary;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function resolveLocale(value: UiLanguage): Locale {
  return value === 'en' ? 'en' : 'my';
}

/**
 * Localization.
 *
 * The active locale follows the persisted `language` setting. Lookup failures
 * return the key itself (visible, non-breaking) and warn in dev builds only.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() =>
    resolveLocale(settingsService.get().language),
  );

  useEffect(() => {
    let cancelled = false;
    void settingsService.load().then((settings) => {
      if (!cancelled) setLocaleState(resolveLocale(settings.language));
    });
    const unsubscribe = settingsService.subscribe((settings) => {
      setLocaleState(resolveLocale(settings.language));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    void settingsService.set('language', next === 'en' ? 'en' : 'my');
  }, []);

  const value = useMemo<I18nContextValue>(() => {
    const table = FLAT[locale];
    const t: TranslateFn = (key, params) => {
      const template = table[key];
      if (template === undefined) {
        if (import.meta.env.DEV) console.warn(`[i18n] missing key: ${key}`);
        return key;
      }
      return formatTemplate(template, params);
    };
    return { locale, t, dictionary: DICTIONARIES[locale], setLocale };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside <I18nProvider>');
  return context;
}

/** Convenience hook for the common `t` case. */
export function useT(): TranslateFn {
  return useI18n().t;
}
