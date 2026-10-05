export type TranslationParams = Record<string, string | number>;

/** Flattens a nested dictionary into dot-separated keys. */
export function flattenDictionary(dict: object, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(dict)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      out[path] = value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenDictionary(value as object, path));
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === 'string') out[`${path}.${index}`] = item;
      });
    }
  }
  return out;
}

/** Replaces `{name}` placeholders. Unknown placeholders are left intact. */
export function formatTemplate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
