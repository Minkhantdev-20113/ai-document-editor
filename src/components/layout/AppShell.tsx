import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useT } from '../../i18n/I18nProvider';
import { useOnlineStatus } from '../../hooks/useSystem';
import { useSettings } from '../../hooks/useSettings';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { Icon } from '../ui/Icon';
import { Header } from './Header';
import { Sidebar } from './Sidebar';

/**
 * Application shell: fixed sidebar + header + routed content area.
 * Layout state (collapse, mobile drawer) is local; persistence goes through
 * the settings service so it survives reloads.
 */
export function AppShell() {
  const t = useT();
  const location = useLocation();
  const { settings, set } = useSettings();
  const online = useOnlineStatus();
  const collapsed = settings.sidebarCollapsed;
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile drawer when the browser navigates (back/forward).
  // In-app links close it through the Sidebar `onNavigate` callback.
  useEffect(() => {
    const close = () => setMobileOpen(false);
    window.addEventListener('popstate', close);
    return () => window.removeEventListener('popstate', close);
  }, []);

  return (
    <div
      className="app-shell"
      data-collapsed={collapsed || undefined}
      data-mobile-open={mobileOpen || undefined}
    >
      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onToggleCollapsed={() => set('sidebarCollapsed', !collapsed)}
        onNavigate={() => setMobileOpen(false)}
      />
      {mobileOpen && <div className="sidebar-scrim" onClick={() => setMobileOpen(false)} aria-hidden="true" />}

      <Header onOpenMenu={() => setMobileOpen(true)} />

      <main className="app-main" id="main-content">
        {!online && (
          <div className="system-banner" role="status">
            <Icon name="alertTriangle" size={13} />
            {t('errors.network_offline')}
          </div>
        )}
        <ErrorBoundary resetKey={location.pathname} scope="route">
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
