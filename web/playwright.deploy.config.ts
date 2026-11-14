import { defineConfig, devices } from '@playwright/test';

/**
 * Installed-PWA update checks against two real production builds served like two Vercel
 * deployments (e2e/deploy-sim/server.mjs). Run with: npm run test:e2e:deploy
 * Serial: the tests share the simulated "live deployment" switch.
 */
const channel = process.env.PW_CHANNEL || undefined;

export default defineConfig({
  testDir: './e2e/deploy-sim',
  testMatch: '**/*.deploy.ts',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4180',
    trace: 'retain-on-failure',
    ...devices['Pixel 7'],
    ...(channel ? { channel } : {}),
  },
  webServer: {
    command: 'node e2e/deploy-sim/server.mjs',
    url: 'http://localhost:4180/__sim',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
