'use strict';
// Replay a locally saved Chrome invoice. No cookies/profile or network access.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { anonymizeInvoice, MAX_CAPTURE_BYTES } = require('./lib/anonymize-invoice.cjs');
const ExcelJS = require('exceljs');
const { loadSandbox } = require('../tests/helpers/sandbox');
const { captureDownloads, blobBuffer } = require('../tests/helpers/capture-downloads');
const root = path.join(__dirname, '..');
const capturePath = process.argv[2];
if (!capturePath) throw new Error('Usage: node scripts/verify-invoice-capture.cjs /path/to/saved-invoice.html [baseline-ref]');
const baselineRef = process.argv[3] || 'faae6af27e38e46dc6ed189b0924aa7a3e9a875e';
const fakeId = '200010000000042';

(async () => {
  if (fs.statSync(capturePath).size > MAX_CAPTURE_BYTES) throw new Error('Capture exceeds 8 MiB');
  const fixture = await anonymizeInvoice(fs.readFileSync(capturePath, 'utf8'));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.request().isNavigationRequest()
      ? route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
      : route.abort());
    const fixturePath = path.join(root, 'output/playwright/verified-invoice.html');
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, fixture);
    const scrape = async source => {
      const page = await context.newPage();
      await page.goto(`https://www.walmart.com/orders/${fakeId}`);
      await page.setContent(fixture);
      for (const file of ['utils.js', 'providers/base.js', 'providers/registry.js']) await page.addScriptTag({ path: path.join(root, 'public', file) });
      await page.addScriptTag({ content: source });
      const data = await page.evaluate(() => window.ProviderRegistry.getById('WALMART_US').scrapeOrder({}));
      await page.close();
      return data;
    };
    const original = await scrape(execFileSync('git', ['show', `${baselineRef}:public/providers/walmart-us.js`], { cwd: root, encoding: 'utf8' }));
    const patched = await scrape(fs.readFileSync(path.join(root, 'public/providers/walmart-us.js'), 'utf8'));
    assert.equal(original.items.length, 0);
    assert.equal(original.orderTotal, '');
    assert.equal(patched.items.length, 20);
    const cents = v => Math.round(Number(String(v).replace(/[^0-9.-]/g, '')) * 100);
    assert.equal(patched.items.reduce((sum, item) => sum + cents(item.price), 0), 4744);
    assert.equal(patched.orderSubtotal, '$47.44');
    assert.equal(patched.orderTotal, '$53.48');
    assert.equal(['orderSubtotal', 'deliveryCharges', 'bagFee', 'tax', 'tip'].reduce((sum, key) => sum + cents(patched[key]), 0), 5348);
    assert.equal(patched.paymentSplit, 'Walmart Cash: $2.50; Visa Ending in 0000: $50.98');
    assert.deepEqual(patched.extractionWarnings, []);
    assert.equal(patched.address, '', 'no personal address enters the fixture');
    const sandbox = loadSandbox({ scripts: ['utils.js'] });
    const downloads = captureDownloads(sandbox);
    await sandbox.convertMultipleOrdersToXlsx([patched], ExcelJS, 'Verified_Invoice.xlsx');
    const outputPath = path.join(root, 'output/playwright/Verified_Invoice.xlsx');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, blobBuffer(downloads[0].blob));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    assert.equal(workbook.getWorksheet('Items').rowCount - 1, 20);
    const orders = workbook.getWorksheet('Orders');
    const headers = orders.getRow(1).values;
    assert.equal(orders.getRow(2).getCell(headers.indexOf('Order Total')).value, 53.48);
    console.log(JSON.stringify({ original: { items: original.items.length, orderTotal: original.orderTotal, warnings: original.extractionWarnings }, patched: { items: patched.items.length, itemSubtotal: 47.44, orderTotal: patched.orderTotal, paymentSplit: patched.paymentSplit, warnings: patched.extractionWarnings }, fixturePath, outputPath }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
