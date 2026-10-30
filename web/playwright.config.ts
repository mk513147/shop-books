import { defineConfig, devices } from '@playwright/test';

// Set PW_CHANNEL=msedge (or chrome) to use an installed browser instead of Playwright's download.
const channel = process.env.PW_CHANNEL || undefined;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) } },
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        ...(channel ? { channel } : {}),
      },
    },
  ],
  // The e2e suite runs against the production build so the manifest and service worker are real.
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
