import { appEvents } from '../core/events/eventBus';
import {
  serializeOverlay,
  validateOverlay,
  type CatalogOverlayEntry,
} from '../providers/modelRegistry';
import { settingsService } from './settingsService';

/**
 * Persistent model-catalog overlay (Phase 3: "the catalog must be updateable").
 *
 * The overlay is stored as validated JSON in settings. Every load re-runs
 * `validateOverlay`, so corrupted or hand-edited storage self-heals to the
 * built-in catalog instead of breaking the registry. Imports are rejected
 * loudly (unknown provider/model/field) before anything is written.
 */
class ModelCatalogService {
  async load(): Promise<CatalogOverlayEntry[]> {
    // Settings are the backing store: make sure the IndexedDB load has
    // settled first (idempotent cached promise) so a cold start cannot read
    // the default `null` and pretend no overlay exists.
    await settingsService.load();
    const raw = settingsService.value('modelCatalog');
    if (!raw) return [];
    try {
      return validateOverlay(JSON.parse(raw) as unknown);
    } catch {
      // Storage went stale or was tampered with: fall back to built-in facts.
      return [];
    }
  }

  async save(entries: readonly CatalogOverlayEntry[]): Promise<void> {
    await settingsService.load();
    await settingsService.set('modelCatalog', entries.length > 0 ? serializeOverlay(entries) : null);
    appEvents.emit('providers:changed', {});
  }

  /** Validates then persists a parsed catalog file. Returns entry count. */
  async importJson(parsed: unknown): Promise<number> {
    const entries = validateOverlay(parsed);
    await this.save(entries);
    return entries.length;
  }

  async clear(): Promise<void> {
    await this.save([]);
  }
}

export const modelCatalogService = new ModelCatalogService();
