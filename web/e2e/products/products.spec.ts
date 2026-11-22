import { expect, test, type Page } from '@playwright/test';

/**
 * Product catalogue end to end: real browser, real production build, REAL API, local TEST
 * database (seeded by e2e/products/api-server.mjs). Users: owner@e2e.test, costs@e2e.test
 * (manager allowed to see AND change purchase prices), staff@e2e.test (manager without either).
 * Excel import is postponed: the suite checks it is not offered and that the API refuses it.
 */

const PASSWORD = 'e2e-password-123';
const RUN = Date.now().toString(36);

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

async function search(page: Page, text: string) {
  await page.getByRole('searchbox', { name: 'Search products' }).fill(text);
  await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(text).replace(/%20/g, '(\\+|%20)')}`));
}

test.describe('desktop', () => {
  test.beforeEach(({ isMobile }) => test.skip(isMobile, 'desktop flows'));

  test('create, edit, search, deactivate and reactivate a product', async ({ page }) => {
    await signIn(page, 'staff@e2e.test');
    await page.goto('/products/new');
    const name = `Spiral Notebook ${RUN}`;
    await page.getByLabel('Product name (without the brand)').fill(name);
    await page.getByLabel('Category').selectOption({ label: 'Notebook (Copy)' });
    await expect(page.getByLabel('Category').locator('option', { hasText: 'Rent' })).toHaveCount(0);
    await page.getByLabel('Size').fill('a4');
    await page.getByLabel('Pages').fill('172');
    await page.getByLabel('Selling price').fill('60');
    await page.getByLabel('MRP (optional)').fill('55');
    // Managers without permission never see a purchase price field.
    await expect(page.getByText(/purchase price/i)).toHaveCount(0);
    await page.getByRole('button', { name: 'Save product' }).click();
    // SP above MRP needs explicit confirmation.
    await expect(page.getByRole('heading', { name: 'Sell above the MRP?' })).toBeVisible();
    await page.getByRole('button', { name: 'Confirm and save' }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    await expect(page.getByText(/Selling above the MRP was confirmed by Ravi Staff/)).toBeVisible();

    // Edit.
    await page.getByRole('link', { name: 'Edit' }).click();
    await page.getByLabel('Selling price').fill('52');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('₹52.00').first()).toBeVisible();

    // Search: brand-less multi-token and structured.
    await page.goto('/products');
    await search(page, `a4 172 ${RUN}`);
    await expect(page.getByRole('table').getByRole('link', { name })).toBeVisible();

    // Deactivate, then reactivate.
    await page.getByRole('table').getByRole('link', { name }).click();
    await page.getByRole('button', { name: 'Deactivate' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Deactivate' }).click();
    await expect(page.getByText('Deactivated').first()).toBeVisible();
    await page.getByRole('button', { name: 'Reactivate' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Reactivate' }).click();
    await expect(page.getByRole('button', { name: 'Deactivate' })).toBeVisible();
  });

  test('link several suppliers, change the preferred one, reveal prices as an authorised manager', async ({ page }) => {
    await signIn(page, 'costs@e2e.test');
    await page.goto('/products');
    await search(page, 'classmate register');
    await page.getByRole('table').getByRole('link', { name: /Register/ }).first().click();

    // Two suppliers: the brand's supplier is suggested.
    await page.getByRole('button', { name: 'Link supplier' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Sharma Traders' }).click();
    await page.getByLabel('This supplier’s purchase price (optional)').fill('39.50');
    await page.getByLabel(/Preferred supplier/).check();
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Preferred')).toBeVisible();

    await page.getByRole('button', { name: 'Link supplier' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Supplier', exact: true }).click();
    await page.getByRole('combobox', { name: 'Search suppliers' }).fill('National');
    await page.getByRole('option', { name: /National Distributors/ }).click();
    // The picker's sheet closes with a short animation; until then the form beneath is inert.
    await expect(page.getByRole('combobox', { name: 'Search suppliers' })).toBeHidden();
    const price = page.getByLabel('This supplier’s purchase price (optional)');
    await price.fill('38.00');
    await expect(price).toHaveValue('38.00');
    const linked = page.waitForRequest((r) => r.method() === 'POST' && /\/products\/[^/]+\/suppliers$/.test(r.url()));
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    expect((await linked).postDataJSON()).toMatchObject({ purchasePrice: '38.00' });
    await expect(page.getByText('National Distributors')).toBeVisible();

    // Prices are masked until revealed.
    const card = page.getByTestId('cost-card');
    await expect(card.getByTestId('cost-hidden')).toBeVisible();
    await card.getByRole('button', { name: 'Show' }).click();
    await expect(card.getByText('₹39.50')).toBeVisible();
    await expect(card.getByText(/preferred supplier \(Sharma Traders\)/)).toBeVisible();

    // Change the preferred supplier: only the flag moves, prices stay.
    await page.getByRole('button', { name: 'Make preferred' }).click();
    await expect(card.getByText('₹38.00')).toBeVisible();
    await expect(page.getByText('₹39.50')).toBeVisible();

    // Hide again.
    await card.getByRole('button', { name: 'Hide' }).click();
    await expect(page.getByText('₹38.00')).toHaveCount(0);

    // Catalogue: reveal the current page only, hidden again on another search.
    await page.goto('/products');
    await page.getByRole('button', { name: 'Show purchase prices for this page' }).click();
    await expect(page.getByRole('table').getByTestId('cost-visible').first()).toBeVisible();
    await search(page, 'classmate');
    await expect(page.getByTestId('cost-visible')).toHaveCount(0);
  });

  test('a manager without permission cannot reach purchase prices', async ({ page }) => {
    await signIn(page, 'staff@e2e.test');
    await page.goto('/products');
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('button', { name: /purchase prices/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Import' })).toHaveCount(0);
    const api = await page.request.get('/api/v1/products?q=register');
    const id = (await api.json()).items[0].id as string;
    expect((await page.request.get(`/api/v1/products/${id}/costs`)).status()).toBe(403);
    expect((await page.request.get(`/api/v1/products/purchase-prices?ids=${id}`)).status()).toBe(403);
    expect(await (await page.request.get(`/api/v1/products/${id}`)).text()).not.toContain('41.25');
    await page.goto(`/products/${id}`);
    await expect(page.getByTestId('cost-card')).toHaveCount(0);
  });

  test('Excel import is postponed: not offered anywhere, and the API refuses it', async ({ page }) => {
    await signIn(page, 'owner@e2e.test');
    await page.goto('/products');
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add product' })).toBeVisible();
    await expect(page.getByRole('button', { name: /import/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /import/i })).toHaveCount(0);
    const csrf = await page.evaluate(async () => (await (await fetch('/api/v1/auth/me')).json()).csrfToken as string);
    const upload = await page.request.post('/api/v1/product-imports/inspect', {
      headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf, Origin: 'http://localhost:4173', 'X-File-Name': 'products.xlsx' },
      data: Buffer.from('PK'),
    });
    expect(upload.status()).toBe(503);
    expect((await upload.json()).error.code).toBe('PRODUCT_IMPORT_UNAVAILABLE');
  });

  test('F4 during a half-filled expense: lookup, Esc, values kept; F2 opens Add expense', async ({ page }) => {
    await signIn(page, 'staff@e2e.test');
    await page.goto('/expenses/new');
    const amount = page.getByLabel('Total expense amount');
    await amount.fill('1250.50');
    await page.getByLabel('Description (optional)').fill('Notebooks for stock');
    await page.getByLabel('Description (optional)').focus();
    await page.keyboard.press('F4');
    const lookup = page.getByRole('combobox', { name: 'Search products' });
    await expect(lookup).toBeFocused();
    await lookup.fill('classmate register');
    await expect(page.getByRole('option', { name: /Classmate Register/ }).first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('lookup-selected')).toContainText('₹');
    await page.keyboard.press('Escape');
    await expect(lookup).toBeHidden();
    await expect(page.getByLabel('Description (optional)')).toBeFocused();
    await expect(amount).toHaveValue('1250.50');
    await expect(page.getByLabel('Description (optional)')).toHaveValue('Notebooks for stock');

    // F2 from another screen opens Add expense.
    await page.goto('/products');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('F2');
    await expect(page).toHaveURL(/\/expenses\/new$/);
    await expect(page.getByText('F4').first()).toBeVisible();
  });
});

test.describe('phone', () => {
  test.beforeEach(({ isMobile }) => test.skip(!isMobile, 'phone layout'));

  test('cards, no shortcut hints, no sideways scrolling; Products is under More', async ({ page }) => {
    await signIn(page, 'staff@e2e.test');
    await page.goto('/products');
    await expect(page.getByRole('link', { name: /Register/ }).first()).toBeVisible();
    await expect(page.getByRole('table')).toBeHidden();
    await expect(page.locator('kbd')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press('F4');
    await expect(page.getByRole('combobox', { name: 'Search products' })).toHaveCount(0);
    await page.getByRole('button', { name: 'More' }).click();
    await expect(page.getByRole('dialog').getByRole('link', { name: /Products/ })).toBeVisible();
  });
});
