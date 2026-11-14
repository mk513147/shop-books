import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/App';
import { registerServiceWorker } from '@/features/system/app-update';
import { apiBaseUrlProblem } from '@/lib/api-base-url';
import '@/styles/index.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');

// Fail clearly (never silently call the wrong server) when the build has no usable API address.
const configProblem = apiBaseUrlProblem(import.meta.env.VITE_API_BASE_URL, import.meta.env.PROD, window.location.hostname);
if (configProblem) {
  rootElement.innerHTML =
    '<main style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem">' +
    '<h1 style="font-size:1.25rem">Shop-Books is not configured</h1><p id="config-problem"></p>' +
    '<p style="color:#555">Set VITE_API_BASE_URL for this deployment and build it again (docs/staging-deployment.md).</p></main>';
  document.getElementById('config-problem')!.textContent = configProblem;
} else {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // Offline app shell. Registered here (not by an injected script) so the app controls updates.
  if (import.meta.env.PROD) window.addEventListener('load', () => void registerServiceWorker(), { once: true });
}
