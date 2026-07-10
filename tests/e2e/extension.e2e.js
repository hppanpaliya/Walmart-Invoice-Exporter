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

    let quickHeaders;
    await t.test('quick export (no invoices) matches the Download format, prices blank, warning shown', async () => {
      await panel.check(`input[value="${ONLINE_ORDER}"]`);
      await panel.check(`input[value="${INSTORE_ORDER}"]`);
      // Export a single combined file (same option Download honors).
      await panel.evaluate(() => { window.Sidepanel.state.app.exportMode = 'single'; });

      const [download] = await clickAndCollectDownloads(panel, '#quickExportButton', 1);
      assert.equal(download.name, 'Walmart_Orders_Quick.xlsx');

      const items = await readSheet(download.path, 'Items');
      quickHeaders = items.headers;
      assert.ok(items.headers.includes('Order Number') && items.headers.includes('Product Name') && items.headers.includes('Order Type'),
        'deep-export item columns expected');

      const onlineRows = items.rows.filter((r) => String(r['Order Number']) === ONLINE_ORDER);
      assert.equal(onlineRows.length, 2, 'one row per item');
      assert.equal(onlineRows[0]['Product Name'], 'Great Value Milk 1 Gallon');
      assert.equal(onlineRows[0]['Qty'], 2);
      assert.equal(onlineRows[0]['Price'], '', 'unknown price must be BLANK, never $0.00');

      const orders = await readSheet(download.path, 'Orders');
      const onlineOrder = orders.rows.find((r) => String(r['Order Number']) === ONLINE_ORDER);
      assert.equal(onlineOrder['Order Total'], 28.11);
      assert.equal(onlineOrder['Tax'], '', 'tax unknown without an invoice — blank');

      const inStoreRows = items.rows.filter((r) => String(r['Order Number']) === INSTORE_ORDER);
      assert.equal(inStoreRows.length, 1);

      const warning = await panel.textContent('#downloadProgress');
      assert.match(warning, /no downloaded invoice/i, 'missing-price warning must be shown');
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

    await t.test('quick export after a deep download joins the stored prices', async () => {
      const [download] = await clickAndCollectDownloads(panel, '#quickExportButton', 1);
      assert.equal(download.name, 'Walmart_Orders_Quick.xlsx');

      const items = await readSheet(download.path, 'Items');
      assert.deepEqual(items.headers, quickHeaders, 'format identical run to run');
      const milk = items.rows.find((r) => r['Product Name'] === 'Great Value Milk 1 Gallon');
      assert.ok(milk);
      assert.equal(milk['Price'], 7.96, 'stored invoice now supplies the real price');

      const orders = await readSheet(download.path, 'Orders');
      const order = orders.rows.find((r) => String(r['Order Number']) === ONLINE_ORDER);
      assert.equal(order['Tax'], 1.14, 'full invoice fidelity, not summary fidelity');

      const message = await panel.textContent('#downloadProgress');
      assert.match(message, /success/i, 'no missing-price warning once the invoice exists');
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
