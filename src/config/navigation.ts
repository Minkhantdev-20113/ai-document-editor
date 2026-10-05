import { ROUTES } from './appConfig';
import type { IconName } from '../components/ui/Icon';

export interface NavItem {
  readonly to: string;
  readonly labelKey: string;
  readonly icon: IconName;
  readonly end?: boolean;
}

export interface NavGroup {
  readonly labelKey: string;
  readonly items: readonly NavItem[];
}

/** Sidebar information architecture (labels are localized at render time). */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    labelKey: 'nav.groupWorkspace',
    items: [
      { to: ROUTES.dashboard, labelKey: 'nav.dashboard', icon: 'dashboard', end: true },
      { to: ROUTES.projects, labelKey: 'nav.projects', icon: 'folder' },
      { to: ROUTES.workspace, labelKey: 'nav.workspace', icon: 'layers' },
      { to: ROUTES.editor, labelKey: 'nav.editor', icon: 'pen' },
      { to: ROUTES.exportCenter, labelKey: 'nav.exportCenter', icon: 'download' },
    ],
  },
  {
    labelKey: 'nav.groupConfiguration',
    items: [
      { to: ROUTES.providers, labelKey: 'nav.providers', icon: 'cpu' },
      { to: ROUTES.apiKeys, labelKey: 'nav.apiKeys', icon: 'key' },
      { to: ROUTES.usage, labelKey: 'nav.usage', icon: 'chart' },
    ],
  },
  {
    labelKey: 'nav.groupSystem',
    items: [
      { to: ROUTES.settings, labelKey: 'nav.settings', icon: 'settings' },
      { to: ROUTES.help, labelKey: 'nav.help', icon: 'help' },
    ],
  },
];
