import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { NAVIGATE_FALLBACK_DENYLIST } from './pwa-config';
import { parseApiBaseUrl } from './src/lib/api-base-url';
import { vercelApiProxyProblem } from './vercel-config';

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
    throw new Error('VITE_API_BASE_URL must be set for a deployed build (e.g. /api/v1 with the Vercel proxy). See docs/staging-deployment.md.');
  }
  // Same-origin API on Vercel: the /api proxy rewrite to the backend must exist and be real.
  if (process.env.VERCEL && parsed.ok && !parsed.crossOrigin && (value ?? '').trim()) {
    const problem = vercelApiProxyProblem(JSON.parse(readFileSync(path.join(import.meta.dirname, 'vercel.json'), 'utf8')));
    if (problem) throw new Error(problem);
  }
}

/**
 * Unique, non-sensitive id of this build (time + random; no commit hash, host or environment
 * name). Compiled into the bundle and published as /version.json so open apps can tell that a new
 * release is live (src/features/system/app-update.ts). SHOP_BOOKS_BUILD_ID overrides it (tests).
 */
const BUILD_ID = process.env.SHOP_BOOKS_BUILD_ID || `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`;

/** Emits /version.json (never precached: the service worker only precaches js/css/html/images). */
function versionFile(buildId: string): Plugin {
  return {
    name: 'shop-books-version-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId }) });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  checkApiBaseUrl(mode, command);
  return {
    define: {
      __SHOP_BOOKS_BUILD_ID__: JSON.stringify(BUILD_ID),
    },
    plugins: [
      react(),
      tailwindcss(),
      versionFile(BUILD_ID),
      VitePWA({
        // The new service worker takes over at once (skipWaiting/clientsClaim); WHEN the page
        // reloads onto it is decided by the app (src/features/system/app-update.ts), which also
        // registers it (src/main.tsx), so no reload ever interrupts unsaved work.
        registerType: 'autoUpdate',
        injectRegister: false,
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
          // Explicit: with injectRegister false the plugin no longer sets these for autoUpdate.
          skipWaiting: true,
          clientsClaim: true,
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
