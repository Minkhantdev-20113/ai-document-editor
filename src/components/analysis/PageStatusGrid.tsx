import type { DocumentPage } from '../../db/entities';
import { useT } from '../../i18n/I18nProvider';

const STATUS_CLASS: Record<DocumentPage['status'], string> = {
  pending: 'page-chip--pending',
  ready: 'page-chip--ready',
  failed: 'page-chip--failed',
  needs_ocr: 'page-chip--ocr',
};

/**
 * Compact page matrix: one chip per page, colored by persisted status
 * (pending / ready / failed / needs OCR). Clicking selects the page.
 */
export function PageStatusGrid({
  pages,
  selectedPageId,
  onSelect,
}: {
  readonly pages: readonly DocumentPage[];
  readonly selectedPageId: string | null;
  readonly onSelect: (pageId: string) => void;
}) {
  const t = useT();
  return (
    <div className="page-chip-grid">
      {pages.map((page) => {
        const selected = page.id === selectedPageId;
        return (
          <button
            key={page.id}
            type="button"
            className={['page-chip', STATUS_CLASS[page.status], selected ? 'is-selected' : '']
              .filter(Boolean)
              .join(' ')}
            aria-pressed={selected}
            title={`#${page.pageIndex + 1} · ${t(`status.${page.status}`)}`}
            onClick={() => onSelect(page.id)}
          >
            {page.pageIndex + 1}
          </button>
        );
      })}
    </div>
  );
}
