'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { launch, collectOrders, renderOrderList, clickAndCollectDownloads, ONLINE_ORDER } = require('./helpers/harness');

// Reduced, anonymized DOM saved from the user's rendered Chrome page. All
// walmart.com requests are served locally; no real account/cookies are used.
test('packaged extension exports the captured live redesigned invoice through its real UI', async () => {
  const detailHtml = fs.readFileSync(path.join(__dirname, '../fixtures/live-redesigned-order.html'), 'utf8');
  const { panel, close } = await launch({ mockOptions: { detailHtml } });
  try {
    const progress = await collectOrders(panel);
    await renderOrderList(panel, progress);
    await panel.check(`input[value="${ONLINE_ORDER}"]`);
    const [download] = await clickAndCollectDownloads(panel, '#singleFileDownload', 1, 45000);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(download.path);
    const orders = workbook.getWorksheet('Orders');
    const headers = orders.getRow(1).values;
    const cell = header => orders.getRow(2).getCell(headers.indexOf(header)).value;
    assert.equal(cell('Order Number'), ONLINE_ORDER);
    assert.equal(cell('Subtotal'), 47.44);
    assert.equal(cell('Order Total'), 53.48);
    assert.equal(workbook.getWorksheet('Items').rowCount - 1, 20);
    const stored = await panel.evaluate(orderNumber => OrderDb.getOrder(orderNumber), ONLINE_ORDER);
    assert.equal(stored.invoice.items.length, 20);
    assert.equal(stored.invoice.paymentSplit, 'Walmart Cash: $2.50; Visa Ending in 0000: $50.98');
    assert.deepEqual(stored.invoice.extractionWarnings, []);
    await panel.waitForFunction(() => !window.Sidepanel.state.app.downloadInProgress);
    assert.match(await panel.textContent('#downloadResultBanner'), /Exported 1 order/);

    // Re-export through Multiple files. This exercises the cached-invoice path
    // and the other writer against the exact same captured invoice data.
    const [singleOrderDownload] = await clickAndCollectDownloads(panel, '#multiFileDownload', 1, 45000);
    const invoice = new ExcelJS.Workbook();
    await invoice.xlsx.readFile(singleOrderDownload.path);
    const sheet = invoice.worksheets[0];
    const rows = [];
    sheet.eachRow(row => rows.push(row.values.slice(1)));
    assert.ok(rows.some(row => row.includes('Order Total') && row.includes(53.48)));
    assert.equal((await panel.evaluate(orderNumber => OrderDb.getOrder(orderNumber), ONLINE_ORDER)).invoice.items.length, 20);
  } finally { await close(); }
});
