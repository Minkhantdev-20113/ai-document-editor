import type { DocumentPage } from '../../db/entities';
import { useT } from '../../i18n/I18nProvider';
import { Badge } from '../ui/StatusBadge';

export interface PageNavStat {
  readonly total: number;
  readonly translated: number;
  readonly warnings: number;
}

interface PageNavPanelProps {
  readonly pages: readonly DocumentPage[];
  /** pageId -> unit counters, computed by the workspace from live units. */
  readonly stats: ReadonlyMap<string, PageNavStat>;
  /** null selects the whole document ("All pages"). */
  readonly selectedPageId: string | null;
  readonly onSelect: (pageId: string | null) => void;
}

/**
 * Left rail (Phase 4): page/document navigation with per-page progress and
 * unresolved-warning counts, so jumping between pages is one click.
 */
export function PageNavPanel({ pages, stats, selectedPageId, onSelect }: PageNavPanelProps) {
  const t = useT();

  let totalUnits = 0;
  let translatedUnits = 0;
  let warningUnits = 0;
  for (const stat of stats.values()) {
    totalUnits += stat.total;
    translatedUnits += stat.translated;
    warningUnits += stat.warnings;
  }

  return (
    <nav className="stack stack-1" aria-label={t('workspace.pagesTitle')}>
      <button
        type="button"
        className="editor-page-btn"
        data-selected={selectedPageId === null}
        aria-current={selectedPageId === null ? 'true' : undefined}
        onClick={() => onSelect(null)}
      >
        <span className="text-sm">{t('editor.allPages')}</span>
        <span className="text-xs subtle">
          {translatedUnits}/{totalUnits}
        </span>
        {warningUnits > 0 && <Badge tone="warning">{warningUnits}</Badge>}
      </button>
      {pages.map((page) => {
        const stat = stats.get(page.id);
        const selected = selectedPageId === page.id;
        return (
          <button
            key={page.id}
            type="button"
            className="editor-page-btn"
            data-selected={selected}
            aria-current={selected ? 'true' : undefined}
            onClick={() => onSelect(page.id)}
          >
            <span className="text-sm">{t('editor.page', { page: page.pageIndex + 1 })}</span>
            <span className="text-xs subtle">
              {stat ? `${stat.translated}/${stat.total}` : '0/0'}
            </span>
            {stat && stat.warnings > 0 && <Badge tone="warning">{stat.warnings}</Badge>}
          </button>
        );
      })}
    </nav>
  );
}
