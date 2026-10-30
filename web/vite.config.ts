import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import { NAVIGATE_FALLBACK_DENYLIST } from './pwa-config';

// https://vite.dev/config/
export default defineConfig({
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
});
