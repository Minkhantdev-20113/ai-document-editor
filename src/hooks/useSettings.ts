import { useCallback, useEffect, useState } from 'react';
import { LOCAL_STORAGE_KEYS } from '../config/appConfig';
import { settingsService, type AppSettings, type ThemeMode } from '../services/settingsService';

/** Reactive view over the settings service. */
export function useSettings(): {
  settings: AppSettings;
  set: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  setMany: (patch: Partial<AppSettings>) => void;
} {
  const [settings, setSettings] = useState<AppSettings>(() => settingsService.get());

  useEffect(() => {
    let cancelled = false;
    void settingsService.load().then((loaded) => {
      if (!cancelled) setSettings(loaded);
    });
    const unsubscribe = settingsService.subscribe((next) => setSettings(next));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const set = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    void settingsService.set(key, value);
  }, []);

  const setMany = useCallback((patch: Partial<AppSettings>) => {
    void settingsService.setMany(patch);
  }, []);

  return { settings, set, setMany };
}

export type ResolvedTheme = 'light' | 'dark';

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

/**
 * Applies the persisted theme to <html> and follows the OS preference while
 * `system` is selected. The pre-paint script in index.html does the first apply.
 */
export function useTheme(): {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  cycle: () => void;
} {
  const { settings, set } = useSettings();
  const mode = settings.theme;
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(mode));

  useEffect(() => {
    const apply = () => {
      const next = resolveTheme(mode);
      setResolved(next);
      document.documentElement.dataset['theme'] = next;
      document.documentElement.style.colorScheme = next;
      try {
        localStorage.setItem(LOCAL_STORAGE_KEYS.theme, mode);
      } catch {
        /* storage unavailable */
      }
    };
    apply();
    if (mode !== 'system') return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [mode]);

  const cycle = useCallback(() => {
    const order: ThemeMode[] = ['light', 'dark', 'system'];
    const index = order.indexOf(mode);
    const next = order[(index + 1) % order.length] ?? 'system';
    set('theme', next);
  }, [mode, set]);

  return { mode, resolved, setMode: (next) => set('theme', next), cycle };
}
