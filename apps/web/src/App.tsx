import { StrictMode, Suspense, useEffect, useMemo } from 'react';
import { createBrowserRouter, createHashRouter, RouterProvider } from 'react-router';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { ErrorBoundary, PageLoading } from '@/components';
import WindowSizeProvider from '@/providers';
import { usePreferences } from '@/store';
import { makeTheme } from '@/theme';
import { restoreSession } from '@/api';
import i18n from '@/i18n';
import routes from '@/router';
import { pagesDeployment } from '@/deployment';

const router = pagesDeployment ? createHashRouter(routes) : createBrowserRouter(routes);
export default function App() {
  const name = usePreferences((state) => state.theme);
  const language = usePreferences((state) => state.language);
  const theme = useMemo(() => makeTheme(name), [name]);
  useEffect(() => {
    void restoreSession();
  }, []);
  useEffect(() => {
    void i18n.changeLanguage(language);
    document.documentElement.lang = language;
  }, [language]);
  return (
    <StrictMode>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <WindowSizeProvider>
          <ErrorBoundary>
            <Suspense fallback={<PageLoading />}>
              <RouterProvider router={router} />
            </Suspense>
          </ErrorBoundary>
        </WindowSizeProvider>
      </ThemeProvider>
    </StrictMode>
  );
}
