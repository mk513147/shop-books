import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/** Add Expense layout in a real browser (production build, real CSS): phone and desktop. API mocked. */

const USER = { id: 'u1', email: 'manager@example.com', name: 'Manager', role: 'manager', mustChangePassword: false };
const CATEGORIES = ['Purchase', 'Transport', 'Repair'].map((name, i) => ({
  id: `10000000-0000-4000-8000-00000000000${i + 1}`,
  name,
  isActive: true,
  expenseCount: 0,
  createdAt: '',
  updatedAt: '',
}));

async function mockApi(context: BrowserContext) {
  await context.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/auth/me') return json({ user: USER, csrfToken: 'csrf' });
    if (path === '/version') return json({ version: '1', clientCompat: 1 });
    if (path === '/sync/changes') return json({ cursor: '1', events: [], truncated: false });
    if (path === '/categories') return json({ categories: CATEGORIES });
    if (path === '/brands') return json({ brands: [] });
    if (path === '/suppliers') return json({ items: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } });
    return json({ error: { code: 'NOT_FOUND', message: 'Not mocked' } }, 404);
  });
}

async function openForm(page: Page, context: BrowserContext) {
  await mockApi(context);
  await page.goto('/expenses/new');
  await expect(page.getByLabel('Total expense amount')).toBeVisible();
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe('Add expense on a narrow Android phone', () => {
  test.beforeEach(({ isMobile }) => test.skip(!isMobile, 'phone layout only'));
  test.use({ viewport: { width: 360, height: 740 } });

  test('single column, no sideways scrolling, large controls, Save always reachable above the bottom bar', async ({ page, context }, info) => {
    await openForm(page, context);
    expect(await noHorizontalScroll(page)).toBe(true);

    // Amount first, focused, numeric keyboard.
    const amount = page.getByLabel('Total expense amount');
    await expect(amount).toBeFocused();
    await expect(amount).toHaveAttribute('inputmode', 'decimal');
    expect((await amount.boundingBox())!.height).toBeGreaterThanOrEqual(60);

    // One column: the groups stack, and the summary with Save follows the form.
    const form = (await page.getByLabel('Total expense amount').boundingBox())!;
    const panel = (await page.getByTestId('expense-actions').boundingBox())!;
    expect(panel.y).toBeGreaterThan(form.y);
    expect(Math.abs(panel.width - (await page.getByTestId('expense-actions').evaluate((el) => el.parentElement!.getBoundingClientRect().width)))).toBeLessThan(2);

    // Every text control is at least 44px tall (touch target).
    for (const label of ['Description (optional)', 'Amount paid', 'Payment method', 'Expense date', 'Bill number (optional)']) {
      expect((await page.getByLabel(label).boundingBox())!.height, label).toBeGreaterThanOrEqual(44);
    }

    // Save is at the end of the form, never floating: scrolled to, it is fully above the bottom navigation.
    const save = page.getByRole('button', { name: 'Save expense' });
    await save.scrollIntoViewIfNeeded();
    const nav = (await page.locator('nav.fixed').first().boundingBox())!;
    const saveBox = (await save.boundingBox())!;
    expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(nav.y + 1);
    expect(saveBox.height).toBeGreaterThanOrEqual(48);
    expect(await page.getByTestId('expense-actions').evaluate((el) => getComputedStyle(el).position)).toBe('static');
    await amount.scrollIntoViewIfNeeded();

    await amount.fill('2500');
    await expect(page.getByTestId('payment-badge')).toHaveText(/Fully paid/);
    await page.getByRole('radio', { name: 'Part paid' }).click();
    await page.getByLabel('Amount paid').fill('1500');
    await expect(page.getByTestId('payment-remaining')).toHaveText('₹1,000.00');
    await expect(page.getByTestId('payment-badge')).toHaveText(/Payment pending/);
    expect(await noHorizontalScroll(page)).toBe(true);

    await page.screenshot({ path: info.outputPath('add-expense-phone.png'), fullPage: true });
  });

  test('category and supplier search still work on the redesigned form', async ({ page, context }) => {
    await openForm(page, context);
    const search = page.getByLabel('Search or add category');
    await search.fill('Tra');
    await page.getByTestId('expense-categories').getByRole('button', { name: 'Transport' }).click();
    await expect(page.getByTestId('expense-categories')).toContainText('Transport');
    await page.getByRole('button', { name: 'Supplier (optional)' }).click();
    await expect(page.getByRole('dialog', { name: 'Choose supplier' })).toBeVisible();
  });
});

test.describe('Add expense on desktop', () => {
  test.beforeEach(({ isMobile }) => test.skip(isMobile, 'desktop layout only'));

  test('form on the left, summary with Save on the right that stays in view while scrolling', async ({ page, context }, info) => {
    await openForm(page, context);
    expect(await noHorizontalScroll(page)).toBe(true);

    const date = (await page.getByLabel('Expense date').boundingBox())!;
    const bill = (await page.getByLabel('Bill number (optional)').boundingBox())!;
    expect(Math.abs(date.y - bill.y)).toBeLessThan(2); // same row
    const amount = (await page.getByLabel('Total expense amount').boundingBox())!;
    const panel = (await page.getByTestId('expense-actions').boundingBox())!;
    expect(panel.x).toBeGreaterThan(amount.x + amount.width);
    expect(Math.abs(panel.y - amount.y)).toBeLessThan(120); // beside the top of the form

    await page.getByLabel('Total expense amount').fill('2500');
    await expect(page.getByTestId('payment-badge')).toHaveText(/Fully paid/);
    await page.screenshot({ path: info.outputPath('add-expense-desktop.png'), fullPage: true });

    // Scrolled down to the last fields, Save is still on screen.
    await page.getByLabel('Bill number (optional)').scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 2000);
    await expect(page.getByRole('button', { name: 'Save expense' })).toBeInViewport();
    await page.screenshot({ path: info.outputPath('add-expense-desktop-scrolled.png') });
  });
});
