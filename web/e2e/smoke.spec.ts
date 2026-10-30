import { expect, test } from '@playwright/test';

test('unauthenticated visitors land on the login page', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Shop-Books' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByText('Dashboard')).toHaveCount(0);
});

test('protected deep links also redirect to login', async ({ page }) => {
  await page.goto('/expenses');
  await expect(page).toHaveURL(/\/login$/);
});

test('unknown routes show a not-found page', async ({ page }) => {
  await page.goto('/definitely-not-a-page');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('layout fits the viewport without horizontal scrolling', async ({ page }) => {
  await page.goto('/login');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('PWA manifest is valid and installable-shaped', async ({ request, page }) => {
  await page.goto('/login');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const manifest = await (await request.get(href!)).json();
  expect(manifest).toMatchObject({ name: 'Shop-Books', short_name: 'Shop-Books', display: 'standalone' });
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
  for (const icon of manifest.icons as { src: string }[]) {
    expect((await request.get(icon.src)).ok()).toBe(true);
  }
});

test('service worker registers and does not cache API responses', async ({ page }) => {
  await page.goto('/login');
  const registered = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return Boolean(reg.active);
  });
  expect(registered).toBe(true);

  const swSource = await (await page.request.get('/sw.js')).text();
  expect(swSource).not.toMatch(/\/api\/(?!\)|\/)/); // no API URL patterns are routed to a cache
  expect(swSource).toContain('NavigationRoute');
  expect(swSource).toMatch(/denylist:\s*\[\/\^\\\/api/);
});
