import { appEvents } from '../core/events/eventBus';
import { glossaryService } from './glossaryService';
import { translationUnitsRepo } from '../db/repositories';
import type { TranslationUnit, UnitWarning } from '../db/entities';
import {
  duplicateWarnings,
  unitWarnings,
  type UnitCheckContext,
  type ValidationWarning,
  type WarningCode,
} from '../domain/validation';

export interface ValidationSummary {
  readonly documentId: string;
  readonly unitsChecked: number;
  readonly unitsWithWarnings: number;
  readonly totalWarnings: number;
  readonly byCode: Readonly<Partial<Record<WarningCode, number>>>;
}

function contextFor(unit: TranslationUnit, glossary: UnitCheckContext['glossary']): UnitCheckContext {
  return {
    sourceLanguage: unit.sourceLanguage,
    targetLanguage: unit.targetLanguage,
    ...(glossary && glossary.length > 0 ? { glossary } : {}),
  };
}

/**
 * Stored findings differ from freshly computed ones? `undefined` (never
 * validated) differs from `[]` (validated, clean) on purpose: the editor can
 * tell "not checked yet" from "checked, nothing to resolve".
 */
function differs(
  stored: readonly UnitWarning[] | null | undefined,
  next: readonly ValidationWarning[],
): boolean {
  return JSON.stringify(stored ?? null) !== JSON.stringify(next);
}

/**
 * Validation service (Phase 4): runs the pure checks over a document's units
 * and persists findings onto each unit (`warnings`). Text is NEVER modified -
 * findings are surfaced in the editor for a human to resolve.
 */
class ValidationService {
  /** Validates every unit of a document and persists changed findings. */
  async validateDocument(documentId: string): Promise<ValidationSummary> {
    const units = await this.loadUnits(documentId);
    const computed = await this.compute(units);
    const changed = units.filter((unit) => differs(unit.warnings, computed.get(unit.id) ?? []));
    await this.persist(changed, computed);

    return this.summarize(documentId, units, computed);
  }

  /**
   * Revalidates one unit (used right after a manual edit). Sibling units are
   * still loaded because `duplicated_text` is a document-level comparison -
   * but only the target unit's row is written.
   */
  async validateUnit(unitId: string): Promise<readonly ValidationWarning[]> {
    const unit = await translationUnitsRepo.get(unitId);
    if (!unit) return [];
    const units = await this.loadUnits(unit.documentId);
    const computed = await this.compute(units);
    const warnings = computed.get(unitId) ?? [];
    if (differs(unit.warnings, warnings)) {
      await translationUnitsRepo.put({ ...unit, warnings });
      appEvents.emit('units:changed', { documentId: unit.documentId });
    }
    return warnings;
  }

  /**
   * Read-only tally of ALREADY stored findings (no recomputation) for the
   * workflow UI: how many units carry warnings and how many there are in
   * total, alongside translation progress.
   */
  async storedSummary(
    documentId: string,
  ): Promise<{
    readonly units: number;
    readonly translated: number;
    /** Units whose last attempt failed - the run can still be "completed". */
    readonly failed: number;
    readonly unitsWithWarnings: number;
    readonly totalWarnings: number;
  }> {
    const units = await this.loadUnits(documentId);
    let translated = 0;
    let failed = 0;
    let unitsWithWarnings = 0;
    let totalWarnings = 0;
    for (const unit of units) {
      if (unit.status === 'translated' || unit.status === 'reviewed') translated += 1;
      if (unit.status === 'failed') failed += 1;
      const count = unit.warnings?.length ?? 0;
      if (count > 0) {
        unitsWithWarnings += 1;
        totalWarnings += count;
      }
    }
    return { units: units.length, translated, failed, unitsWithWarnings, totalWarnings };
  }

  private async loadUnits(documentId: string): Promise<TranslationUnit[]> {
    const units = (await translationUnitsRepo.queryByIndex('by_document', documentId)) ?? [];
    return units.sort((a, b) => a.orderIndex - b.orderIndex);
  }

  private async compute(
    units: readonly TranslationUnit[],
  ): Promise<Map<string, ValidationWarning[]>> {
    const glossary = units[0] ? await glossaryService.rulesFor(units[0].projectId) : [];
    const duplicates = duplicateWarnings(units);

    const out = new Map<string, ValidationWarning[]>();
    for (const unit of units) {
      const warnings: ValidationWarning[] = [
        ...unitWarnings(
          {
            sourceText: unit.sourceText,
            translatedText: unit.translatedText,
            status: unit.status,
          },
          contextFor(unit, glossary),
        ),
      ];
      const duplicate = duplicates.get(unit.id);
      if (duplicate) warnings.push(duplicate);
      out.set(unit.id, warnings);
    }
    return out;
  }

  private async persist(
    changed: readonly TranslationUnit[],
    computed: Map<string, ValidationWarning[]>,
  ): Promise<void> {
    if (changed.length === 0) return;
    await translationUnitsRepo.putMany(
      changed.map((unit) => ({ ...unit, warnings: computed.get(unit.id) ?? [] })),
    );
    const documentId = changed[0]?.documentId;
    if (documentId) appEvents.emit('units:changed', { documentId });
  }

  private summarize(
    documentId: string,
    units: readonly TranslationUnit[],
    computed: Map<string, ValidationWarning[]>,
  ): ValidationSummary {
    const byCode: Partial<Record<WarningCode, number>> = {};
    let unitsWithWarnings = 0;
    let totalWarnings = 0;
    for (const unit of units) {
      const warnings = computed.get(unit.id) ?? [];
      if (warnings.length > 0) unitsWithWarnings += 1;
      totalWarnings += warnings.length;
      for (const warning of warnings) {
        byCode[warning.code] = (byCode[warning.code] ?? 0) + 1;
      }
    }
    return {
      documentId,
      unitsChecked: units.length,
      unitsWithWarnings,
      totalWarnings,
      byCode,
    };
  }
}

export { ValidationService };
export const validationService = new ValidationService();
