import { Route, Routes } from 'react-router-dom';
import { ROUTES } from '../config/appConfig';
import { AppShell } from '../components/layout/AppShell';
import { ApiKeysPage } from '../pages/ApiKeysPage';
import { AnalysisPage } from '../pages/AnalysisPage';
import { DashboardPage } from '../pages/DashboardPage';
import { EditorPage } from '../pages/EditorPage';
import { ExportCenterPage } from '../pages/ExportCenterPage';
import { HelpPage } from '../pages/HelpPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { ProjectDetailPage } from '../pages/ProjectDetailPage';
import { ProjectsPage } from '../pages/ProjectsPage';
import { ProvidersPage } from '../pages/ProvidersPage';
import { SettingsPage } from '../pages/SettingsPage';
import { TranslationEditorPage } from '../pages/TranslationEditorPage';
import { UsagePage } from '../pages/UsagePage';
import { WorkspacePage } from '../pages/WorkspacePage';

/**
 * Application route table.
 * Every page renders inside the shell (sidebar + header + route error
 * boundary), so a failing view never takes the navigation with it.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path={ROUTES.dashboard} element={<DashboardPage />} />
        <Route path={ROUTES.projects} element={<ProjectsPage />} />
        <Route path={ROUTES.project(':projectId')} element={<ProjectDetailPage />} />
        <Route path={ROUTES.workspace} element={<WorkspacePage />} />
        <Route path={ROUTES.workspaceProject(':projectId')} element={<WorkspacePage />} />
        <Route path={ROUTES.analysis(':projectId')} element={<AnalysisPage />} />
        <Route
          path={ROUTES.workspaceEditor(':projectId')}
          element={<TranslationEditorPage />}
        />
        <Route path={ROUTES.editor} element={<EditorPage />} />
        <Route path={ROUTES.exportCenter} element={<ExportCenterPage />} />
        <Route path={ROUTES.providers} element={<ProvidersPage />} />
        <Route path={ROUTES.apiKeys} element={<ApiKeysPage />} />
        <Route path={ROUTES.usage} element={<UsagePage />} />
        <Route path={ROUTES.settings} element={<SettingsPage />} />
        <Route path={ROUTES.help} element={<HelpPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
