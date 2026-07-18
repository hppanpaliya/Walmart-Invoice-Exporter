/**
 * E2E: the full-page dashboard (dashboard.html) against a seeded OrderDb —
 * scoping, month rescope + back, search, actionable coverage, and the
 * postMessage bridge that drives the embedded side panel (export produces a
 * real download without any walmart.com tab).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { launch, seedOrderHistory } = require('./helpers/harness');

test('full-page dashboard', async (t) => {
  const { context, extensionId, panel, close } = await launch();
  t.after(close);

  const records = await seedOrderHistory(panel);
  const summaryOnly = records.filter((r) => r.summaryOnly).map((r) => r.orderNumber);
  assert.ok(summaryOnly.length > 0, 'seed must include summary-only orders');

  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 940 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(`chrome-extension://${extensionId}/dashboard.html`);
  await page.waitForSelector('.cbar', { timeout: 10000 });

  await t.test('renders measured stats from the DB', async () => {
    const total = await page.locator('#statTotal').textContent();
    assert.match(total, /^\$[\d,]+\.\d{2}$/, `headline total renders money, got "${total}"`);
    assert.notStrictEqual(total, '$0.00');
    const orders = Number(await page.locator('#statOrders').textContent());
    assert.ok(orders > 0, 'measured order count > 0');
  });

  await t.test('embedded panel boots with the stored orders, no off-tab gate', async () => {
    const frame = page.frames().find((f) => f.url().endsWith('sidepanel.html'));
    assert.ok(frame, 'sidepanel.html iframe present');
    await frame.waitForSelector('.order-list .order-row', { timeout: 10000 });
    const state = await frame.evaluate(() => ({
      firstRun: document.body.classList.contains('first-run'),
      offTab: Boolean(document.getElementById('offTabWarning')),
      rows: document.querySelectorAll('.order-list .order-row').length,
    }));
    assert.strictEqual(state.firstRun, false, 'not stuck in first-run macro state');
    assert.strictEqual(state.offTab, false, 'no off-tab warning inside the embed');
    assert.strictEqual(state.rows, records.length, 'embed lists every stored order');
  });

  await t.test('month click rescopes the whole page and back returns', async () => {
    // last6 always spans multiple seeded months regardless of today's date
    // ("This year" would hold a single bar every January).
    await page.locator('#scopeSelect').selectOption('last6');
    await page.waitForTimeout(300);
    const scopedBefore = await page.locator('#statTotal').textContent();
    const bars = page.locator('.cbar');
    assert.ok((await bars.count()) >= 2, 'chart has bars');
    await bars.nth(0).click();
    await page.waitForTimeout(200);
    assert.ok(await page.locator('#backChip').isVisible(), 'back chip appears');
    const monthTotal = await page.locator('#statTotal').textContent();
    assert.notStrictEqual(monthTotal, scopedBefore, 'headline rescopes to the month');
    assert.match(await page.locator('#scopeTitle').textContent(), /·/, 'title names the month scope');
    await page.locator('#backChip').click();
    await page.waitForTimeout(200);
    assert.strictEqual(await page.locator('#statTotal').textContent(), scopedBefore, 'back restores the range numbers');
    assert.ok(!(await page.locator('#backChip').isVisible()), 'back chip hides again');
  });

  await t.test('search filters the orders table live', async () => {
    // "all" guarantees at least one seeded order without Tide in it.
    await page.locator('#scopeSelect').selectOption('all');
    await page.waitForTimeout(300);
    const countAll = await page.locator('tbody tr').count();
    await page.locator('#searchInput').fill('tide');
    await page.waitForTimeout(200);
    const countTide = await page.locator('tbody tr').count();
    assert.ok(countTide > 0 && countTide < countAll, `search narrows rows (${countAll} -> ${countTide})`);
    await page.locator('#searchInput').fill('zzz-no-such-item');
    await page.waitForTimeout(200);
    assert.ok((await page.locator('tbody tr').count()) <= 1, 'no-match state');
    await page.locator('#searchInput').fill('');
    await page.waitForTimeout(200);
  });

  await t.test('coverage banner selects exactly the unmeasured orders', async () => {
    await page.locator('#scopeSelect').selectOption('all');
    await page.waitForTimeout(300);
    const button = page.locator('.coverage button');
    assert.ok(await button.count(), 'coverage action rendered');
    await button.click();
    await page.waitForTimeout(300);
    const checked = await page.evaluate(() =>
      Array.from(document.querySelectorAll('tbody input[type="checkbox"]:checked'))
        .map((box) => box.closest('tr').querySelector('.onum').textContent.trim())
    );
    assert.strictEqual(checked.length, summaryOnly.length, 'selects every summary-only order');
    for (const label of checked) {
      const match = summaryOnly.some((num) => label.endsWith(num.slice(-8)));
      assert.ok(match, `selected row ${label} is a summary-only order`);
    }
  });

  await t.test('bridge export downloads a real file through the embedded panel', async () => {
    // Clear the coverage selection with real clicks — the page mirrors
    // checkbox state into a Set on change events, so silent .checked
    // writes would desync it.
    while (await page.locator('tbody input[type="checkbox"]:checked').count()) {
      await page.locator('tbody input[type="checkbox"]:checked').first().click();
    }
    // Rows sort date-desc; the newest seeded orders are measured, so this
    // exercises the no-tab IndexedDB fast path inside the embedded panel.
    const measuredBoxes = page.locator('tbody input[type="checkbox"]');
    await measuredBoxes.nth(0).click();
    await measuredBoxes.nth(1).click();
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
    await page.locator('#exportSingleBtn').click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /\.xlsx$/, 'xlsx download produced');
  });

  assert.deepStrictEqual(pageErrors, [], 'no uncaught page errors');
});
