import { AppError } from '../core/errors/appError';
import type { BBox } from '../domain/analysis/ir';

/** Input handed to an OCR provider for one page. */
export interface OcrPageInput {
  readonly documentId: string;
  readonly pageIndex: number;
  /** Page size in content-space points (0 when the page failed earlier). */
  readonly width: number;
  readonly height: number;
  /** Rendered page pixels (PNG) when the caller produced them, else null. */
  readonly image: Blob | null;
  /** Image pixels per page point, so `pixels / scale = points`. */
  readonly scale: number;
  /** Preferred recognition language as an app code (e.g. `en`). */
  readonly language: string;
}

/** One recognized line with geometry, in page points (top-left origin). */
export interface OcrLineResult {
  readonly text: string;
  readonly bbox: BBox;
}

export interface OcrPageResult {
  readonly text: string;
  /** Provider-reported confidence in 0..1. */
  readonly confidence: number;
  /** Recognized lines with geometry; omitted by providers that return text only. */
  readonly lines?: readonly OcrLineResult[];
}

export interface OcrProvider {
  readonly id: string;
  readonly label: string;
  /** App language codes this provider ships a model for. */
  readonly languages: readonly string[];
  recognize(input: OcrPageInput): Promise<OcrPageResult>;
}

class OcrRegistry {
  private readonly providers = new Map<string, OcrProvider>();

  register(provider: OcrProvider): void {
    this.providers.set(provider.id, provider);
  }

  unregister(id: string): void {
    this.providers.delete(id);
  }

  /** Currently registered providers; empty until one is registered at boot. */
  available(): readonly OcrProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): OcrProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * First provider that ships a model for `language`. Recognition is skipped
   * when nothing matches: an engine without the language must not guess.
   */
  firstSupporting(language: string): OcrProvider | undefined {
    return this.available().find((provider) => provider.languages.includes(language));
  }

  /**
   * Runs the first registered provider (or a specific one). Throws
   * `unsupported` when none exists - never returns invented text.
   */
  async recognize(input: OcrPageInput, providerId?: string): Promise<OcrPageResult> {
    const provider = providerId ? this.providers.get(providerId) : this.providers.values().next().value;
    if (!provider) {
      throw new AppError(
        'No OCR provider is available. Configure a real OCR provider to read image-only pages.',
        { code: 'unsupported', retryable: false },
      );
    }
    return provider.recognize(input);
  }
}

export const ocrRegistry = new OcrRegistry();
