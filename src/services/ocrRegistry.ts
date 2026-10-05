import { AppError } from '../core/errors/appError';

/** Input handed to an OCR provider for one page. */
export interface OcrPageInput {
  readonly documentId: string;
  readonly pageIndex: number;
  /** Page size in content-space points (0 when the page failed earlier). */
  readonly width: number;
  readonly height: number;
  /** Rendered page pixels (PNG) when the caller produced them, else null. */
  readonly image: Blob | null;
  /** Preferred recognition language (BCP-47-ish app code). */
  readonly language: string;
}

export interface OcrPageResult {
  readonly text: string;
  /** Provider-reported confidence in 0..1. */
  readonly confidence: number;
}

/**
 * Contract for a real OCR backend (device engine or a provider API).
 * Phase 2 ships no provider: the registry stays empty and recognition fails
 * honestly instead of fabricating text for image-only pages.
 */
export interface OcrProvider {
  readonly id: string;
  readonly label: string;
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

  /** Currently registered providers; empty during Phase 2 by design. */
  available(): readonly OcrProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): OcrProvider | undefined {
    return this.providers.get(id);
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
