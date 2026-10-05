import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createProgress } from '../domain/types';
import type { JobRecord, Project } from './entities';
import { editorDocumentsRepo, jobsRepo, projectsRepo } from './repositories';

function makeProject(patch: Partial<Project> = {}): Project {
  const now = Date.now();
  return {
    id: 'project-1',
    name: 'Test project',
    sourceFile: null,
    sourceLanguage: 'en',
    targetLanguage: 'my',
    status: 'draft',
    progress: createProgress(0, 0),
    documentId: null,
    createdAt: now,
    updatedAt: now,
    lastProcessedUnit: 0,
    error: null,
    exportState: 'not_started',
    notes: '',
    ...patch,
  };
}

function makeJob(patch: Partial<JobRecord> = {}): JobRecord {
  const now = Date.now();
  return {
    id: 'job-1',
    type: 'inspect_document',
    state: 'queued',
    projectId: 'project-1',
    documentId: null,
    label: 'Inspect',
    payload: {},
    progress: createProgress(0, 0),
    attempts: 0,
    maxAttempts: 5,
    priority: 0,
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    lastError: null,
    interruptions: 0,
    result: null,
    ...patch,
  };
}

describe('repository (IndexedDB via fake-indexeddb)', () => {
  beforeEach(async () => {
    await projectsRepo.clear();
    await editorDocumentsRepo.clear();
    await jobsRepo.clear();
  });

  it('persists, reads back and upserts records', async () => {
    await projectsRepo.put(makeProject());
    const loaded = await projectsRepo.get('project-1');
    expect(loaded?.name).toBe('Test project');
    expect(await projectsRepo.count()).toBe(1);

    await projectsRepo.put(makeProject({ name: 'Renamed', updatedAt: Date.now() + 1 }));
    const updated = await projectsRepo.get('project-1');
    expect(updated?.name).toBe('Renamed');
    expect(await projectsRepo.count()).toBe(1);
  });

  it('supports bulk writes, bulk deletes and clears', async () => {
    await editorDocumentsRepo.putMany([
      { id: 'doc-a', projectId: 'p1', documentId: null, title: 'A', html: '<p>a</p>', createdAt: 1, updatedAt: 1 },
      { id: 'doc-b', projectId: 'p2', documentId: null, title: 'B', html: '<p>b</p>', createdAt: 1, updatedAt: 1 },
    ]);
    expect(await editorDocumentsRepo.count()).toBe(2);

    await editorDocumentsRepo.deleteMany(['doc-a']);
    expect(await editorDocumentsRepo.has('doc-a')).toBe(false);
    expect(await editorDocumentsRepo.has('doc-b')).toBe(true);

    await editorDocumentsRepo.clear();
    expect(await editorDocumentsRepo.count()).toBe(0);
  });

  it('queries the job state index', async () => {
    await jobsRepo.putMany([
      makeJob({ id: 'job-queued', state: 'queued' }),
      makeJob({ id: 'job-done', state: 'completed' }),
      makeJob({ id: 'job-queued-2', state: 'queued' }),
    ]);

    const queued = await jobsRepo.queryByIndex('by_state', 'queued');
    expect(queued.map((job) => job.id).sort()).toEqual(['job-queued', 'job-queued-2']);
    expect(await jobsRepo.countByIndex('by_state', 'completed')).toBe(1);
    expect(await jobsRepo.countByIndex('by_state')).toBe(3);
  });

  it('does not index records whose indexed key is null', async () => {
    await jobsRepo.putMany([
      makeJob({ id: 'job-global', projectId: null }),
      makeJob({ id: 'job-project', projectId: 'project-1' }),
    ]);

    // `projectId: null` is not an indexable key: global jobs stay out of by_project.
    expect(await jobsRepo.countByIndex('by_project', 'project-1')).toBe(1);
    const scoped = await jobsRepo.queryByIndex('by_project', 'project-1');
    expect(scoped.map((job) => job.id)).toEqual(['job-project']);
  });

  it('normalizes failures into AppError with db_operation_failed', async () => {
    const broken = { ...makeJob(), id: undefined as unknown as string };
    await expect(jobsRepo.put(broken as unknown as JobRecord)).rejects.toMatchObject({
      code: 'db_operation_failed',
    });
  });
});
