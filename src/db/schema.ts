import type { DBSchema } from 'idb';
import type {
  ApiKeyMetadata,
  DocumentBlock,
  DocumentPage,
  DocumentRecord,
  EditorDocument,
  ErrorLogRecord,
  ExportArtifact,
  GlossaryEntry,
  JobRecord,
  KeyRuntime,
  Project,
  ProviderConfig,
  SecretRecord,
  SettingRecord,
  SyncRecord,
  TranslationUnit,
  UsageSnapshot,
} from './entities';

/** Ordered store names; also used by data export/import. */
export const STORES = [
  'projects',
  'documents',
  'documentPages',
  'documentBlocks',
  'translationUnits',
  'glossaryEntries',
  'editorDocuments',
  'settings',
  'providerConfigs',
  'apiKeyMetadata',
  'keyRuntime',
  'jobQueue',
  'exportArtifacts',
  'usageSnapshots',
  'syncQueue',
  'errorLogs',
  'secretVault',
] as const;

export type StoreName = (typeof STORES)[number];

export interface StoreIndexDefinition {
  readonly name: string;
  readonly keyPath: string | readonly string[];
  readonly unique?: boolean;
}

export interface StoreDefinition {
  readonly name: StoreName;
  readonly keyPath: string;
  readonly indexes: readonly StoreIndexDefinition[];
}

/** Values keyed by store name - the single mapping used across the data layer. */
export interface StoreValueMap {
  projects: Project;
  documents: DocumentRecord;
  documentPages: DocumentPage;
  documentBlocks: DocumentBlock;
  translationUnits: TranslationUnit;
  glossaryEntries: GlossaryEntry;
  editorDocuments: EditorDocument;
  settings: SettingRecord;
  providerConfigs: ProviderConfig;
  apiKeyMetadata: ApiKeyMetadata;
  keyRuntime: KeyRuntime;
  jobQueue: JobRecord;
  exportArtifacts: ExportArtifact;
  usageSnapshots: UsageSnapshot;
  syncQueue: SyncRecord;
  errorLogs: ErrorLogRecord;
  secretVault: SecretRecord;
}

export const STORE_DEFINITIONS: readonly StoreDefinition[] = [
  { name: 'projects', keyPath: 'id', indexes: [
    { name: 'by_status', keyPath: 'status' },
    { name: 'by_updatedAt', keyPath: 'updatedAt' },
  ] },
  { name: 'documents', keyPath: 'id', indexes: [
    { name: 'by_project', keyPath: 'projectId' },
    { name: 'by_updatedAt', keyPath: 'updatedAt' },
  ] },
  { name: 'documentPages', keyPath: 'id', indexes: [
    { name: 'by_document', keyPath: 'documentId' },
    { name: 'by_project', keyPath: 'projectId' },
    { name: 'by_document_page', keyPath: ['documentId', 'pageIndex'], unique: true },
  ] },
  { name: 'documentBlocks', keyPath: 'id', indexes: [
    { name: 'by_document', keyPath: 'documentId' },
    { name: 'by_project', keyPath: 'projectId' },
    { name: 'by_page', keyPath: 'pageId' },
    { name: 'by_document_order', keyPath: ['documentId', 'orderIndex'], unique: true },
  ] },
  { name: 'translationUnits', keyPath: 'id', indexes: [
    { name: 'by_document', keyPath: 'documentId' },
    { name: 'by_project', keyPath: 'projectId' },
    { name: 'by_status', keyPath: 'status' },
    { name: 'by_page', keyPath: 'pageId' },
    { name: 'by_document_order', keyPath: ['documentId', 'orderIndex'], unique: true },
  ] },
  { name: 'glossaryEntries', keyPath: 'id', indexes: [
    { name: 'by_project', keyPath: 'projectId' },
  ] },
  { name: 'editorDocuments', keyPath: 'id', indexes: [
    { name: 'by_project', keyPath: 'projectId' },
    { name: 'by_document', keyPath: 'documentId' },
  ] },
  { name: 'settings', keyPath: 'key', indexes: [] },
  { name: 'providerConfigs', keyPath: 'id', indexes: [
    { name: 'by_provider', keyPath: 'providerId' },
  ] },
  { name: 'apiKeyMetadata', keyPath: 'id', indexes: [
    { name: 'by_provider', keyPath: 'providerId' },
    { name: 'by_status', keyPath: 'status' },
  ] },
  { name: 'keyRuntime', keyPath: 'id', indexes: [
    { name: 'by_provider', keyPath: 'providerId' },
  ] },
  { name: 'jobQueue', keyPath: 'id', indexes: [
    { name: 'by_state', keyPath: 'state' },
    { name: 'by_project', keyPath: 'projectId' },
    { name: 'by_type', keyPath: 'type' },
    { name: 'by_updatedAt', keyPath: 'updatedAt' },
  ] },
  { name: 'exportArtifacts', keyPath: 'jobId', indexes: [
    { name: 'by_project', keyPath: 'projectId' },
    { name: 'by_document', keyPath: 'documentId' },
  ] },
  { name: 'usageSnapshots', keyPath: 'id', indexes: [
    { name: 'by_provider', keyPath: 'providerId' },
    { name: 'by_windowStart', keyPath: 'windowStart' },
    { name: 'by_provider_window', keyPath: ['providerId', 'windowStart'], unique: true },
  ] },
  { name: 'syncQueue', keyPath: 'id', indexes: [
    { name: 'by_status', keyPath: 'status' },
    { name: 'by_entity', keyPath: 'entity' },
    { name: 'by_createdAt', keyPath: 'createdAt' },
  ] },
  { name: 'errorLogs', keyPath: 'id', indexes: [
    { name: 'by_level', keyPath: 'level' },
    { name: 'by_occurredAt', keyPath: 'occurredAt' },
  ] },
  { name: 'secretVault', keyPath: 'id', indexes: [] },
];

/** Typed IndexedDB contract. Store/index names come from STORE_DEFINITIONS. */
export interface AppDBSchema extends DBSchema {
  projects: {
    key: string;
    value: Project;
    indexes: { by_status: string; by_updatedAt: number };
  };
  documents: {
    key: string;
    value: DocumentRecord;
    indexes: { by_project: string; by_updatedAt: number };
  };
  documentPages: {
    key: string;
    value: DocumentPage;
    indexes: { by_document: string; by_project: string; by_document_page: [string, number] };
  };
  documentBlocks: {
    key: string;
    value: DocumentBlock;
    indexes: { by_document: string; by_project: string; by_page: string; by_document_order: [string, number] };
  };
  translationUnits: {
    key: string;
    value: TranslationUnit;
    indexes: {
      by_document: string;
      by_project: string;
      by_status: string;
      by_page: string;
      by_document_order: [string, number];
    };
  };
  glossaryEntries: {
    key: string;
    value: GlossaryEntry;
    indexes: { by_project: string };
  };
  editorDocuments: {
    key: string;
    value: EditorDocument;
    indexes: { by_project: string; by_document: string };
  };
  settings: {
    key: string;
    value: SettingRecord;
    indexes: Record<string, never>;
  };
  providerConfigs: {
    key: string;
    value: ProviderConfig;
    indexes: { by_provider: string };
  };
  apiKeyMetadata: {
    key: string;
    value: ApiKeyMetadata;
    indexes: { by_provider: string; by_status: string };
  };
  keyRuntime: {
    key: string;
    value: KeyRuntime;
    indexes: { by_provider: string };
  };
  jobQueue: {
    key: string;
    value: JobRecord;
    // `projectId` is null for global jobs: IndexedDB skips null keys, so the
    // index type stays `string` (records without a project are simply absent).
    indexes: { by_state: string; by_project: string; by_type: string; by_updatedAt: number };
  };
  exportArtifacts: {
    key: string;
    value: ExportArtifact;
    indexes: { by_project: string; by_document: string };
  };
  usageSnapshots: {
    key: string;
    value: UsageSnapshot;
    indexes: { by_provider: string; by_windowStart: number; by_provider_window: [string, number] };
  };
  syncQueue: {
    key: string;
    value: SyncRecord;
    indexes: { by_status: string; by_entity: string; by_createdAt: number };
  };
  errorLogs: {
    key: string;
    value: ErrorLogRecord;
    indexes: { by_level: string; by_occurredAt: number };
  };
  secretVault: {
    key: string;
    value: SecretRecord;
    indexes: Record<string, never>;
  };
}
