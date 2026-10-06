/**
 * Centralized application configuration.
 * Every cross-cutting constant lives here so nothing hard-codes magic values.
 */

export const APP_NAME = 'AI Document Translator';
export const APP_SHORT_NAME = 'ADT';
export const APP_VERSION = '0.8.0';
export const APP_PHASE = 5;
/** Total planned build phases (used by the sidebar badge and help page). */
export const APP_PHASE_TOTAL = 5;

export const DB_NAME = 'ai-document-translator';
/**
 * v2: adds `documentBlocks`, `translationUnits.by_page`, analysis fields.
 * v3: adds `keyRuntime` (failover pool, Phase 3).
 * v4: adds `glossaryEntries` (terminology, Phase 4).
 */
export const DB_VERSION = 5;

/** Keys used for the small amount of pre-paint state kept in localStorage. */
export const LOCAL_STORAGE_KEYS = {
  theme: 'adt.theme',
  language: 'adt.language',
  sidebarCollapsed: 'adt.sidebar.collapsed',
  vaultMeta: 'adt.vault.meta',
  /** Cached copy of non-secret settings so the first paint is not blank. */
  settingsCache: 'adt.settings.cache',
} as const;

export const LIMITS = {
  /** Largest accepted source file (also the local payload storage cap). */
  maxSourceFileBytes: 200 * 1024 * 1024,
  /** Largest accepted plain-text source (text is parsed on the main thread). */
  maxTextFileBytes: 64 * 1024 * 1024,
  /** Retained in-memory log records. */
  logBufferSize: 300,
  /** Retained persisted error records. */
  persistedErrorLogs: 500,
} as const;

export const QUEUE_DEFAULTS = {
  concurrency: 2,
  maxAttempts: 5,
  baseBackoffMs: 1_500,
  maxBackoffMs: 60_000,
  jobTimeoutMs: 120_000,
  /** Window for a full document analysis run (all pages, per-page persistence). */
  analysisJobTimeoutMs: 600_000,
  /** Window for a full translation run (batches + failover backoff waits). */
  translationJobTimeoutMs: 1_800_000,
  /** Window for a full document export (layout + per-page rendering + save). */
  exportJobTimeoutMs: 1_800_000,
  /** Interval between persisted progress flushes. */
  progressFlushMs: 750,
} as const;

export const VAULT_DEFAULTS = {
  algorithm: 'AES-GCM',
  kdf: 'PBKDF2',
  kdfIterations: 310_000,
  hash: 'SHA-256',
  keyLengthBits: 256,
  /** Auto-lock (device key never leaves memory; passphrase keys do). */
  autoLockMs: 15 * 60 * 1000,
} as const;

export const TRANSPORT_DEFAULTS = {
  requestTimeoutMs: 30_000,
  /** Added to every provider request so cancel/cleanup is deterministic. */
  connectTimeoutMs: 10_000,
} as const;

/**
 * Phase-scoped feature switches. These describe what is *built*, not a fake
 * simulation: switching one on requires the real implementation behind it.
 */
export const FEATURES = {
  pdfInspection: true,
  /** Phase 2: structured per-page/block analysis pipeline. */
  documentAnalysis: true,
  richTextEditing: true,
  localDataPortability: true,
  providerKeyVerification: true,
  /** Phase 3: batched, resumable translation through the failover pool. */
  translationEngine: true,
  /** Phase 5: worker-rendered PDF/DOCX/HTML/TXT/MD/JSON with validation. */
  pdfExport: true,
  cloudSync: false,
} as const;

export const ROUTES = {
  dashboard: '/',
  projects: '/projects',
  project: (projectId: string) => `/projects/${projectId}`,
  workspace: '/workspace',
  workspaceProject: (projectId: string) => `/workspace/${projectId}`,
  /** Phase 2 analysis view: per-page/block pipeline progress. */
  analysis: (projectId: string) => `/workspace/${projectId}/analysis`,
  /** Phase 4 translation workspace: page nav + editable units + context. */
  workspaceEditor: (projectId: string) => `/workspace/${projectId}/editor`,
  editor: '/editor',
  exportCenter: '/export',
  providers: '/providers',
  apiKeys: '/api-keys',
  usage: '/usage',
  settings: '/settings',
  help: '/help',
} as const;

export const SUPPORTED_EXPORT_FORMATS = ['pdf', 'docx', 'html', 'txt', 'md', 'json'] as const;
export type ExportFormat = (typeof SUPPORTED_EXPORT_FORMATS)[number];
