/**
 * Export document model and render plan (Phase 5).
 *
 * `ExportDocumentInput` is the joined view of analysis blocks and translation
 * units; `RenderPlan` is the structure-preserving layout that the worker
 * turns into PDF/DOCX/HTML pages. Coordinates stay in top-left origin page
 * space (points), exactly like the analysis IR, so bbox geometry from the
 * source document carries through unchanged.
 */
import type {
  BlockAlignment,
  BlockFlag,
  BlockKind,
  BBox,
  FontInfo,
  TableIR,
} from '../analysis/ir';

export type UnitStatusLike = 'pending' | 'in_progress' | 'translated' | 'reviewed' | 'failed';

/** One analysis block joined with its translation unit. */
export interface ExportBlockInput {
  readonly blockId: string;
  readonly orderIndex: number;
  readonly kind: BlockKind;
  readonly bbox: BBox;
  readonly font: FontInfo;
  readonly alignment: BlockAlignment;
  readonly headingLevel: number | null;
  readonly listOrdered: boolean | null;
  readonly table: TableIR | null;
  readonly link: string | null;
  readonly flags: readonly BlockFlag[];
  readonly sourceText: string;
  /** `null` when no translation exists yet; the planner falls back to source. */
  readonly translatedText: string | null;
  readonly unitStatus: UnitStatusLike | null;
}

export interface ExportPageInput {
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly blocks: readonly ExportBlockInput[];
}

export interface ExportDocumentInput {
  readonly documentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly fileName: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly pages: readonly ExportPageInput[];
}

export interface PageMargins {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export type ExportWarningCode =
  | 'missing_translation'
  | 'untranslated_block'
  | 'text_overflow'
  | 'block_continued'
  | 'table_reconstructed'
  | 'glyph_missing'
  | 'source_empty';

export interface ExportWarning {
  readonly code: ExportWarningCode;
  readonly pageIndex?: number;
  readonly blockId?: string;
  readonly detail?: string;
}

/** One laid-out line of text (top-left origin; `baselineY` is the baseline). */
export interface PlannedLine {
  readonly text: string;
  readonly x: number;
  readonly baselineY: number;
  readonly width: number;
  readonly size: number;
  /** Full line box height (leading) in points. */
  readonly height: number;
  /** Extra space added after each space character (justify). */
  readonly wordSpacing: number;
}

export interface PlannedTextBlock {
  readonly type: 'text';
  readonly blockId: string;
  readonly kind: BlockKind;
  /** Original source bbox (geometry we preserve / expand from). */
  readonly sourceBBox: BBox;
  /** Area actually occupied once laid out. */
  readonly bbox: BBox;
  readonly lines: readonly PlannedLine[];
  readonly bold: boolean;
  readonly italic: boolean;
  readonly alignment: BlockAlignment;
  /** Forces the Latin font family (code stays monospace). */
  readonly monospace: boolean;
  readonly link: string | null;
  /** `part > 0` means this is a continuation of a block split across pages. */
  readonly part: number;
}

export interface PlannedTableCell {
  readonly x: number;
  readonly width: number;
  readonly lines: readonly PlannedLine[];
}

export interface PlannedTableRow {
  readonly y: number;
  readonly height: number;
  readonly cells: readonly PlannedTableCell[];
}

export interface PlannedTableBlock {
  readonly type: 'table';
  readonly blockId: string;
  readonly kind: 'table';
  readonly sourceBBox: BBox;
  readonly bbox: BBox;
  readonly columns: readonly { readonly x: number; readonly width: number }[];
  readonly rows: readonly PlannedTableRow[];
  readonly link: string | null;
  readonly part: number;
  /** True when the grid had to be rebuilt instead of copied verbatim. */
  readonly reconstructed: boolean;
}

export type PlannedBlock = PlannedTextBlock | PlannedTableBlock;

export interface PlannedPage {
  /** Source page this page renders (`part === 0` matches it 1:1). */
  readonly sourcePageIndex: number;
  /** 0 = original page, 1..n = continuation pages created by overflow. */
  readonly part: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly margins: PageMargins;
  readonly blocks: readonly PlannedBlock[];
}

export interface RenderPlanStats {
  readonly sourcePages: number;
  readonly pages: number;
  readonly blocks: number;
  readonly characters: number;
}

export interface RenderPlan {
  readonly pages: readonly PlannedPage[];
  readonly warnings: readonly ExportWarning[];
  readonly stats: RenderPlanStats;
}
