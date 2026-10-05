import { NavLink } from 'react-router-dom';
import { APP_PHASE, APP_PHASE_TOTAL } from '../../config/appConfig';
import { NAV_GROUPS } from '../../config/navigation';
import { useT } from '../../i18n/I18nProvider';
import { Icon } from '../ui/Icon';

export interface SidebarProps {
  readonly collapsed: boolean;
  readonly mobileOpen: boolean;
  readonly onToggleCollapsed: () => void;
  readonly onNavigate: () => void;
}

export function Sidebar({ collapsed, mobileOpen, onToggleCollapsed, onNavigate }: SidebarProps) {
  const t = useT();

  return (
    <aside className="sidebar" data-open={mobileOpen || undefined} aria-label={t('nav.groupWorkspace')}>
      <div className="sidebar-brand">
        <span className="sidebar-brand__mark" aria-hidden="true">
          <Icon name="translate" size={16} />
        </span>
        <div className="sidebar-brand__text">
          <div className="sidebar-brand__title">{t('app.name')}</div>
          <div className="sidebar-brand__phase">{t('app.phase', { phase: APP_PHASE, total: APP_PHASE_TOTAL })}</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV_GROUPS.map((group) => (
          <div className="nav-group" key={group.labelKey}>
            <div className="nav-group__label">{t(group.labelKey)}</div>
            <div className="nav-group__items">
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => ['nav-item', isActive ? 'is-active' : ''].filter(Boolean).join(' ')}
                  onClick={onNavigate}
                  title={t(item.labelKey)}
                >
                  <span className="nav-item__icon">
                    <Icon name={item.icon} size={16} />
                  </span>
                  <span className="nav-item__label">{t(item.labelKey)}</span>
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button type="button" className="sidebar-collapse-btn" onClick={onToggleCollapsed}>
          <Icon name={collapsed ? 'chevronRight' : 'chevronsLeft'} size={16} />
          <span>{collapsed ? t('nav.expand') : t('nav.collapse')}</span>
        </button>
      </div>
    </aside>
  );
}
