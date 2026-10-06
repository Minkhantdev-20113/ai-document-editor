import { languageLabel } from '../../config/languages';
import type { DocumentPage, DocumentRecord } from '../../db/entities';
import { useT } from '../../i18n/I18nProvider';
import { ocrRegistry } from '../../services/ocrRegistry';
import { preferredOcrLanguage, supportedOcrLanguage } from '../../services/ocr/ocrSupport';
import { Notice } from '../ui/Notice';

/**
 * Reporting for image-only pages: which pages are affected and whether the
 * installed engine can actually read them. Without an engine, or without a
 * model for the page's language, the pages stay empty - text is never
 * invented; the panel only says what a re-run would do.
 */
export function OcrPanel({
  pages,
  document,
}: {
  readonly pages: readonly DocumentPage[];
  readonly document?: DocumentRecord | null;
}) {
  const t = useT();
  if (pages.length === 0 || !document) return null;

  const numbers = pages.map((page) => page.pageIndex + 1).join(', ');
  const providers = ocrRegistry.available();
  const supported = supportedOcrLanguage(document);
  const preferred = preferredOcrLanguage(document);

  return (
    <div className="stack stack-3">
      <Notice tone="warning">{t('analysis.ocrBody', { pages: numbers })}</Notice>
      {providers.length === 0 && <Notice tone="neutral">{t('analysis.ocrUnavailable')}</Notice>}
      {providers.length > 0 && !supported && (
        <Notice tone="neutral">
          {t('analysis.ocrNoModel', { language: preferred ? languageLabel(preferred) : '—' })}
        </Notice>
      )}
      {supported && <Notice tone="info">{t('analysis.ocrReady')}</Notice>}
    </div>
  );
}
