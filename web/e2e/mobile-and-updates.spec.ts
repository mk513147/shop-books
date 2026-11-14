import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Real-browser checks (production build, real CSS and service worker) for:
 *   - search results staying above the phone keyboard (supplier sheet, inline category search);
 *   - the app-update mechanism (new frontend build, backend compatibility change, unsaved input).
 *
 * The API is mocked with context.route (no server or database needed). The on-screen keyboard is
 * simulated by replacing window.visualViewport, which is exactly what a real keyboard changes.
 */

const USER = { id: 'u1', email: 'm@example.com', name: 'Manu', role: 'manager', mustChangePassword: false };

const suppliers = Array.from({ length: 25 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  name: `Supplier ${String(i + 1).padStart(2, '0')}`,
  phone: null,
  address: null,
  notes: null,
  isActive: true,
  version: 1,
  categories: [],
  brands: [],
  expenseCount: 1,
  payable: `${(i + 1) * 100}.00`,
  unallocated: '0.00',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
}));
const categories = Array.from({ length: 30 }, (_, i) => ({
  id: `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  name: `Category ${String(i + 1).padStart(2, '0')}`,
  isActive: true,
  expenseCount: 0,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
}));

interface MockState {
  serverVersion: { version: string | null; clientCompat: number };
  /** null = serve the real /version.json */
  publishedBuild: string | null;
}

async function mockApi(context: BrowserContext, state: MockState) {
  await context.route('**/version.json', async (route) => {
    if (state.publishedBuild === null) return route.continue();
    return route.fulfill({ json: { buildId: state.publishedBuild }, headers: { 'Cache-Control': 'no-store' } });
  });
  await context.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v1', '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/auth/me') return json({ user: USER, csrfToken: 'csrf' });
    if (path === '/version') return json(state.serverVersion);
    if (path === '/health') return json({ status: 'ok', database: 'up', version: state.serverVersion.version, timestamp: new Date().toISOString() });
    if (path === '/sync/changes') return json({ cursor: '1', events: [], truncated: false });
    if (path === '/suppliers') return json({ items: suppliers, pagination: { page: 1, pageSize: 20, total: suppliers.length, totalPages: 2 } });
    if (/^\/suppliers\/[^/]+\/balance$/.test(path)) {
      return json({ balance: { supplierId: 'x', totalBills: '100.00', paidAtPurchase: '0.00', totalPayments: '0.00', allocated: '0.00', payable: '100.00', unallocated: '0.00', netBalance: '100.00', billCount: 1, paymentCount: 0 } });
    }
    if (/^\/suppliers\/[^/]+\/open-bills$/.test(path)) return json({ bills: [] });
    if (path === '/categories') return json({ categories });
    if (path === '/brands') return json({ brands: [] });
    return json({ error: { code: 'NOT_FOUND', message: 'Not mocked' } }, 404);
  });
}

/** Replaces visualViewport with a controllable one; window.__keyboard(px) opens/closes the "keyboard". */
async function fakeKeyboard(page: Page) {
  await page.addInitScript(() => {
    const vv = new EventTarget();
    let covered = 0;
    Object.defineProperties(vv, {
      height: { get: () => window.innerHeight - covered },
      width: { get: () => window.innerWidth },
      offsetTop: { get: () => 0 },
      offsetLeft: { get: () => 0 },
      pageTop: { get: () => window.scrollY },
      pageLeft: { get: () => window.scrollX },
      scale: { get: () => 1 },
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
    (window as unknown as { __keyboard: (px: number) => void }).__keyboard = (px: number) => {
      covered = px;
      vv.dispatchEvent(new Event('resize'));
    };
  });
}
const keyboard = (page: Page, px: number) => page.evaluate((v) => (window as unknown as { __keyboard: (n: number) => void }).__keyboard(v), px);

const KEYBOARD_PX = 330;

test.describe('phone keyboard', () => {
  test.beforeEach(({ isMobile }) => test.skip(!isMobile, 'phone layout only'));

  test('supplier search: the sheet and its results stay above the keyboard and scroll', async ({ page, context }) => {
    await mockApi(context, { serverVersion: { version: '1', clientCompat: 1 }, publishedBuild: null });
    await fakeKeyboard(page);
    await page.goto('/supplier-payments/new');
    await page.getByRole('button', { name: 'Supplier' }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose supplier' });
    await expect(dialog.getByRole('option', { name: /Supplier 01/ })).toBeVisible();
    const search = dialog.getByRole('combobox', { name: 'Search suppliers' });
    await search.click(); // tapping the field opens the keyboard

    await keyboard(page, KEYBOARD_PX);
    const visibleBottom = await page.evaluate((kb) => window.innerHeight - kb, KEYBOARD_PX);
    await expect.poll(async () => (await dialog.boundingBox())!.y + (await dialog.boundingBox())!.height).toBeLessThanOrEqual(visibleBottom + 1);
    const box = (await dialog.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);

    await expect(search).toBeFocused();
    const searchBox = (await search.boundingBox())!;
    expect(searchBox.y + searchBox.height).toBeLessThanOrEqual(visibleBottom);
    // At least one result is fully visible between the search box and the keyboard.
    const first = (await dialog.getByRole('option').first().boundingBox())!;
    expect(first.y + first.height).toBeLessThanOrEqual(visibleBottom);

    // The results scroll inside the sheet; the search box stays where it is.
    const last = dialog.getByRole('option').last();
    await last.scrollIntoViewIfNeeded();
    const lastBox = (await last.boundingBox())!;
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(visibleBottom + 1);
    const searchAfter = (await search.boundingBox())!;
    expect(Math.abs(searchAfter.y - searchBox.y)).toBeLessThan(2);

    // Typing filters; choosing works while the keyboard is open.
    await search.fill('Supplier 2');
    await dialog.getByRole('option', { name: /Supplier 23/ }).click();
    await expect(page.getByRole('button', { name: 'Supplier' })).toHaveText(/Supplier 23/);

    // Keyboard closed again: the sheet returns to the bottom of the screen next time.
    await keyboard(page, 0);
    await page.getByRole('button', { name: 'Supplier' }).click();
    const reopened = (await dialog.boundingBox())!;
    const height = await page.evaluate(() => window.innerHeight);
    expect(Math.abs(reopened.y + reopened.height - height)).toBeLessThan(2);
  });

  test('category search on the expense form: results are shown above the keyboard', async ({ page, context }) => {
    await mockApi(context, { serverVersion: { version: '1', clientCompat: 1 }, publishedBuild: null });
    await fakeKeyboard(page);
    await page.goto('/expenses/new');
    const search = page.getByLabel('Search or add category');
    await search.click();
    await keyboard(page, KEYBOARD_PX);
    const visibleBottom = await page.evaluate((kb) => window.innerHeight - kb, KEYBOARD_PX);
    // The field moves to the top of the screen, below the sticky header.
    await expect.poll(async () => (await search.boundingBox())!.y, { timeout: 3000 }).toBeLessThan(160);
    const header = (await page.locator('header').first().boundingBox())!;
    expect((await search.boundingBox())!.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
    await search.fill('Category 1');
    const option = page.getByTestId('expense-categories').getByRole('button', { name: 'Category 10' });
    const optionBox = (await option.boundingBox())!;
    expect(optionBox.y + optionBox.height).toBeLessThanOrEqual(visibleBottom);
    await option.click();
    await expect(page.getByTestId('expense-categories')).toContainText('Category 10');
  });
});

test.describe('desktop dropdowns are unchanged', () => {
  test.beforeEach(({ isMobile }) => test.skip(isMobile, 'desktop layout only'));

  test('the supplier dialog stays a centred panel even if the viewport reports a keyboard', async ({ page, context }) => {
    await mockApi(context, { serverVersion: { version: '1', clientCompat: 1 }, publishedBuild: null });
    await fakeKeyboard(page);
    await page.goto('/supplier-payments/new');
    await page.getByRole('button', { name: 'Supplier' }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose supplier' });
    await expect(dialog.getByRole('option').first()).toBeVisible();
    const before = (await dialog.boundingBox())!;
    await keyboard(page, KEYBOARD_PX);
    await page.waitForTimeout(200);
    const after = (await dialog.boundingBox())!;
    expect(after).toEqual(before);
  });
});

test.describe('app updates', () => {
  // One browser is enough for the update logic.
  test.beforeEach(({ isMobile }) => test.skip(!isMobile, 'run once (installed-PWA-like phone context)'));

  async function open(page: Page, context: BrowserContext, state: MockState) {
    await mockApi(context, state);
    // Full page loads only (in-app route changes are not reloads).
    const loads: string[] = [];
    page.on('load', () => loads.push(page.url()));
    await page.goto('/supplier-payments/new');
    await expect(page.getByRole('heading', { name: 'Record supplier payment' })).toBeVisible();
    return loads;
  }
  const currentBuild = async (page: Page) => (await (await page.request.get('/version.json')).json()).buildId as string;
  const foreground = (page: Page) =>
    page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));

  test('a new frontend build: notice, one refresh, no loop', async ({ page, context }) => {
    const state: MockState = { serverVersion: { version: '1', clientCompat: 1 }, publishedBuild: null };
    const loads = await open(page, context, state);
    await expect(page.getByTestId('app-update-notice')).toHaveCount(0);

    state.publishedBuild = `${await currentBuild(page)}-next`; // deployment of a new frontend
    const reloaded = page.waitForEvent('load');
    await foreground(page);
    await expect(page.getByTestId('app-update-notice')).toContainText('Shop-Books has been updated. Refreshing to the latest version');
    await reloaded;
    // The preview still serves the old files, so the reloaded page is not on the new build: it must
    // ask instead of reloading again.
    await expect(page.getByTestId('app-update-notice')).toContainText('Tap Refresh', { timeout: 10_000 });
    await page.waitForTimeout(2500);
    expect(loads).toHaveLength(2);
  });

  test('backend: a new release label never reloads; a compatibility raise refreshes once', async ({ page, context }) => {
    const state: MockState = { serverVersion: { version: '1', clientCompat: 1 }, publishedBuild: null };
    const loads = await open(page, context, state);

    state.serverVersion = { version: '2', clientCompat: 1 }; // restart / ordinary backend release
    await foreground(page);
    await page.waitForTimeout(2500);
    await expect(page.getByTestId('app-update-notice')).toHaveCount(0);
    expect(loads).toHaveLength(1);

    state.serverVersion = { version: '3', clientCompat: 2 }; // API needs a newer web app
    const reloaded = page.waitForEvent('load');
    await foreground(page);
    await reloaded;
    await expect(page.getByTestId('app-update-notice')).toContainText('Tap Refresh', { timeout: 10_000 });
    await page.waitForTimeout(2500);
    expect(loads).toHaveLength(2);
  });

  test('unsaved input defers the refresh until the user leaves the form', async ({ page, context }) => {
    const state: MockState = { serverVersion: { version: '1', clientCompat: 1 }, publishedBuild: null };
    const loads = await open(page, context, state);
    await page.getByLabel('Amount paid').fill('250');
    await page.getByLabel('Amount paid').blur();

    state.publishedBuild = `${await currentBuild(page)}-next`;
    await foreground(page);
    await expect(page.getByTestId('app-update-notice')).toContainText('It will refresh after you save or leave this screen');
    await page.waitForTimeout(4000); // longer than the safety re-check: still no reload
    expect(loads).toHaveLength(1);
    await expect(page.getByLabel('Amount paid')).toHaveValue('250');

    const reloaded = page.waitForEvent('load');
    await page.getByRole('link', { name: 'Supplier payments' }).first().click(); // leaves the form
    await reloaded;
    expect(loads.length).toBeGreaterThanOrEqual(2);
  });
});
