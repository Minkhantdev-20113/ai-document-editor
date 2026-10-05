const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const unit = BYTE_UNITS[exponent] ?? 'B';
  const digits = exponent === 0 ? 0 : decimals;
  return `${value.toFixed(digits)} ${unit}`;
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

export function formatPercent(processed: number, total: number): number {
  if (total <= 0) return 0;
  return clamp(Math.round((processed / total) * 100), 0, 100);
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}
