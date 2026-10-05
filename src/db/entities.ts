import type { ProviderId } from '../providers/types';
import type { ErrorState, ExportState, FileMetadata, ProgressState, ProjectStatus, UnitStatus } from '../domain/types';
import type { KeyRuntimeState } from '../domain/provider/keySelection';
import type { JobState, JobType } from '../domain/jobStates';
import type { ExportFinding } from '../domain/export/validateExport';
import type {
  AnalysisProgress,
  BBox,
  BlockAlignment,
  BlockFlag,
  BlockKind,
  DocumentMetadata,
  FontInfo,
  LanguageDetection,
  LineIR,
  TableIR,
} from '../domain/analysis/ir';

/** A project groups one source file, its pages, units and jobs. */
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly sourceFile: FileMetadata | null;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly status: ProjectStatus;
  readonly progress: ProgressState;
  readonly documentId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Resume cursor: index of the last translation unit that completed. */
  readonly lastProcessedUnit: number;
  readonly error: ErrorState | null;
  readonly exportState: ExportState;
  readonly notes: string;
}

export type DocumentKind = 'pdf' | 'text' | 'rich';
export type InspectionState = 'pending' | 'running' | 'ready' | 'failed' | 'unsupported';

export interface DocumentRecord {
  readonly id: string;
  readonly projectId: string;
  readonly kind: DocumentKind;
  readonly fileName: string;
  readonly fileSize: number;
  readonly mimeType: string;
  readonly lastModified: number;
  readonly checksum: string | null;
  /** Offline-first: source bytes are kept locally when within the size limit. */
  readonly payload: Blob | null;
  readonly payloadStored: boolean;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly pageCount: number | null;
  readonly charCount: number | null;
  readonly inspectionState: InspectionState;
  /**
   * Phase 2 analysis. Optional (not `null`-only) so records written by Phase 1
   * load unchanged; readers use `?? null`.
   */
  readonly analysis?: AnalysisProgress | null;
  /** Result of source-language detection over the analyzed text. */
  readonly languageDetection?: LanguageDetection | null;
  /** File-level metadata from the metadata stage (PDF info, titles, ...). */
  readonly metadata?: DocumentMetadata | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface DocumentPage {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly charCount: number;
  readonly unitCount: number;
  /** `needs_ocr` marks an image-only page awaiting a real OCR provider. */
  readonly status: 'pending' | 'ready' | 'failed' | 'needs_ocr';
  /** Blocks persisted for this page after a successful analysis. */
  readonly blockCount?: number;
  /** Set when `status === 'failed'`: why the page needs a retry. */
  readonly error?: ErrorState | null;
  readonly analyzedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** One analyzed text block, persisted verbatim from the IR (see ir.ts). */
export interface DocumentBlock {
  /** Deterministic `${pageId}_b${readingOrder}`. */
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly pageId: string;
  readonly pageIndex: number;
  readonly readingOrder: number;
  /** `pageIndex * 100000 + readingOrder`: document-wide reading sequence. */
  readonly orderIndex: number;
  readonly kind: BlockKind;
  readonly text: string;
  readonly bbox: BBox;
  readonly font: FontInfo;
  readonly alignment: BlockAlignment;
  /** Normalized from the optional IR fields (`undefined` → `null`). */
  readonly headingLevel: number | null;
  readonly listOrdered: boolean | null;
  readonly table: TableIR | null;
  readonly link: string | null;
  readonly flags: readonly BlockFlag[];
  readonly lines: readonly LineIR[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * One translatable unit, 1:1 with a persisted block (id === blockId).
 * Field set follows the Phase 2 spec contract.
 */
export interface TranslationUnit {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly pageId: string;
  readonly blockId: string;
  /** Document-wide sequence: `pageIndex * 100000 + readingOrder`. */
  readonly orderIndex: number;
  readonly sourceText: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly translatedText: string | null;
  readonly status: UnitStatus;
  readonly retryCount: number;
  readonly provider: string | null;
  readonly model: string | null;
  /** Vault key id used for translation; never the key itself. */
  readonly keyId: string | null;
  readonly estimatedTokens: number | null;
  readonly actualTokens: number | null;
  readonly error: ErrorState | null;
  readonly sourceChecksum: string;
  /** Set when a human edited `translatedText`; beats any later AI output. */
  readonly editedAt?: number | null;
  /**
   * Last provider-produced text (Phase 4 "AI suggestion"). Kept even when a
   * manual edit replaces `translatedText`, so the editor can show original /
   * translation / AI suggestion / manual edit together. Absent for units no
   * AI ever produced (e.g. memory-filled).
   */
  readonly aiText?: string | null;
  /** Last validation findings for this unit (never auto-fixed, only shown). */
  readonly warnings?: readonly UnitWarning[] | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** One post-translation validation finding attached to a unit (Phase 4). */
export interface UnitWarning {
  readonly code: string;
  /** Optional short detail, e.g. the token that disappeared. */
  readonly detail?: string;
}

/**
 * Glossary rule scoped to a project (Phase 4). Drives the translation prompt
 * and the glossary-violation validation check.
 */
export interface GlossaryEntry {
  readonly id: string;
  readonly projectId: string;
  readonly sourceTerm: string;
  readonly preferredTranslation: string;
  readonly forbiddenTranslation: string | null;
  readonly notes: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EditorDocument {
  readonly id: string;
  readonly projectId: string;
  readonly documentId: string | null;
  readonly title: string;
  /** Tiptap HTML output. */
  readonly html: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type SettingValue = string | number | boolean | null | readonly string[] | { readonly [key: string]: unknown };

export interface SettingRecord {
  readonly key: string;
  readonly value: SettingValue;
  readonly updatedAt: number;
}

export interface ProviderConfig {
  readonly id: string;
  readonly providerId: ProviderId;
  readonly label: string;
  readonly enabled: boolean;
  /** Required for openai-compatible providers. */
  readonly baseUrl: string | null;
  readonly defaultModel: string | null;
  readonly enabledModels: readonly string[];
  /** `null` means "use the catalog policy". */
  readonly rateLimitOverride: { readonly requestsPerMinute: number | null; readonly tokensPerMinute: number | null } | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ApiKeyStatus = 'unverified' | 'valid' | 'invalid' | 'revoked';

/** Metadata only. The raw key lives encrypted in the local vault. */
export interface ApiKeyMetadata {
  readonly id: string;
  readonly providerId: ProviderId;
  readonly label: string;
  /** Masked display hint, e.g. `AIza••••1w2e`. Never the raw secret. */
  readonly hint: string;
  readonly status: ApiKeyStatus;
  readonly lastVerifiedAt: number | null;
  readonly lastUsedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Per-key runtime state for the failover pool (Phase 3). Written on every
 * provider outcome; read by key selection. The shape lives in the domain
 * (`KeyRuntimeState`) so selection logic, persistence and UI share one type.
 */
export interface KeyRuntime extends KeyRuntimeState {
  readonly providerId: ProviderId;
}

/** Locally encrypted secret. Never synced, never logged. */
export interface SecretRecord {
  readonly id: string;
  /** Base64 AES-GCM ciphertext. */
  readonly ciphertext: string;
  /** Base64 AES-GCM IV. */
  readonly iv: string;
  /** Vault format version, enables future algorithm upgrades. */
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type JobPayload = {
  readonly documentId?: string;
  readonly projectId?: string;
  readonly format?: string;
  readonly endpoint?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
};

export type JobResult = {
  readonly pageCount?: number;
  readonly charCount?: number;
  readonly inspectedPages?: number;
  readonly synced?: number;
  readonly [key: string]: unknown;
};

export interface JobRecord {
  readonly id: string;
  readonly type: JobType;
  readonly state: JobState;
  readonly projectId: string | null;
  readonly documentId: string | null;
  readonly label: string;
  readonly payload: JobPayload;
  readonly progress: ProgressState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly priority: number;
  readonly queuedAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly updatedAt: number;
  readonly lastError: ErrorState | null;
  /** Incremented when a refresh interrupts a running job (resumability). */
  readonly interruptions: number;
  readonly result: JobResult | null;
}

/**
 * Crash-recovery checkpoint and finished export file (Phase 5), keyed by job.
 *
 * While a job renders, `bytes` is a resumable PDF checkpoint holding every
 * page finished so far (a retry never restarts from page 1); once the job
 * validates and finishes, `bytes` becomes the downloadable file and `findings`
 * records what validation said. Raw API keys never reach this record - only
 * produced bytes plus layout/validation metadata.
 */
export interface ExportArtifact {
  readonly jobId: string;
  readonly projectId: string;
  readonly documentId: string;
  /** Target container: `pdf`, `txt`, `md`, `docx`, `html`, `json`. */
  readonly format: string;
  readonly fileName: string;
  /** Plan signature; a checkpoint only resumes while the plan still matches. */
  readonly signature: string;
  /** Planned page count when the checkpoint was written. */
  readonly pageCount: number;
  /** Pages finished inside `bytes` (0 before the first checkpoint). */
  readonly renderedPages: number;
  /** `rendering`/`failed` = resume checkpoint, `ready` = downloadable file. */
  readonly state: 'rendering' | 'ready' | 'failed';
  readonly bytes: ArrayBuffer | null;
  /** Pre-download validation findings (errors block the download). */
  readonly findings: readonly ExportFinding[] | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface UsageSnapshot {
  readonly id: string;
  readonly providerId: ProviderId;
  readonly model: string | null;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly estimatedCostUsd: number | null;
  readonly source: 'engine' | 'manual';
  /**
   * Whether the token figures came from provider response usage
   * (`provider_reported`) or were counted locally without one
   * (`locally_estimated`). Absent on Phase 1 rows = estimated.
   */
  readonly basis?: 'provider_reported' | 'locally_estimated';
  readonly updatedAt: number;
}

export type SyncStatus = 'pending' | 'in_flight' | 'failed' | 'done';

export interface SyncRecord {
  readonly id: string;
  readonly entity: 'projects' | 'documents' | 'settings';
  readonly entityId: string;
  readonly op: 'upsert' | 'delete';
  readonly payload: Record<string, unknown> | null;
  readonly status: SyncStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ErrorLogRecord {
  readonly id: string;
  readonly level: 'warn' | 'error';
  readonly scope: string;
  readonly message: string;
  readonly code: string | null;
  readonly context: Record<string, unknown> | null;
  readonly stack: string | null;
  readonly occurredAt: number;
}
