import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { NAVIGATE_FALLBACK_DENYLIST } from './pwa-config';
import { parseApiBaseUrl } from './src/lib/api-base-url';

/**
 * Build-time guard: a deployed build (Vercel sets VERCEL=1; or REQUIRE_API_BASE_URL=true) MUST have
 * a valid VITE_API_BASE_URL, otherwise the build fails instead of shipping a frontend that calls the
 * wrong server. Local builds (preview, e2e) keep the same-origin default; an invalid value always fails.
 */
function checkApiBaseUrl(mode: string, command: string): void {
  if (command !== 'build') return;
  const value = loadEnv(mode, import.meta.dirname, 'VITE_').VITE_API_BASE_URL;
  const parsed = parseApiBaseUrl(value);
  if (!parsed.ok) throw new Error(parsed.error);
  if ((process.env.VERCEL || process.env.REQUIRE_API_BASE_URL === 'true') && !(value ?? '').trim()) {
    throw new Error('VITE_API_BASE_URL must be set for a deployed build (e.g. https://<your-tunnel-host>). See docs/staging-deployment.md.');
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  checkApiBaseUrl(mode, command);
  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
        manifest: {
          name: 'Shop-Books',
          short_name: 'Shop-Books',
          description: 'Private shop expense management',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'portrait',
          theme_color: '#0f766e',
          background_color: '#f8fafc',
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // SECURITY: precache only static application assets (the build output).
          // There is deliberately NO runtimeCaching, so API responses and private documents are
          // never stored by the service worker.
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          runtimeCaching: [],
          navigateFallback: '/index.html',
          navigateFallbackDenylist: NAVIGATE_FALLBACK_DENYLIST,
          cleanupOutdatedCaches: true,
        },
        devOptions: { enabled: false },
      }),
    ],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, 'src') },
    },
    server: {
      port: 5173,
      // Same-origin API calls in development: no CORS configuration needed.
      proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
    },
    preview: {
      proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } },
    },
    build: {
      sourcemap: false,
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      css: false,
    },
  };
});
