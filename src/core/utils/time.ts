const RELATIVE_UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
  ['second', 1000],
];

export function formatDateTime(timestamp: number, locale = 'en'): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

export function formatDate(timestamp: number, locale = 'en'): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(timestamp));
}

export function formatRelativeTime(timestamp: number, now = Date.now(), locale = 'en'): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  const delta = timestamp - now;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (Math.abs(delta) >= ms || unit === 'second') {
      return formatter.format(Math.round(delta / ms), unit);
    }
  }
  return formatter.format(0, 'second');
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}
