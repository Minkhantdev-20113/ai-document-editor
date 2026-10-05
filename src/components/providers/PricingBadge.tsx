import { useT } from '../../i18n/I18nProvider';
import type { PricingType } from '../../providers/modelRegistry';
import { Badge } from '../ui/StatusBadge';

const TONE: Record<PricingType, 'success' | 'info' | 'neutral'> = {
  free: 'success',
  free_tier: 'info',
  paid: 'neutral',
};

/**
 * FREE / FREE TIER / PAID label.
 *
 * Always carries the "pricing changes, nothing is free forever" note in its
 * tooltip, so the badge can never be read as a permanent promise.
 */
export function PricingBadge({ pricing }: { readonly pricing: PricingType }) {
  const t = useT();
  const label =
    pricing === 'free' ? t('registry.free') : pricing === 'free_tier' ? t('registry.freeTier') : t('registry.paid');
  return (
    <Badge tone={TONE[pricing]} dot={false} title={t('registry.pricingDisclaimer')}>
      {label}
    </Badge>
  );
}
