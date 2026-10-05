import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createProgress } from '../domain/types';
import type { ExportArtifact, Project } from '../db/entities';
import { exportArtifactsRepo, projectsRepo } from '../db/repositories';
import { dataPortabilityService } from './dataPortabilityService';

const T0 = 1_700_000_000_000;

function makeProject(patch: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Quarterly report',
    sourceFile: null,
    sourceLanguage: 'en',
    targetLanguage: 'my',
    status: 'draft',
    progress: createProgress(0, 0),
    documentId: null,
    createdAt: T0,
    updatedAt: T0,
    lastProcessedUnit: 0,
    error: null,
    exportState: 'not_started',
    notes: '',
    ...patch,
  };
}

function makeArtifact(patch: Partial<ExportArtifact> = {}): ExportArtifact {
  return {
    jobId: 'job_export_1',
    projectId: 'project-1',
    documentId: 'doc_1',
    format: 'pdf',
    fileName: 'quarterly-report-my.pdf',
    signature: 'sig_1',
    pageCount: 2,
    renderedPages: 2,
    state: 'ready',
    bytes: new Uint8Array([37, 80, 68, 70]).buffer,
    findings: null,
    createdAt: T0,
    updatedAt: T0,
    ...patch,
  };
}

describe('dataPortability (backup without secrets or produced files)', () => {
  beforeEach(async () => {
    await projectsRepo.clear();
    await exportArtifactsRepo.clear();
  });

  it('excludes secretVault and exportArtifacts from the JSON bundle', async () => {
    await projectsRepo.put(makeProject());
    await exportArtifactsRepo.put(makeArtifact());

    const bundle = await dataPortabilityService.exportAll();

    expect(bundle.format).toBe('adt-export');
    expect(bundle.stores.projects).toHaveLength(1);
    expect('exportArtifacts' in bundle.stores).toBe(false);
    expect('secretVault' in bundle.stores).toBe(false);
    // The produced file only lives in the excluded store: a bundle is JSON
    // metadata, never raw key material or generated file bytes.
    expect(JSON.stringify(bundle)).not.toContain('quarterly-report-my.pdf');
  });

  it('ignores unknown/foreign stores on import instead of writing them', async () => {
    const raw = JSON.stringify({
      format: 'adt-export',
      version: 1,
      appVersion: '0.5.0',
      exportedAt: T0,
      stores: {
        projects: [makeProject()],
        exportArtifacts: [makeArtifact()],
      },
    });

    const { records } = await dataPortabilityService.importBundle(raw);

    expect(records).toBe(1);
    expect(await projectsRepo.has('project-1')).toBe(true);
    expect(await exportArtifactsRepo.has('job_export_1')).toBe(false);
  });

  it('rejects a malformed bundle before writing anything', async () => {
    await expect(dataPortabilityService.importBundle('{"nope":true}')).rejects.toMatchObject({
      code: 'import_invalid',
    });
    expect(await projectsRepo.count()).toBe(0);
  });
});
