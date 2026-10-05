import { appEvents } from '../core/events/eventBus';
import { AppError } from '../core/errors/appError';
import { translationUnitsRepo } from '../db/repositories';
import type { TranslationUnit } from '../db/entities';
import type { UnitStatus } from '../domain/types';
import type { ValidationWarning } from '../domain/validation';
import { validationService } from './validationService';

export interface ManualEditResult {
  readonly unit: TranslationUnit;
  /** Fresh findings for the edited unit (siblings feed the duplicate check). */
  readonly warnings: readonly ValidationWarning[];
}

/**
 * Unit editing service (Phase 4): the human side of the translation loop.
 *
 * The invariant everything here protects: a manual edit wins. `editedAt` is
 * set on every human write, the engine never touches a `translated`/`reviewed`
 * unit, and discarding an edit is always an explicit user action.
 */
class UnitsService {
  /** All units of a document in reading order (workspace editor view). */
  async listByDocument(documentId: string): Promise<TranslationUnit[]> {
    const units = (await translationUnitsRepo.queryByIndex('by_document', documentId)) ?? [];
    return units.sort((a, b) => a.orderIndex - b.orderIndex);
  }

  /** All units of a project in reading order (project-wide searches). */
  async listByProject(projectId: string): Promise<TranslationUnit[]> {
    const units = (await translationUnitsRepo.queryByIndex('by_project', projectId)) ?? [];
    return units.sort((a, b) => a.orderIndex - b.orderIndex);
  }

  /**
   * Saves a human translation and revalidates the unit against its siblings.
   * Empty input un-translates the unit (back to `pending`, no text) so
   * "clear this machine output" is first-class too. A reviewed unit stays
   * reviewed - a human edit IS review.
   */
  async updateTranslation(unitId: string, text: string): Promise<ManualEditResult> {
    const unit = await this.require(unitId);
    const trimmedEmpty = text.trim() === '';
    await translationUnitsRepo.put({
      ...unit,
      translatedText: trimmedEmpty ? null : text,
      status: trimmedEmpty ? 'pending' : unit.status === 'reviewed' ? 'reviewed' : 'translated',
      editedAt: Date.now(),
      error: null,
      warnings: [],
      updatedAt: Date.now(),
    });
    appEvents.emit('units:changed', { documentId: unit.documentId });

    const warnings = await validationService.validateUnit(unitId);
    return { unit: await this.require(unitId), warnings };
  }

  /** Marks a unit reviewed (human-approved) or back to plain translated. */
  async setReviewed(unitId: string, reviewed: boolean): Promise<TranslationUnit> {
    const unit = await this.require(unitId);
    if (reviewed && (unit.translatedText === null || unit.translatedText.trim() === '')) {
      throw new AppError('Cannot review a unit without a translation', {
        code: 'validation',
        retryable: false,
      });
    }
    const status: UnitStatus = reviewed ? 'reviewed' : 'translated';
    const next: TranslationUnit = { ...unit, status, updatedAt: Date.now() };
    await translationUnitsRepo.put(next);
    appEvents.emit('units:changed', { documentId: unit.documentId });
    return next;
  }

  /**
   * Explicitly discards the stored translation (and any manual edit) so the
   * next run retranslates this unit. Only ever called from a confirmed UI
   * action - the engine itself never discards work.
   */
  async requestRetranslation(unitId: string): Promise<TranslationUnit> {
    const unit = await this.require(unitId);
    const next: TranslationUnit = {
      ...unit,
      status: 'pending',
      editedAt: null,
      warnings: [],
      error: null,
      retryCount: 0,
      updatedAt: Date.now(),
    };
    await translationUnitsRepo.put(next);
    appEvents.emit('units:changed', { documentId: unit.documentId });
    return next;
  }

  private async require(unitId: string): Promise<TranslationUnit> {
    const unit = await translationUnitsRepo.get(unitId);
    if (!unit) {
      throw new AppError('Translation unit was not found', { code: 'not_found', retryable: false });
    }
    return unit;
  }
}

export { UnitsService };
export const unitsService = new UnitsService();
