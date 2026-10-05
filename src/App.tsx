import { BrowserRouter } from 'react-router-dom';
import { useTheme } from './hooks/useSettings';
import { AppRoutes } from './routes/AppRoutes';

/**
 * Router root.
 * Theme application lives here so every route shares one effect instead of
 * re-declaring it per page.
 */
export function App() {
  useTheme();

  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
