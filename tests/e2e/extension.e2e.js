/**
 * End-to-end: real extension in Chromium, mocked walmart.com, real downloads.
 * Run with: npm run test:e2e
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const {
  launch,
  collectOrders,
  renderOrderList,
  clickAndCollectDownloads,
  ONLINE_ORDER,
  INSTORE_ORDER,
} = require('./helpers/harness');

/** Read a worksheet into an array of row objects keyed by header. */
async function readSheet(filePath, sheetName) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  assert.ok(sheet, `worksheet ${sheetName || '#1'} must exist`);
  const headers = sheet.getRow(1).values.slice(1).map((v) => String(v));
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = row.values.slice(1);
    const obj = {};
    headers.forEach((header, i) => {
      let value = values[i];
      if (value && typeof value === 'object' && 'text' in value) value = value.text;
      obj[header] = value === undefined || value === null ? '' : value;
    });
    rows.push(obj);
  });
  return { headers, rows };
}

test('extension end-to-end', async (t) => {
  const { panel, context, close } = await launch();
  let progress;

  try {
    await t.test('collection gathers payload-quality summaries via the real background worker', async () => {
      progress = await collectOrders(panel);

      assert.deepEqual([...progress.orderNumbers].sort(), [ONLINE_ORDER, INSTORE_ORDER].sort());
      const summary = progress.orderSummaries[ONLINE_ORDER];
      assert.equal(summary.source, 'payload', 'summary must come from the payload path');
      assert.equal(summary.orderTotal, '$28.11');
      assert.equal(summary.items.length, 2);
      assert.equal(progress.orderSummaries[INSTORE_ORDER].fulfillmentTypes, 'IN_STORE');
    });

    // Quick Export is gone (design spec §5.2): the two-button model replaces
    // it. "0 selected" is now a disabled-button state with an inline reason
    // instead of a blocking dialog (spec §5.2 button states).
    await t.test('with nothing selected, both download buttons are disabled with the inline reason shown', async () => {
      await renderOrderList(panel, progress);

      assert.notEqual(
        await panel.getAttribute('#singleFileDownload', 'disabled'), null,
        'Single file must start disabled with nothing selected'
      );
      assert.notEqual(
        await panel.getAttribute('#multiFileDownload', 'disabled'), null,
        'Multiple files must start disabled with nothing selected'
      );
      assert.equal(
        await panel.getAttribute('#downloadDisabledReason', 'hidden'), null,
        'the "select at least one order" reason must be visible'
      );

      // Labels always echo the current format (spec §5.2).
      const singleLabel = await panel.textContent('#singleFileDownload .btn-text');
      const multiLabel = await panel.textContent('#multiFileDownload .btn-text');
      assert.match(singleLabel, /Single file \(\.xlsx\)/);
      assert.match(multiLabel, /Multiple files \(\.xlsx\)/);
    });

    await t.test('selecting an order enables both buttons and hides the inline reason', async () => {
      await panel.check(`input[value="${ONLINE_ORDER}"]`);
      await panel.check(`input[value="${INSTORE_ORDER}"]`);

      assert.equal(await panel.getAttribute('#singleFileDownload', 'disabled'), null);
      assert.equal(await panel.getAttribute('#multiFileDownload', 'disabled'), null);
      assert.notEqual(
        await panel.getAttribute('#downloadDisabledReason', 'hidden'), null,
        'the reason hides once something is selected'
      );
    });

    await t.test('Single file download stores the invoice and exports per-item prices', async () => {
      // Only the online order has a detail fixture.
      await panel.uncheck(`input[value="${INSTORE_ORDER}"]`);

      // Mode is implied by which button is clicked — nothing sets
      // app.exportMode directly (spec §5.2: clicking a button sets the mode).
      const [download] = await clickAndCollectDownloads(panel, '#singleFileDownload', 1, 45000);
      assert.equal(download.name, 'Walmart_Orders.xlsx');

      const items = await readSheet(download.path, 'Items');
      const milk = items.rows.find((r) => r['Product Name'] === 'Great Value Milk 1 Gallon');
      assert.ok(milk, 'deep export must contain the item');
      assert.equal(milk['Price'], 7.96);

      const orders = await readSheet(download.path, 'Orders');
      const order = orders.rows.find((r) => String(r['Order Number']) === ONLINE_ORDER);
      assert.equal(order['Tax'], 1.14);
      assert.equal(order['Seller(s)'], 'Walmart.com; Acme Marketplace LLC');

      const stored = await panel.evaluate((orderNumber) => OrderDb.getOrder(orderNumber), ONLINE_ORDER);
      assert.ok(stored && stored.invoice, 'invoice must be persisted to the order DB');
      assert.equal(stored.invoice.items.length, 3);
    });

    // This is what used to be Quick Export's one real differentiator (spec
    // §4.2/§C4) — now built into Download itself: re-selecting an
    // already-saved order and clicking Single file again must skip the tab
    // entirely and serve the stored invoice straight from IndexedDB.
    await t.test('re-downloading an already-saved order (Single file) opens no tab — the IndexedDB fast path', async () => {
      let tabOpened = false;
      const onPage = () => {
        tabOpened = true;
      };
      context.on('page', onPage);

      try {
        const [download] = await clickAndCollectDownloads(panel, '#singleFileDownload', 1);
        assert.equal(download.name, 'Walmart_Orders.xlsx');
        assert.equal(tabOpened, false, 'an already-downloaded order must open no tab');

        const items = await readSheet(download.path, 'Items');
        const milk = items.rows.find((r) => r['Product Name'] === 'Great Value Milk 1 Gallon');
        assert.ok(milk);
        assert.equal(milk['Price'], 7.96, 'stored invoice supplies the real price, not a re-fetch');

        const orders = await readSheet(download.path, 'Orders');
        const order = orders.rows.find((r) => String(r['Order Number']) === ONLINE_ORDER);
        assert.equal(order['Data'], 'Full invoice');
      } finally {
        context.off('page', onPage);
      }
    });

    await t.test('dashboard renders the scoped model from the collected data', async () => {
      await panel.evaluate(() => {
        window.Sidepanel.view.switchView('dashboard');
        return window.Sidepanel.dashboard.renderDashboard();
      });

      // Scope picker + headline card render for the measured invoice.
      assert.ok(await panel.$('#dashScopeSelect'), 'scope picker must render');
      const total = await panel.textContent('.dash-headline-total');
      assert.match(total, /\$\d/, 'headline must show a measured total');

      // Switching the scope re-renders the headline label.
      await panel.selectOption('#dashScopeSelect', 'all');
      await panel.waitForFunction(() =>
        document.querySelector('.dash-headline-label')?.textContent.includes('All time')
      );

      // Tappable month bars exist for the measured months.
      assert.ok((await panel.$$('.dash-bars .dash-bar')).length > 0, 'month bars must render');
      assert.ok(await panel.$('#dashViewExportMonth'), 'selected month must offer View & export');

      // The ledger and its scoped export button.
      const ledger = await panel.textContent('.dash-ledger');
      assert.match(ledger, /Tax/, 'ledger must break down where the money went');
      assert.ok(await panel.$('#dashExportScope'));
    });

    await t.test('dashboard coverage banner selects exactly the unmeasured orders in the main list', async () => {
      // Only the online order was downloaded — the in-store order is
      // stored but unmeasured, so the coverage banner must be actionable.
      const warn = await panel.textContent('.dash-coverage-warn');
      assert.match(warn, /1 of 2 orders/, 'coverage must count the unmeasured order');

      await panel.click('#dashSelectMissing');

      // Lands on the main view with EXACTLY the missing order selected.
      await panel.waitForSelector('#mainView.active');
      assert.equal(
        await panel.isChecked(`input[value="${INSTORE_ORDER}"]`), true,
        'the unmeasured order must be selected'
      );
      assert.equal(
        await panel.isChecked(`input[value="${ONLINE_ORDER}"]`), false,
        'the already-measured order must NOT be selected'
      );
      // The selection count reflects exactly one selected order. (Button
      // enablement is tab-dependent — checkCurrentTab disables the UI when
      // the active tab isn't a Walmart orders page, which in this harness
      // is always the case — so the count line is the honest signal here.)
      const countLine = await panel.textContent('#listCountLine');
      assert.match(countLine, /1 selected/);
    });
  } finally {
    await close();
  }
});
