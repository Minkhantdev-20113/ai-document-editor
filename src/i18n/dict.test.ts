import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_ERROR_CODES } from '../core/errors/appError';
import { en } from './dict/en';
import { my } from './dict/my';

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);

function listSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listSources(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

/** Flattens a nested dictionary into dotted keys mapped to their leaf values. */
function leaves(value: unknown, prefix = '', out: Map<string, unknown> = new Map()): Map<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      leaves(childValue, prefix ? `${prefix}.${childKey}` : childKey, out);
    }
  } else if (prefix) {
    out.set(prefix, value);
  }
  return out;
}

function sortedKeys(set: Set<string>): string[] {
  return [...set].sort();
}

describe('i18n dictionaries', () => {
  const enLeaves = leaves(en);
  const myLeaves = leaves(my);

  it('my.ts mirrors en.ts key for key', () => {
    const missingInMy = sortedKeys(new Set(enLeaves.keys())).filter((key) => !myLeaves.has(key));
    const extraInMy = sortedKeys(new Set(myLeaves.keys())).filter((key) => !enLeaves.has(key));
    expect(missingInMy).toEqual([]);
    expect(extraInMy).toEqual([]);
  });

  it('has no blank strings in either locale', () => {
    for (const [name, dictLeaves] of [
      ['en', enLeaves],
      ['my', myLeaves],
    ] as const) {
      const blank = [...dictLeaves]
        .filter(([, value]) => typeof value === 'string' && value.trim() === '')
        .map(([key]) => key)
        .sort();
      expect({ locale: name, blank }).toEqual({ locale: name, blank: [] });
    }
  });

  it('covers every t(\'…\') literal used in the app', () => {
    const missing = new Set<string>();
    const dynamicSections = new Set<string>();
    const enKeys = [...enLeaves.keys()];

    for (const file of listSources(SRC_DIR)) {
      if (file === SELF_PATH) continue;
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) {
        const key = match[1];
        if (key && !enLeaves.has(key)) missing.add(key);
      }
      for (const match of source.matchAll(/\bt\(\s*`([a-zA-Z0-9_]+)\.\$\{/g)) {
        const section = match[1];
        if (section) dynamicSections.add(section);
      }
    }

    expect(sortedKeys(missing)).toEqual([]);
    // Sections built from template keys (e.g. t(`errors.${code}`)) must exist too.
    const hasSection = (section: string) => enKeys.some((key) => key.startsWith(`${section}.`));
    expect(sortedKeys(dynamicSections).filter((section) => !hasSection(section))).toEqual([]);
  });

  it('has an error message for every application error code', () => {
    expect(APP_ERROR_CODES.filter((code) => !enLeaves.has(`errors.${code}`))).toEqual([]);
    expect(APP_ERROR_CODES.filter((code) => !myLeaves.has(`errors.${code}`))).toEqual([]);
  });
});
