import { appEvents } from '../core/events/eventBus';
import { AppError, toAppError } from '../core/errors/appError';
import { newId } from '../core/utils/id';
import { editorDocumentsRepo } from '../db/repositories';
import type { EditorDocument } from '../db/entities';

export interface CreateEditorDocumentInput {
  readonly projectId: string;
  readonly documentId?: string | null;
  readonly title: string;
  readonly html?: string;
}

/** Rich-text documents edited with Tiptap, persisted locally. */
class EditorDocumentService {
  async list(): Promise<EditorDocument[]> {
    const documents = await editorDocumentsRepo.getAll();
    return documents.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<EditorDocument | undefined> {
    return editorDocumentsRepo.get(id);
  }

  async require(id: string): Promise<EditorDocument> {
    const document = await this.get(id);
    if (!document) throw new AppError('Editor document not found', { code: 'not_found' });
    return document;
  }

  async listForProject(projectId: string): Promise<EditorDocument[]> {
    const documents = (await editorDocumentsRepo.queryByIndex('by_project', projectId)) ?? [];
    return documents.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async create(input: CreateEditorDocumentInput): Promise<EditorDocument> {
    const timestamp = Date.now();
    const record: EditorDocument = {
      id: newId('edt'),
      projectId: input.projectId,
      documentId: input.documentId ?? null,
      title: input.title.trim() || 'Untitled document',
      html: input.html ?? '',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      await editorDocumentsRepo.put(record);
    } catch (error) {
      throw toAppError(error, 'db_operation_failed');
    }
    appEvents.emit('editor:changed', { editorDocumentId: record.id });
    return record;
  }

  async saveContent(id: string, patch: { title?: string; html?: string }): Promise<EditorDocument> {
    const document = await this.require(id);
    const next: EditorDocument = {
      ...document,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.html !== undefined ? { html: patch.html } : {}),
      updatedAt: Date.now(),
    };
    try {
      await editorDocumentsRepo.put(next);
    } catch (error) {
      throw toAppError(error, 'db_operation_failed');
    }
    appEvents.emit('editor:changed', { editorDocumentId: id });
    return next;
  }

  async remove(id: string): Promise<void> {
    await editorDocumentsRepo.delete(id);
    appEvents.emit('editor:changed', { editorDocumentId: id });
  }
}

export const editorDocumentService = new EditorDocumentService();
