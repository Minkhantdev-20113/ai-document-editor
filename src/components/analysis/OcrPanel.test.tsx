// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { languageLabel } from '../../config/languages';
import type { DocumentPage, DocumentRecord } from '../../db/entities';
import { I18nProvider } from '../../i18n/I18nProvider';
import { translateStatic } from '../../i18n/static';
import { DEFAULT_SETTINGS, settingsService } from '../../services/settingsService';
import { ocrRegistry, type OcrPageResult } from '../../services/ocrRegistry';
import { OcrPanel } from './OcrPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The panel is the only place users learn what happens to image-only pages,
 * so every state it can show is pinned here: no engine, no model, engine ready.
 */

const PROVIDER_ID = 'panel-ocr';

let container: HTMLDivElement;
let root: Root | null = null;

function render(element: ReactNode): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

function doc(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: 'doc_ocr',
    projectId: 'proj_ocr',
    kind: 'pdf',
    fileName: 'scan.pdf',
    fileSize: 1_024,
    mimeType: 'application/pdf',
    lastModified: 0,
    checksum: null,
    payload: null,
    payloadStored: false,
    sourceLanguage: 'en',
    targetLanguage: 'my',
    pageCount: 2,
    charCount: 0,
    inspectionState: 'ready',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function page(index: number): DocumentPage {
  return {
    id: `doc_ocr_p${index}`,
    projectId: 'proj_ocr',
    documentId: 'doc_ocr',
    pageIndex: index,
    width: 612,
    height: 792,
    rotation: 0,
    charCount: 0,
    unitCount: 0,
    status: 'needs_ocr',
    error: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function register(languages: readonly string[]): void {
  ocrRegistry.register({
    id: PROVIDER_ID,
    label: 'Panel OCR',
    languages,
    recognize: async (): Promise<OcrPageResult> => ({ text: '', confidence: 0 }),
  });
}

beforeEach(() => {
  // English dictionary, regardless of the machine's default UI language.
  vi.spyOn(settingsService, 'get').mockReturnValue({ ...DEFAULT_SETTINGS, language: 'en' });
  vi.spyOn(settingsService, 'load').mockResolvedValue({ ...DEFAULT_SETTINGS, language: 'en' });
});

afterEach(() => {
  ocrRegistry.unregister(PROVIDER_ID);
  vi.restoreAllMocks();
  act(() => root?.unmount());
  root = null;
  container?.remove();
});

describe('OcrPanel', () => {
  it('lists the affected pages and says no engine is installed', () => {
    render(
      <I18nProvider>
        <OcrPanel pages={[page(0), page(1)]} document={doc()} />
      </I18nProvider>,
    );

    expect(container.textContent).toContain('1, 2');
    expect(container.querySelectorAll('.notice')).toHaveLength(2);
    expect(container.querySelector('.notice--info')).toBeNull();
    expect(container.textContent).toContain(translateStatic('analysis.ocrUnavailable'));
  });

  it('promises nothing when an engine has no model for the language', () => {
    register(['my']);
    render(
      <I18nProvider>
        <OcrPanel
          pages={[page(0)]}
          document={doc({ sourceLanguage: 'ja', languageDetection: null })}
        />
      </I18nProvider>,
    );

    expect(container.querySelector('.notice--info')).toBeNull();
    expect(container.textContent).toContain(
      translateStatic('analysis.ocrNoModel', { language: languageLabel('ja') }),
    );
  });

  it('says a re-run reads the pages when a model is installed', () => {
    register(['en']);
    render(
      <I18nProvider>
        <OcrPanel pages={[page(0)]} document={doc()} />
      </I18nProvider>,
    );

    expect(container.querySelector('.notice--info')).not.toBeNull();
    expect(container.textContent).toContain(translateStatic('analysis.ocrReady'));
    expect(container.textContent).not.toContain(translateStatic('analysis.ocrUnavailable'));
  });

  it('renders nothing once every page has been read', () => {
    register(['en']);
    render(
      <I18nProvider>
        <OcrPanel pages={[]} document={doc()} />
      </I18nProvider>,
    );

    expect(container.querySelector('.notice')).toBeNull();
  });
});
