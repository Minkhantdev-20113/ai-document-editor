// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ROUTES } from '../config/appConfig';
import { my } from '../i18n/dict/my';
import { I18nProvider } from '../i18n/I18nProvider';
import { ToastProvider } from '../state/ToastProvider';
import { AppRoutes } from './AppRoutes';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom does not implement matchMedia; the app uses it for theme/responsive
// decisions, so a minimal stub keeps effects running in tests.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

/** path → the Burmese page title that must appear for that route. */
const CASES: readonly (readonly [string, string])[] = [
  [ROUTES.dashboard, my.dashboard.title],
  [ROUTES.projects, my.projects.title],
  [ROUTES.project('demo-project'), my.projects.title],
  [ROUTES.workspace, my.workspace.title],
  [ROUTES.workspaceProject('demo-project'), my.workspace.title],
  [ROUTES.analysis('demo-project'), my.analysis.title],
  [ROUTES.workspaceEditor('demo-project'), my.editor.workspaceTitle],
  [ROUTES.editor, my.editor.title],
  [ROUTES.exportCenter, my.exportCenter.title],
  [ROUTES.providers, my.providers.title],
  [ROUTES.apiKeys, my.apiKeys.title],
  [ROUTES.usage, my.usage.title],
  [ROUTES.settings, my.settings.title],
  [ROUTES.help, my.help.title],
  ['/no-such-page', my.errors.notFoundTitle],
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderAt(path: string): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <I18nProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <AppRoutes />
          </MemoryRouter>
        </ToastProvider>
      </I18nProvider>,
    );
  });
  // Let the IndexedDB-backed loaders settle so views reach their resting state.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return container.innerHTML;
}

afterEach(async () => {
  if (root) {
    const current = root;
    root = null;
    await act(async () => current.unmount());
  }
  container?.remove();
  container = null;
});

describe('application routing', () => {
  it.each(CASES)('renders %s inside the shell', async (path, expectedTitle) => {
    const html = await renderAt(path);
    expect(html).toContain('app-shell');
    expect(html).toContain(expectedTitle);
    // The route must render its own view, not the route error boundary.
    expect(html).not.toContain(my.errors.boundaryTitle);
  });

  it('renders the sidebar navigation with every top-level section', async () => {
    const html = await renderAt(ROUTES.dashboard);
    for (const label of [
      my.nav.dashboard,
      my.nav.projects,
      my.nav.workspace,
      my.nav.editor,
      my.nav.exportCenter,
      my.nav.providers,
      my.nav.apiKeys,
      my.nav.usage,
      my.nav.settings,
      my.nav.help,
    ]) {
      expect(html).toContain(label);
    }
  });

  it('sends unknown routes to the not-found view', async () => {
    const html = await renderAt('/totally/unknown');
    expect(html).toContain(my.errors.notFoundBody);
  });
});
