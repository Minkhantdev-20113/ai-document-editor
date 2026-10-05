import { useDocumentTitle } from '../hooks/useSystem';
import { useT } from '../i18n/I18nProvider';
import { ButtonLink } from '../components/ui/Button';
import { Icon } from '../components/ui/Icon';

/** Unknown route: explicit dead end with a way back. */
export function NotFoundPage() {
  const t = useT();
  useDocumentTitle(t('errors.notFoundTitle'));

  return (
    <div className="error-page">
      <span className="empty__icon">
        <Icon name="alertCircle" size={20} />
      </span>
      <h1 className="page-header__title">{t('errors.notFoundTitle')}</h1>
      <p className="muted">{t('errors.notFoundBody')}</p>
      <span className="error-page__code">404</span>
      <div className="row row-2">
        <ButtonLink to="/" variant="primary" icon={<Icon name="dashboard" size={14} />}>
          {t('nav.dashboard')}
        </ButtonLink>
      </div>
    </div>
  );
}
