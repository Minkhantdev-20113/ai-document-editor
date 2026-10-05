import { useLocation } from 'react-router-dom';
import { useI18n, useT } from '../../i18n/I18nProvider';
import { useOnlineStatus } from '../../hooks/useSystem';
import { useTheme } from '../../hooks/useSettings';
import { Icon } from '../ui/Icon';
import { NAV_GROUPS } from '../../config/navigation';

export interface HeaderProps {
  readonly onOpenMenu: () => void;
}

function useCurrentTitle(): string {
  const t = useT();
  const location = useLocation();
  const path = location.pathname;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      const isMatch = item.end ? path === item.to : path === item.to || path.startsWith(`${item.to}/`);
      if (isMatch) return t(item.labelKey);
    }
  }
  return t('nav.dashboard');
}

export function Header({ onOpenMenu }: HeaderProps) {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const online = useOnlineStatus();
  const { cycle, resolved } = useTheme();
  const title = useCurrentTitle();

  return (
    <header className="app-header">
      <div className="app-header__left">
        <button
          type="button"
          className="btn btn--ghost btn--icon icon-btn__mobile"
          aria-label={t('nav.openMenu')}
          onClick={onOpenMenu}
        >
          <Icon name="menu" size={18} />
        </button>
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <span className="truncate">{t('app.name')}</span>
          <span className="breadcrumb__sep" aria-hidden="true">
            /
          </span>
          <span className="breadcrumb__current truncate">{title}</span>
        </nav>
      </div>

      <div className="app-header__right">
        <span
          className="badge badge--no-dot"
          title={online ? t('common.online') : t('common.offline')}
          style={{
            color: online ? 'var(--color-success)' : 'var(--color-warning)',
            background: online ? 'var(--color-success-soft)' : 'var(--color-warning-soft)',
          }}
        >
          {online ? t('common.online') : t('common.offline')}
        </span>

        <div className="segmented" role="group" aria-label={t('common.language')}>
          <button
            type="button"
            className={['segmented__item', locale === 'my' ? 'is-active' : ''].filter(Boolean).join(' ')}
            onClick={() => setLocale('my')}
            lang="my"
          >
            မြန်မာ
          </button>
          <button
            type="button"
            className={['segmented__item', locale === 'en' ? 'is-active' : ''].filter(Boolean).join(' ')}
            onClick={() => setLocale('en')}
            lang="en"
          >
            EN
          </button>
        </div>

        <button
          type="button"
          className="btn btn--ghost btn--icon"
          onClick={cycle}
          aria-label={`${t('theme.label')}: ${t(`theme.${resolved}`)}`}
          title={t(`theme.${resolved}`)}
        >
          <Icon name={resolved === 'dark' ? 'moon' : 'sun'} size={16} />
        </button>
      </div>
    </header>
  );
}
