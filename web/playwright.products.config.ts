import { defineConfig, devices } from '@playwright/test';

/**
 * Product catalogue end-to-end suite against the REAL API and the LOCAL TEST DATABASE
 * (shop_books_test), seeded fresh at start (see e2e/products/api-server.mjs). Serial: the tests
 * share one database. Set PW_CHANNEL=msedge (or chrome) to use an installed browser.
 *
 *   npm run test:e2e:products
 */
const channel = process.env.PW_CHANNEL || undefined;

export default defineConfig({
  testDir: './e2e/products',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) } },
    { name: 'mobile', use: { ...devices['Pixel 7'], ...(channel ? { channel } : {}) } },
  ],
  webServer: [
    {
      command: 'node e2e/products/api-server.mjs',
      url: 'http://localhost:3000/api/v1/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run build && npm run preview',
      url: 'http://localhost:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
