import type { DocumentMetadata } from '../../domain/analysis/ir';
import { useT } from '../../i18n/I18nProvider';

/** File-level metadata rows from the metadata stage; empty state when absent. */
export function AnalysisMetadataCard({ metadata }: { readonly metadata: DocumentMetadata | null }) {
  const t = useT();
  if (!metadata) {
    return <p className="muted">{t('analysis.metaNone')}</p>;
  }

  const rows: readonly (readonly [string, string | null])[] = [
    [t('analysis.metaTitle'), metadata.title],
    [t('analysis.metaAuthor'), metadata.author],
    [t('analysis.metaFormat'), metadata.format],
    [t('analysis.metaProducer'), metadata.producer],
  ];
  const present = rows.filter(([, value]) => value !== null && value !== '');
  if (present.length === 0) {
    return <p className="muted">{t('analysis.metaNone')}</p>;
  }

  return (
    <dl className="meta-list">
      {present.map(([label, value]) => (
        <div key={label} className="meta-list__row">
          <dt>{label}</dt>
          <dd className="truncate" title={value ?? ''}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
