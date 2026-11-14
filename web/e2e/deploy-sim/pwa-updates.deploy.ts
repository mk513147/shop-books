import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The installed app (real production build, real service worker) stays open while a NEW frontend
 * is deployed to the same origin. No mocking of /version.json, sw.js or the update flow: the
 * server swaps the files exactly as a new Vercel deployment does (see server.mjs).
 */

const SIM = path.resolve(import.meta.dirname, '../../.deploy-sim');
/** The bundle each build's index.html loads: tells which version a page is really running. */
const entryOf = (version: 'a' | 'b') => /src="(\/assets\/index-[^"]+\.js)"/.exec(fs.readFileSync(path.join(SIM, version, 'index.html'), 'utf8'))![1]!;
const running = (page: Page) => page.evaluate(() => document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src'));

const sim = (request: APIRequestContext, params: Record<string, string>) => request.get(`/__sim?${new URLSearchParams(params)}`);
const notice = (page: Page) => page.getByTestId('app-update-notice');

/** Opens the app like an installed PWA and waits until the service worker controls it. Counts full page loads. */
async function openInstalled(page: Page, url = '/') {
  const loads: string[] = [];
  page.on('load', () => loads.push(page.url()));
  await page.goto(url);
  await page.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller !== null;
  });
  return loads;
}

/**
 * Headless Chrome keeps every tab "visible", so the app-switch is reproduced by reporting the new
 * visibility state and firing the browser's real visibilitychange event (what the app listens to).
 */
const setVisibility = (page: Page, value: 'hidden' | 'visible') =>
  page.evaluate((v) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);

/** Back from the background cache (bfcache), as when switching back to the app. */
const foreground = (page: Page) => page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));

test.beforeEach(async ({ request }) => {
  await sim(request, { reset: '1' });
});

test('real update procedure: version A open, B deployed, app resumed from the background: notice, Update now, B loaded with exactly one reload', async ({ page, request }) => {
  const start = Date.now();
  await page.clock.setFixedTime(start);
  const loads = await openInstalled(page);
  expect(await running(page)).toBe(entryOf('a'));
  await expect(notice(page)).toHaveCount(0);

  await sim(request, { live: 'b' }); // deploy frontend version B; the app stays open, no manual refresh

  // The user switches to another app and back more than a minute later: the page is hidden, then
  // visible again (the browser's visibilitychange event, as Android fires it for an installed PWA).
  await setVisibility(page, 'hidden');
  await page.clock.setFixedTime(start + 61_000);
  await setVisibility(page, 'visible');

  await expect(notice(page)).toContainText('Shop-Books has a new update available.');
  expect(loads).toHaveLength(1);
  // The new service worker may already be installed, but it waits: the running page keeps version A.
  expect(await running(page)).toBe(entryOf('a'));

  const reloaded = page.waitForEvent('load');
  await notice(page).getByRole('button', { name: 'Update now' }).click();
  await expect(notice(page)).toContainText('Updating Shop-Books...');
  await reloaded;
  await expect.poll(() => running(page)).toBe(entryOf('b'));
  await page.waitForTimeout(3000);
  await expect(notice(page)).toHaveCount(0);
  expect(loads).toHaveLength(2);
});

test('a new version that is already installed (waiting service worker) is used, and the old page keeps working meanwhile', async ({ page, request }) => {
  const loads = await openInstalled(page);
  await sim(request, { live: 'b' });
  // The browser's own update check finds B: it installs and WAITS (no automatic takeover).
  const waiting = await page.evaluate(async () => {
    const reg = (await navigator.serviceWorker.getRegistration())!;
    await reg.update();
    const worker = reg.installing ?? reg.waiting;
    if (worker && worker.state !== 'installed') await new Promise((r) => worker.addEventListener('statechange', () => worker.state === 'installed' && r(null)));
    return { waiting: reg.waiting !== null, activeUrl: reg.active?.scriptURL };
  });
  expect(waiting.waiting).toBe(true);
  // The old version's files are still served to the old page (its precache was not deleted).
  const oldEntryStillThere = await page.evaluate(async (entry) => (await fetch(entry)).headers.get('content-type'), entryOf('a'));
  expect(oldEntryStillThere).toContain('javascript');

  await foreground(page);
  const reloaded = page.waitForEvent('load');
  await notice(page).getByRole('button', { name: 'Update now' }).click();
  await reloaded;
  await expect.poll(() => running(page)).toBe(entryOf('b'));
  expect(loads).toHaveLength(2);
});

test('opening the app after a deployment updates it at once (nothing to lose yet), with one reload', async ({ page, context, request }) => {
  await openInstalled(page);
  await sim(request, { live: 'b' });
  const second = await context.newPage(); // the app is opened again (cold start), old service worker in control
  const loads: string[] = [];
  second.on('load', () => loads.push(second.url()));
  await second.goto('/');
  await expect.poll(() => running(second), { timeout: 15_000 }).toBe(entryOf('b'));
  await second.waitForTimeout(3000);
  expect(loads).toHaveLength(2);
});

test('unsaved expense data: no reload, the notice says so, and the update happens after leaving the form', async ({ page, request }) => {
  const loads = await openInstalled(page, '/expenses/new');
  await page.getByLabel('Total expense amount').fill('2500');
  await page.getByLabel('Description (optional)').fill('Stock purchase');

  await sim(request, { live: 'b' });
  await foreground(page);
  await expect(notice(page)).toContainText('Finish and save what you are doing first');
  await page.waitForTimeout(4000);
  expect(loads).toHaveLength(1);
  await expect(page.getByLabel('Total expense amount')).toHaveValue('2500');
  await expect(page.getByLabel('Description (optional)')).toHaveValue('Stock purchase');

  const reloaded = page.waitForEvent('load');
  await page.getByRole('link', { name: 'Cancel' }).click(); // leaves the form on purpose
  await reloaded;
  await expect.poll(() => running(page)).toBe(entryOf('b'));
  expect(loads).toHaveLength(2);
});

test('an open payment dialog: no reload while it is open; updates once the user moves on', async ({ page, request }) => {
  const loads = await openInstalled(page, '/supplier-payments/new');
  await page.getByRole('button', { name: 'Supplier' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose supplier' })).toBeVisible();

  await sim(request, { live: 'b' });
  await foreground(page);
  await expect(notice(page)).toBeVisible();
  await page.waitForTimeout(4000);
  expect(loads).toHaveLength(1);
  await expect(page.getByRole('dialog', { name: 'Choose supplier' })).toBeVisible();

  await page.keyboard.press('Escape');
  const reloaded = page.waitForEvent('load');
  await page.getByRole('link', { name: 'Supplier payments' }).first().click();
  await reloaded;
  await expect.poll(() => running(page)).toBe(entryOf('b'));
});

test('network temporarily unavailable: nothing happens offline; back online the update is detected', async ({ page, context, request }) => {
  const loads = await openInstalled(page);
  await sim(request, { live: 'b' });
  await context.setOffline(true);
  await foreground(page);
  await page.waitForTimeout(2000);
  await expect(notice(page)).toHaveCount(0);
  expect(await running(page)).toBe(entryOf('a')); // the app keeps working offline

  await context.setOffline(false); // the browser's "online" event triggers a check
  await expect(notice(page)).toContainText('Shop-Books has a new update available.');
  const reloaded = page.waitForEvent('load');
  await notice(page).getByRole('button', { name: 'Update now' }).click();
  await reloaded;
  await expect.poll(() => running(page)).toBe(entryOf('b'));
  expect(loads).toHaveLength(2);
});

test('service-worker update fails: no reload into old files; the user is told; Update now then recovers', async ({ page, request }) => {
  const loads = await openInstalled(page);
  await sim(request, { live: 'b', swBroken: '1' });
  await foreground(page);
  await notice(page).getByRole('button', { name: 'Update now' }).click();
  await expect(notice(page)).toContainText('Shop-Books could not update by itself.');
  await page.waitForTimeout(2000);
  expect(loads).toHaveLength(1);

  await sim(request, { swBroken: '0' });
  const reloaded = page.waitForEvent('load');
  await notice(page).getByRole('button', { name: 'Update now' }).click(); // resets the service worker
  await reloaded;
  await expect.poll(() => running(page)).toBe(entryOf('b'));
});

test('backend restart and a new backend release label never reload the app', async ({ page, request }) => {
  const loads = await openInstalled(page);
  await sim(request, { apiDown: '1' }); // restarting
  await foreground(page);
  await page.waitForTimeout(1500);
  await sim(request, { apiDown: '0', apiVersion: '2' }); // back, new release label
  await foreground(page);
  await page.waitForTimeout(2500);
  await expect(notice(page)).toHaveCount(0);
  expect(loads).toHaveLength(1);
});

test('backend compatibility level raised: the update is offered; one reload at most, never a loop', async ({ page, request }) => {
  const loads = await openInstalled(page);
  await sim(request, { compat: '2' }); // the API now needs a newer web app (none deployed yet)
  await foreground(page);
  await expect(notice(page)).toContainText('Shop-Books has a new update available.');
  const reloaded = page.waitForEvent('load');
  await notice(page).getByRole('button', { name: 'Update now' }).click();
  await reloaded;
  await expect(notice(page)).toContainText('Shop-Books could not update by itself.', { timeout: 10_000 });
  await page.waitForTimeout(3000);
  expect(loads).toHaveLength(2);
});
