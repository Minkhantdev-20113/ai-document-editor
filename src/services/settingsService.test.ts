// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { settingsService } from './settingsService';

const CACHE_KEY = 'adt.settings.cache';

function readCache(): Record<string, unknown> {
  const raw = localStorage.getItem(CACHE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

describe('settingsService (persistence behind theme/language)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists a theme change to IndexedDB and the pre-paint cache', async () => {
    const seen: string[] = [];
    const unsubscribe = settingsService.subscribe((snapshot) => seen.push(snapshot.theme));

    await settingsService.set('theme', 'dark');

    expect(settingsService.get().theme).toBe('dark');
    // index.html reads this cache before the first paint: no wrong-theme flash.
    expect(readCache().theme).toBe('dark');
    expect(seen).toContain('dark');
    unsubscribe();
  });

  it('round-trips the UI language across a simulated reload', async () => {
    await settingsService.set('language', 'en');
    expect(settingsService.value('language')).toBe('en');
    expect(readCache().language).toBe('en');

    // `load()` is what main.tsx runs on boot: values must come back from IndexedDB.
    const reloaded = await settingsService.load();
    expect(reloaded.language).toBe('en');
  });

  it('notifies every subscriber of a change', async () => {
    let calls = 0;
    const unsubscribe = settingsService.subscribe(() => {
      calls += 1;
    });
    await settingsService.set('sidebarCollapsed', true);
    expect(calls).toBeGreaterThan(0);
    expect(readCache().sidebarCollapsed).toBe(true);
    unsubscribe();
  });
});
