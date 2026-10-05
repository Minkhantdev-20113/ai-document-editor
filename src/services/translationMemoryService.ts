import { translationUnitsRepo } from '../db/repositories';
import type { TranslationUnit } from '../db/entities';
import { MEMORY_THRESHOLDS, similarityScore } from '../domain/translationMemory';

/** A previously translated unit offered as a suggestion for similar text. */
export interface MemoryMatch {
  readonly unitId: string;
  readonly documentId: string;
  readonly sourceText: string;
  readonly translation: string;
  readonly score: number;
}

export interface MemoryQuery {
  readonly projectId: string;
  readonly sourceText: string;
  /** Restrict to units translated into this language. */
  readonly targetLanguage?: string;
  /** Never suggest the unit itself (self-match is trivially 1.0). */
  readonly excludeUnitId?: string;
  readonly limit?: number;
  readonly minScore?: number;
}

function usable(unit: TranslationUnit, query: MemoryQuery): boolean {
  if (unit.id === query.excludeUnitId) return false;
  if (unit.status !== 'translated' && unit.status !== 'reviewed') return false;
  if (!unit.translatedText || unit.translatedText.trim() === '') return false;
  if (query.targetLanguage && unit.targetLanguage !== query.targetLanguage) return false;
  return true;
}

/**
 * Translation memory (Phase 4): finds previously translated units whose
 * source text resembles the query, best match first. Suggestions only - the
 * caller decides whether to show or (with the opt-in setting + high
 * confidence) apply them.
 */
class TranslationMemoryService {
  async suggest(query: MemoryQuery): Promise<MemoryMatch[]> {
    const units = (await translationUnitsRepo.queryByIndex('by_project', query.projectId)) ?? [];
    const limit = Math.max(query.limit ?? 3, 0);
    const minScore = query.minScore ?? MEMORY_THRESHOLDS.suggest;

    const matches: MemoryMatch[] = [];
    for (const unit of units) {
      if (!usable(unit, query)) continue;
      const score = similarityScore(query.sourceText, unit.sourceText);
      if (score < minScore) continue;
      matches.push({
        unitId: unit.id,
        documentId: unit.documentId,
        sourceText: unit.sourceText,
        // `usable` guarantees a non-empty translation.
        translation: unit.translatedText ?? '',
        score,
      });
    }

    // Deterministic ordering: score first, unit id as the tie-break.
    matches.sort((a, b) => b.score - a.score || a.unitId.localeCompare(b.unitId));
    return matches.slice(0, limit);
  }

  /** Best qualifying match, or null. Used by the engine's opt-in pre-fill. */
  async best(query: MemoryQuery): Promise<MemoryMatch | null> {
    const [top] = await this.suggest({ ...query, limit: 1 });
    return top ?? null;
  }
}

export { TranslationMemoryService };
export const translationMemoryService = new TranslationMemoryService();
