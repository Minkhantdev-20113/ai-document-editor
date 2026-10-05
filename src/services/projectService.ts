import { appEvents } from '../core/events/eventBus';
import { logger } from '../core/logging/logger';
import { newId } from '../core/utils/id';
import { documentsRepo, documentPagesRepo, projectsRepo, translationUnitsRepo, editorDocumentsRepo, jobsRepo } from '../db/repositories';
import type { DocumentPage, Project } from '../db/entities';
import {
  createProgress,
  type ErrorState,
  type ExportState,
  type FileMetadata,
  type ProgressState,
  type ProjectStatus,
} from '../domain/types';
import { DEFAULT_SOURCE_LANGUAGE, DEFAULT_TARGET_LANGUAGE } from '../config/languages';
import { AppError, toAppError } from '../core/errors/appError';
import { documentService } from './documentService';

export interface CreateProjectInput {
  readonly name: string;
  readonly sourceLanguage?: string;
  readonly targetLanguage?: string;
  readonly notes?: string;
  readonly file?: File | null;
}

export interface ProjectStats {
  readonly total: number;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly activeJobs: number;
  readonly units: number;
}

function now(): number {
  return Date.now();
}

function toFileMetadata(file: File): FileMetadata {
  return { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified };
}

/** Project lifecycle: create, update, progress, cascade delete, stats. */
class ProjectService {
  async list(): Promise<Project[]> {
    const projects = await projectsRepo.getAll();
    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Project | undefined> {
    return projectsRepo.get(id);
  }

  async require(id: string): Promise<Project> {
    const project = await this.get(id);
    if (!project) {
      throw new AppError(`Project ${id} not found`, { code: 'not_found' });
    }
    return project;
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const trimmed = input.name.trim();
    if (!trimmed) {
      throw new AppError('Project name is required', { code: 'validation' });
    }

    const timestamp = now();
    const projectId = newId('prj');
    const file = input.file ?? null;
    // Reject unsupported/oversized/empty files before any row is written, so a
    // validation failure never leaves an orphan project behind.
    if (file) {
      documentService.validateSourceFile(file);
    }

    const project: Project = {
      id: projectId,
      name: trimmed,
      sourceFile: file ? toFileMetadata(file) : null,
      sourceLanguage: input.sourceLanguage ?? DEFAULT_SOURCE_LANGUAGE,
      targetLanguage: input.targetLanguage ?? DEFAULT_TARGET_LANGUAGE,
      status: 'draft',
      progress: createProgress(0, 0),
      documentId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastProcessedUnit: 0,
      error: null,
      exportState: 'not_started',
      notes: input.notes?.trim() ?? '',
    };

    try {
      await projectsRepo.put(project);
    } catch (error) {
      throw toAppError(error, 'db_operation_failed');
    }

    if (file) {
      try {
        const document = await documentService.create({
          projectId,
          file,
          sourceLanguage: project.sourceLanguage,
          targetLanguage: project.targetLanguage,
        });
        const withDocument: Project = {
          ...project,
          documentId: document.id,
          updatedAt: now(),
        };
        await projectsRepo.put(withDocument);
        appEvents.emit('projects:changed', { projectId });
        appEvents.emit('documents:changed', { documentId: document.id, projectId });
        return withDocument;
      } catch (error) {
        logger.errorWith(error, 'Source file could not be stored; project kept without a file');
        // The project remains usable: the user can re-attach a file later.
      }
    }

    appEvents.emit('projects:changed', { projectId });
    return project;
  }

  async update(
    id: string,
    patch: Partial<Pick<Project, 'name' | 'sourceLanguage' | 'targetLanguage' | 'notes'>>,
  ): Promise<Project> {
    const project = await this.require(id);
    const next: Project = { ...project, ...patch, updatedAt: now() };
    await projectsRepo.put(next);
    appEvents.emit('projects:changed', { projectId: id });
    return next;
  }

  async setStatus(id: string, status: ProjectStatus, error: ErrorState | null = null): Promise<void> {
    const project = await this.require(id);
    await projectsRepo.put({ ...project, status, error, updatedAt: now() });
    appEvents.emit('projects:changed', { projectId: id });
  }

  async setProgress(id: string, progress: ProgressState): Promise<void> {
    const project = await this.require(id);
    if (
      project.progress.processed === progress.processed &&
      project.progress.total === progress.total
    ) {
      return;
    }
    await projectsRepo.put({ ...project, progress, updatedAt: now() });
    appEvents.emit('projects:changed', { projectId: id });
  }

  async setExportState(id: string, exportState: ExportState): Promise<void> {
    const project = await this.require(id);
    await projectsRepo.put({ ...project, exportState, updatedAt: now() });
    appEvents.emit('projects:changed', { projectId: id });
  }

  async setLastProcessedUnit(id: string, unitIndex: number): Promise<void> {
    const project = await this.require(id);
    await projectsRepo.put({ ...project, lastProcessedUnit: unitIndex, updatedAt: now() });
    appEvents.emit('projects:changed', { projectId: id });
  }

  /** Removes the project and every dependent record owned by it. */
  async remove(id: string): Promise<void> {
    const project = await this.get(id);
    if (!project) return;

    const documents = (await documentsRepo.queryByIndex('by_project', id)) ?? [];
    const jobs = (await jobsRepo.queryByIndex('by_project', id)) ?? [];

    try {
      for (const document of documents) {
        await documentService.remove(document.id);
      }
      await translationUnitsRepo.deleteMany(
        (await translationUnitsRepo.queryByIndex('by_project', id) ?? []).map((unit) => unit.id),
      );
      await editorDocumentsRepo.deleteMany(
        (await editorDocumentsRepo.queryByIndex('by_project', id) ?? []).map((doc) => doc.id),
      );
      await jobsRepo.deleteMany(jobs.map((job) => job.id));
      await projectsRepo.delete(id);
    } catch (error) {
      throw toAppError(error, 'db_operation_failed');
    }

    logger.info('Project deleted', { projectId: id });
    appEvents.emit('projects:changed', { projectId: id });
    appEvents.emit('jobs:changed', { projectId: id });
    appEvents.emit('documents:changed', { projectId: id });
  }

  async stats(): Promise<ProjectStats> {
    const [projects, jobs, units] = await Promise.all([
      projectsRepo.getAll(),
      jobsRepo.getAll(),
      translationUnitsRepo.count(),
    ]);
    const byStatus: Record<string, number> = {};
    for (const project of projects) {
      byStatus[project.status] = (byStatus[project.status] ?? 0) + 1;
    }
    const activeJobs = jobs.filter(
      (job) => job.state === 'analyzing' || job.state === 'translating' || job.state === 'exporting' || job.state === 'queued',
    ).length;
    return { total: projects.length, byStatus, activeJobs, units };
  }

  /** Recomputes progress from persisted units (used after interruption). */
  async refreshProgress(id: string): Promise<void> {
    const project = await this.get(id);
    if (!project || !project.documentId) return;
    const units = (await translationUnitsRepo.queryByIndex('by_document', project.documentId)) ?? [];
    if (units.length === 0) return;
    const done = units.filter((unit) => unit.status === 'translated' || unit.status === 'reviewed').length;
    await this.setProgress(id, createProgress(done, units.length));
  }

  /** Helper for services that need the current page list of a project. */
  async pages(id: string): Promise<DocumentPage[]> {
    const project = await this.require(id);
    if (!project.documentId) return [];
    return (await documentPagesRepo.queryByIndex('by_document', project.documentId)) ?? [];
  }
}

export const projectService = new ProjectService();
