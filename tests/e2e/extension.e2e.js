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
  const { panel, close } = await launch();
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

    await t.test('quick export with nothing selected is refused', async () => {
      await renderOrderList(panel, progress);
      let dialogMessage = null;
      panel.once('dialog', async (dialog) => {
        dialogMessage = dialog.message();
        await dialog.dismiss();
      });
      await panel.click('#quickExportButton');
      await panel.waitForTimeout(300);
      assert.match(String(dialogMessage), /select at least one order/i);
    });

    await t.test('quick export refuses when no selected order has been downloaded', async () => {
      await panel.check(`input[value="${ONLINE_ORDER}"]`);
      await panel.check(`input[value="${INSTORE_ORDER}"]`);
      // Export a single combined file (same option Download honors).
      await panel.evaluate(() => { window.Sidepanel.state.app.exportMode = 'single'; });

      let downloadFired = false;
      panel.once('download', () => { downloadFired = true; });
      await panel.click('#quickExportButton');
      await panel.waitForTimeout(1200);

      assert.equal(downloadFired, false, 'nothing may be exported — no fabricated data, ever');
      const message = await panel.textContent('#downloadProgress');
      assert.match(message, /None of the selected orders have been downloaded/i, 'the refusal must explain why');
    });

    await t.test('deep download stores the invoice and exports per-item prices', async () => {
      await panel.evaluate(() => { window.Sidepanel.state.app.exportMode = 'single'; });
      // Only the online order has a detail fixture.
      await panel.uncheck(`input[value="${INSTORE_ORDER}"]`);

      const [download] = await clickAndCollectDownloads(panel, '#downloadButton', 1, 45000);
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

    await t.test('quick export instantly re-exports the downloaded order with full fidelity', async () => {
      const [download] = await clickAndCollectDownloads(panel, '#quickExportButton', 1);
      assert.equal(download.name, 'Walmart_Orders_Quick.xlsx');

      const items = await readSheet(download.path, 'Items');
      assert.ok(items.headers.includes('Product Name') && items.headers.includes('Price'),
        'same layout as Download Selected');
      const milk = items.rows.find((r) => r['Product Name'] === 'Great Value Milk 1 Gallon');
      assert.ok(milk);
      assert.equal(milk['Price'], 7.96, 'stored invoice supplies the real price');

      const orders = await readSheet(download.path, 'Orders');
      const order = orders.rows.find((r) => String(r['Order Number']) === ONLINE_ORDER);
      assert.equal(order['Tax'], 1.14, 'full invoice fidelity');
      assert.equal(order['Data'], 'Full invoice');

      const message = await panel.textContent('#downloadProgress');
      assert.match(message, /success/i);
    });

    await t.test('quick export skips (and reports) selected orders that were never downloaded', async () => {
      await panel.check(`input[value="${INSTORE_ORDER}"]`);

      const [download] = await clickAndCollectDownloads(panel, '#quickExportButton', 1);
      assert.equal(download.name, 'Walmart_Orders_Quick.xlsx');

      const orders = await readSheet(download.path, 'Orders');
      assert.equal(orders.rows.length, 1, 'only the downloaded order exports');
      assert.equal(String(orders.rows[0]['Order Number']), ONLINE_ORDER);

      const message = await panel.textContent('#downloadProgress');
      assert.match(message, /Skipped 1/i, 'the skipped count must be reported');
      await panel.uncheck(`input[value="${INSTORE_ORDER}"]`);
    });

    await t.test('dashboard renders stats from the collected data', async () => {
      await panel.evaluate(() => {
        window.Sidepanel.view.switchView('dashboard');
        return window.Sidepanel.dashboard.renderDashboard();
      });
      const content = await panel.textContent('#dashboardContent');
      assert.match(content, /order/i);
      assert.ok(!content.includes('Collect orders to see analytics'), 'must not show the empty state');
    });
  } finally {
    await close();
  }
});
