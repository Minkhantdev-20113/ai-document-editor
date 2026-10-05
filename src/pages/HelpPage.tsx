import { APP_NAME, APP_PHASE, APP_PHASE_TOTAL, APP_VERSION } from '../config/appConfig';
import { useDocumentTitle } from '../hooks/useSystem';
import { useT } from '../i18n/I18nProvider';
import { Icon, type IconName } from '../components/ui/Icon';
import { PageHeader } from '../components/ui/PageHeader';

interface HelpCard {
  readonly icon: IconName;
  readonly titleKey: string;
  readonly bodyKey: string;
}

const CARDS: readonly HelpCard[] = [
  { icon: 'database', titleKey: 'help.architecture', bodyKey: 'help.architectureBody' },
  { icon: 'zap', titleKey: 'help.offlineFirst', bodyKey: 'help.offlineFirstBody' },
  { icon: 'shield', titleKey: 'help.byok', bodyKey: 'help.byokBody' },
];

/** In-app documentation: how the app is built and what each phase delivers. */
export function HelpPage() {
  const t = useT();
  useDocumentTitle(t('help.title'));

  return (
    <div className="page">
      <PageHeader
        title={t('help.title')}
        subtitle={t('help.subtitle')}
        actions={<span className="text-xs subtle">{APP_NAME} · {APP_VERSION}</span>}
      />

      <div className="help-grid">
        {CARDS.map((card) => (
          <article className="help-card" key={card.titleKey}>
            <span className="empty__icon" aria-hidden="true">
              <Icon name={card.icon} size={18} />
            </span>
            <h2 className="help-card__title">{t(card.titleKey)}</h2>
            <p className="help-card__body">{t(card.bodyKey)}</p>
          </article>
        ))}
      </div>

      <div className="help-grid">
        <article className="help-card">
          <h2 className="help-card__title">{t('help.phases')}</h2>
          <ul className="stack stack-2" style={{ paddingLeft: 'var(--space-5)' }}>
            <li className="help-card__body">{t('help.phase1')}</li>
            <li className="help-card__body">{t('help.phase2')}</li>
          </ul>
          <p className="text-xs subtle">
            {t('app.phase', { phase: APP_PHASE, total: APP_PHASE_TOTAL })}
          </p>
        </article>

        <article className="help-card">
          <h2 className="help-card__title">{t('help.troubleshooting')}</h2>
          <ul className="stack stack-2" style={{ paddingLeft: 'var(--space-5)' }}>
            <li className="help-card__body">{t('help.troubleReload')}</li>
            <li className="help-card__body">{t('help.troubleStorage')}</li>
            <li className="help-card__body">{t('help.troubleKey')}</li>
          </ul>
        </article>

        <article className="help-card">
          <h2 className="help-card__title">{t('help.shortcuts')}</h2>
          <div className="kv">
            <span className="kv__key">{t('common.language')}</span>
            <span className="kv__value">{t('settings.languageHint')}</span>
          </div>
          <div className="kv">
            <span className="kv__key">{t('theme.label')}</span>
            <span className="kv__value">{t('common.theme')}</span>
          </div>
          <div className="kv">
            <span className="kv__key">{t('common.status')}</span>
            <span className="kv__value">{t('errors.network_offline')}</span>
          </div>
        </article>
      </div>
    </div>
  );
}
