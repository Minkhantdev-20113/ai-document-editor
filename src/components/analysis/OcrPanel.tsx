import type { DocumentPage } from '../../db/entities';
import { useT } from '../../i18n/I18nProvider';
import { ocrRegistry } from '../../services/ocrRegistry';
import { Notice } from '../ui/Notice';

/**
 * Honest reporting for image-only pages. Phase 2 ships no OCR engine: pages
 * marked `needs_ocr` are listed with their page numbers and the panel states
 * plainly that nothing will be recognized until a real provider is configured
 * (the `ocrRegistry` seam) - text is never invented.
 */
export function OcrPanel({ pages }: { readonly pages: readonly DocumentPage[] }) {
  const t = useT();
  if (pages.length === 0) return null;
  const providers = ocrRegistry.available();
  const numbers = pages.map((page) => page.pageIndex + 1).join(', ');

  return (
    <div className="stack stack-3">
      <Notice tone="warning">{t('analysis.ocrBody', { pages: numbers })}</Notice>
      {providers.length === 0 && <Notice tone="neutral">{t('analysis.ocrUnavailable')}</Notice>}
    </div>
  );
}
