import type { BlockKind } from '../../domain/analysis/ir';
import type { DocumentBlock } from '../../db/entities';
import { useT } from '../../i18n/I18nProvider';
import { EmptyState } from '../ui/EmptyState';
import { Badge, type BadgeTone } from '../ui/StatusBadge';

const KIND_TONE: Record<BlockKind, BadgeTone> = {
  heading: 'primary',
  paragraph: 'neutral',
  list: 'info',
  table: 'info',
  caption: 'warning',
  quote: 'neutral',
  code: 'neutral',
  other: 'neutral',
};

/** Reading-ordered block table for one page (kind, text, typography). */
export function BlockTable({ blocks }: { readonly blocks: readonly DocumentBlock[] }) {
  const t = useT();
  if (blocks.length === 0) {
    return <EmptyState icon="fileText" title={t('analysis.blocksEmpty')} />;
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th className="num">{t('analysis.colOrder')}</th>
            <th>{t('analysis.colKind')}</th>
            <th>{t('analysis.colText')}</th>
            <th className="num">{t('analysis.colSize')}</th>
          </tr>
        </thead>
        <tbody>
          {blocks.map((block) => (
            <tr key={block.id}>
              <td className="num">{block.readingOrder + 1}</td>
              <td>
                <Badge tone={KIND_TONE[block.kind]}>{t(`analysis.kind.${block.kind}`)}</Badge>
              </td>
              <td>
                <span className="truncate" title={`${block.text}\n${block.flags.join(', ')}`}>
                  {block.text}
                </span>
              </td>
              <td className="num mono text-xs">
                {block.font.size}pt
                {block.font.bold ? ' B' : ''}
                {block.font.italic ? ' I' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
