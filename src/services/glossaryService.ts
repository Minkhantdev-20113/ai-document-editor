import { appEvents } from '../core/events/eventBus';
import { AppError } from '../core/errors/appError';
import { newId } from '../core/utils/id';
import { glossaryEntriesRepo } from '../db/repositories';
import type { GlossaryEntry } from '../db/entities';
import {
  isDuplicateTerm,
  toGlossaryRule,
  validateGlossaryInput,
  type GlossaryEntryInput,
  type GlossaryRule,
} from '../domain/glossary';

/**
 * Glossary service (Phase 4): project-scoped terminology rules.
 *
 * Every write validates through the domain first (typed `validation` errors
 * with user-safe messages) and rejects duplicate terms case-insensitively,
 * so two entries can never compete for the same word.
 */
class GlossaryService {
  /** All rules for a project, ordered by term (stable for the UI). */
  async list(projectId: string): Promise<GlossaryEntry[]> {
    const entries = (await glossaryEntriesRepo.queryByIndex('by_project', projectId)) ?? [];
    return entries.sort((a, b) => a.sourceTerm.localeCompare(b.sourceTerm));
  }

  async get(id: string): Promise<GlossaryEntry | undefined> {
    return glossaryEntriesRepo.get(id);
  }

  async require(id: string): Promise<GlossaryEntry> {
    const entry = await glossaryEntriesRepo.get(id);
    if (!entry) {
      throw new AppError('Glossary entry was not found', { code: 'not_found', retryable: false });
    }
    return entry;
  }

  async create(projectId: string, input: GlossaryEntryInput): Promise<GlossaryEntry> {
    const fields = validateGlossaryInput(input);
    const existing = await this.list(projectId);
    if (isDuplicateTerm(existing, fields.sourceTerm)) {
      throw new AppError(`"${fields.sourceTerm}" already has a glossary rule in this project`, {
        code: 'validation',
        retryable: false,
      });
    }

    const timestamp = Date.now();
    const entry: GlossaryEntry = {
      id: newId('glo'),
      projectId,
      ...fields,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await glossaryEntriesRepo.put(entry);
    appEvents.emit('glossary:changed', { projectId });
    return entry;
  }

  async update(id: string, input: GlossaryEntryInput): Promise<GlossaryEntry> {
    const current = await this.require(id);
    const fields = validateGlossaryInput(input);
    const siblings = (await this.list(current.projectId)).filter((entry) => entry.id !== id);
    if (isDuplicateTerm(siblings, fields.sourceTerm)) {
      throw new AppError(`"${fields.sourceTerm}" already has a glossary rule in this project`, {
        code: 'validation',
        retryable: false,
      });
    }

    const updated: GlossaryEntry = {
      ...current,
      ...fields,
      updatedAt: Date.now(),
    };
    await glossaryEntriesRepo.put(updated);
    appEvents.emit('glossary:changed', { projectId: current.projectId });
    return updated;
  }

  async remove(id: string): Promise<void> {
    const current = await this.require(id);
    await glossaryEntriesRepo.delete(id);
    appEvents.emit('glossary:changed', { projectId: current.projectId });
  }

  /** Slim rules for the prompt and the validators. */
  async rulesFor(projectId: string): Promise<GlossaryRule[]> {
    const entries = await this.list(projectId);
    return entries.map(toGlossaryRule);
  }
}

export { GlossaryService };
export const glossaryService = new GlossaryService();
