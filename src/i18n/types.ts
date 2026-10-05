/**
 * Deep `as const` literal widening: keeps `en` literal-typed (so it can serve
 * as the source of truth) while letting `my` provide ordinary strings.
 * The result is a structurally identical type - missing or extra Burmese keys
 * fail the type-check.
 */
export type WidenLiteral<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? WidenLiteral<U>[]
    : T extends object
      ? { [K in keyof T]: WidenLiteral<T[K]> }
      : T;

import type { en } from './dict/en';

export type Dictionary = WidenLiteral<typeof en>;

export const LOCALES = ['my', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}
