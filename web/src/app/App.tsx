import { BrowserRouter } from 'react-router-dom';
import { AppUpdateNotice } from '@/features/system/AppUpdateNotice';
import { AppRoutes } from './AppRoutes';
import { ErrorBoundary } from './ErrorBoundary';
import { AppProviders } from './providers';

export function App() {
  return (
    <ErrorBoundary>
      <AppProviders>
        <BrowserRouter>
          <AppUpdateNotice />
          <AppRoutes />
        </BrowserRouter>
      </AppProviders>
    </ErrorBoundary>
  );
}
