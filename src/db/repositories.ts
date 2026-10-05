import { createRepository, type Repository } from './repository';

/**
 * One repository per store. Services import from here instead of constructing
 * repositories, which keeps store names and value types in one place.
 */
export const projectsRepo = createRepository('projects');
export const documentsRepo = createRepository('documents');
export const documentPagesRepo = createRepository('documentPages');
export const documentBlocksRepo = createRepository('documentBlocks');
export const translationUnitsRepo = createRepository('translationUnits');
export const glossaryEntriesRepo = createRepository('glossaryEntries');
export const editorDocumentsRepo = createRepository('editorDocuments');
export const settingsRepo = createRepository('settings');
export const providerConfigsRepo = createRepository('providerConfigs');
export const apiKeysRepo = createRepository('apiKeyMetadata');
export const keyRuntimeRepo = createRepository('keyRuntime');
export const jobsRepo = createRepository('jobQueue');
export const exportArtifactsRepo = createRepository('exportArtifacts');
export const usageRepo = createRepository('usageSnapshots');
export const syncQueueRepo = createRepository('syncQueue');
export const errorLogsRepo = createRepository('errorLogs');
export const secretsRepo = createRepository('secretVault');

export type { Repository };
