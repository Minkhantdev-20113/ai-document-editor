import { LOCAL_STORAGE_KEYS } from '../config/appConfig';
import { LANGUAGES } from '../config/languages';
import { appEvents } from '../core/events/eventBus';
import { logger } from '../core/logging/logger';
import { settingsRepo } from '../db/repositories';
import type { SettingValue } from '../db/entities';
import { isBurmeseFontId, isLatinFontId, type BurmeseFontId, type LatinFontId } from '../domain/export/fonts';

export type ThemeMode = 'light' | 'dark' | 'system';
export type UiLanguage = 'my' | 'en';

/**
 * The typed view over the `settings` store.
 * Every field has a default, so the app is fully usable before any record
 * exists and when IndexedDB is unavailable.
 */
export interface AppSettings {
  theme: ThemeMode;
  language: UiLanguage;
  sidebarCollapsed: boolean;
  queueConcurrency: number;
  jobMaxAttempts: number;
  vaultAutoLockMs: number;
  defaultSourceLanguage: string;
  defaultTargetLanguage: string;
  syncEndpoint: string | null;
  syncEnabled: boolean;
  retainErrorLogs: boolean;
  usageTrackingEnabled: boolean;
  /** Serialized model-catalog overlay (validateOverlay JSON) or null = built-in. */
  modelCatalog: string | null;
  /** Codes from `LANGUAGES` offered as targets; Burmese is always first. */
  targetLanguages: readonly string[];
  /**
   * Translation memory auto-apply: use >= MEMORY_THRESHOLDS.autoApply matches
   * instead of asking the provider. Off by default - suggestions only.
   */
  memoryAutoApply: boolean;
  /** Export font families (Phase 5): Latin default + bundled Burmese face. */
  exportLatinFont: LatinFontId;
  exportBurmeseFont: BurmeseFontId;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = {
  theme: 'system',
  language: 'my',
  sidebarCollapsed: false,
  queueConcurrency: 2,
  jobMaxAttempts: 5,
  vaultAutoLockMs: 15 * 60 * 1000,
  defaultSourceLanguage: 'en',
  defaultTargetLanguage: 'my',
  syncEndpoint: null,
  syncEnabled: false,
  retainErrorLogs: true,
  usageTrackingEnabled: true,
  modelCatalog: null,
  targetLanguages: LANGUAGES.map((language) => language.code),
  memoryAutoApply: false,
  exportLatinFont: 'times',
  exportBurmeseFont: 'padauk',
};

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as readonly (keyof AppSettings)[];

type SettingsListener = (settings: AppSettings, changed: readonly (keyof AppSettings)[]) => void;

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function coerce<T>(key: keyof AppSettings, raw: SettingValue | undefined): T {
  const fallback = DEFAULT_SETTINGS[key];
  if (raw === undefined || raw === null) return fallback as T;
  if (typeof fallback === 'boolean') return (typeof raw === 'boolean' ? raw : fallback) as T;
  if (typeof fallback === 'number') return (typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback) as T;
  if (key === 'theme') return (isThemeMode(raw) ? raw : fallback) as T;
  if (Array.isArray(fallback)) {
    const valid = Array.isArray(raw) && raw.every((value) => typeof value === 'string');
    return (valid ? raw : fallback) as T;
  }
  if (key === 'exportLatinFont') return (isLatinFontId(raw) ? raw : fallback) as T;
  if (key === 'exportBurmeseFont') return (isBurmeseFontId(raw) ? raw : fallback) as T;
  if (typeof fallback === 'string' || fallback === null) {
    if (key === 'syncEndpoint') return (typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null) as T;
    return (typeof raw === 'string' ? raw : fallback) as T;
  }
  return fallback as T;
}

/**
 * Settings are persisted per key in IndexedDB, mirrored to localStorage for
 * pre-paint theme/language resolution, and broadcast to subscribers.
 */
class SettingsService {
  private settings: AppSettings = { ...DEFAULT_SETTINGS };
  private cacheLoaded = false;
  private loadPromise: Promise<AppSettings> | null = null;
  private readonly listeners = new Set<SettingsListener>();

  /** Synchronous read - safe during render (falls back to defaults). */
  get(): AppSettings {
    if (!this.cacheLoaded) {
      this.settings = { ...DEFAULT_SETTINGS, ...this.readLocalCache() };
      this.cacheLoaded = true;
    }
    return { ...this.settings };
  }

  value<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.get()[key];
  }

  /** Full load from IndexedDB. Safe to call multiple times. */
  load(): Promise<AppSettings> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDatabase()
        .catch((error: unknown) => {
          logger.warn('Settings load failed; using defaults', { error: String(error) });
          return this.get();
        })
        .then((settings) => {
          this.settings = settings;
          this.cacheLoaded = true;
          this.writeLocalCache(settings);
          this.notify([], false);
          return { ...settings };
        });
    }
    return this.loadPromise;
  }

  async set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<AppSettings> {
    return this.setMany({ [key]: value } as Partial<AppSettings>);
  }

  async setMany(patch: Partial<AppSettings>): Promise<AppSettings> {
    const changed = Object.keys(patch) as (keyof AppSettings)[];
    if (changed.length === 0) return this.get();

    const next: AppSettings = { ...this.get(), ...patch };
    const now = Date.now();

    try {
      await settingsRepo.putMany(
        changed.map((key) => ({ key, value: patch[key] as SettingValue, updatedAt: now })),
      );
    } catch (error) {
      logger.errorWith(error, 'Settings could not be persisted', { keys: changed });
    }

    this.settings = next;
    this.cacheLoaded = true;
    this.writeLocalCache(next);
    this.notify(changed, true);
    return { ...next };
  }

  async reset(): Promise<AppSettings> {
    try {
      await settingsRepo.clear();
    } catch (error) {
      logger.errorWith(error, 'Settings reset failed');
    }
    this.settings = { ...DEFAULT_SETTINGS };
    this.cacheLoaded = true;
    this.writeLocalCache(this.settings);
    this.notify(SETTING_KEYS, true);
    return { ...this.settings };
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async loadFromDatabase(): Promise<AppSettings> {
    const records = await settingsRepo.getAll();
    const next: AppSettings = { ...this.get() };
    for (const record of records) {
      if (!isSettingsKey(record.key)) continue;
      next[record.key] = coerce((record.key as keyof AppSettings), record.value);
    }
    return next;
  }

  private readLocalCache(): Partial<AppSettings> {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEYS.settingsCache);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      const out: Partial<AppSettings> = {};
      for (const key of SETTING_KEYS) {
        const value = (parsed as Record<string, unknown>)[key];
        if (value !== undefined) out[key] = coerce(key, value as SettingValue);
      }
      return out;
    } catch {
      return {};
    }
  }

  private writeLocalCache(settings: AppSettings): void {
    try {
      const minimal: Partial<AppSettings> = {
        theme: settings.theme,
        language: settings.language,
        sidebarCollapsed: settings.sidebarCollapsed,
        defaultSourceLanguage: settings.defaultSourceLanguage,
        defaultTargetLanguage: settings.defaultTargetLanguage,
      };
      localStorage.setItem(LOCAL_STORAGE_KEYS.settingsCache, JSON.stringify(minimal));
    } catch {
      /* private mode / quota: cache is optional */
    }
  }

  private notify(changed: readonly (keyof AppSettings)[], fromUser: boolean): void {
    const snapshot = this.get();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot, changed);
      } catch (error) {
        logger.errorWith(error, 'Settings listener failed');
      }
    }
    if (fromUser) appEvents.emit('settings:changed', { keys: changed.map(String) });
  }
}

function isSettingsKey(key: string): key is keyof AppSettings {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

export const settingsService = new SettingsService();
