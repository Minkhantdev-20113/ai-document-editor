import { useEffect, useState, useSyncExternalStore } from 'react';

/** Tracks browser connectivity (local work continues while offline). */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}

/** Reactive media query hook (used for responsive layout decisions). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Sets document.title for the active route. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const appName = 'AI Document Translator';
    document.title = title ? `${title} · ${appName}` : appName;
  }, [title]);
}
