'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const { loadSandbox } = require('../helpers/sandbox');
const { captureDownloads, blobBuffer } = require('../helpers/capture-downloads');
const { anonymizeInvoice, MAX_CAPTURE_BYTES, FIXTURE_ORDER_ID } = require('../../scripts/lib/anonymize-invoice.cjs');
const corpusDir = path.join(__dirname, '../fixtures/captures');
const corpus = require('../fixtures/captures/manifest.json');

test('anonymizer removes private and executable content without executing source HTML', async () => {
  const source = `<script>throw new Error('executed-private-secret')</script>
    <iframe src="https://private-secret.example.test"></iframe><style>body{background:url(https://private-secret.example.test)}</style>
    <div class="print-bill-group private-secret" data-private="private-secret" onclick="alert(1)">
    <h2>Delivered on October 19 to private-secret</h2><div data-testid="itemtile-stack">
    <div class="print-item-title"><a link-identifier="itemClick" href="javascript:alert('private-secret')"><div data-testid="productName">private-secret</div></a><div>private-secret street</div></div>
    <div class="bill-item-quantity">Qty 2</div><div data-testid="line-price">$5.00</div><img src="https://private-secret.example.test" alt="private-secret"></div></div>
    <div class="bill-order-payment-info"><div class="flex items-center mb3"><img src=x onerror="alert(1)" alt="Visa"><span aria-labelledby="card-description-private-secret">Ending in 4111</span><span class="tr">$5.00</span></div><p>private-secret@example.test</p></div>`;
  const first = await anonymizeInvoice(source);
  assert.equal(first, await anonymizeInvoice(source), 'sanitization is deterministic');
  for (const needle of ['private-secret', '4111', 'onclick', 'onerror', '<script', '<iframe', '<style', 'javascript:', 'https://']) assert.ok(!first.includes(needle), `must remove ${needle}`);
  assert.match(first, /Captured product 1/);
  assert.match(first, /Ending in 0000/);
  assert.match(first, /\$5\.00/);
  await assert.rejects(anonymizeInvoice('<p>unsupported page</p>'), /no supported invoice/);
  await assert.rejects(anonymizeInvoice('x'.repeat(MAX_CAPTURE_BYTES + 1)), /8 MiB/);
});

test('anonymized invoice replay corpus runs the production provider offline', async (t) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => route.request().isNavigationRequest()
      ? route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }) : route.abort());
    for (const entry of corpus.cases) await t.test(entry.name, async () => {
      const page = await context.newPage();
      try {
        await page.goto(`https://www.walmart.com/orders/${FIXTURE_ORDER_ID}`);
        await page.setContent(fs.readFileSync(path.join(corpusDir, entry.file), 'utf8'));
        await page.evaluate(variant => {
          if (variant === 'missing-items') document.querySelectorAll('[data-testid="itemtile-stack"]').forEach(node => node.remove());
          if (variant === 'missing-total') for (const row of document.querySelectorAll('.bill-order-payment-spacing .justify-between')) {
            if (/^(?:order )?total$/i.test(row.firstElementChild?.textContent.trim())) row.remove();
          }
          if (variant === 'zero') {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) walker.currentNode.nodeValue = walker.currentNode.nodeValue.replace(/-?\$[\d,]+(?:\.\d{1,2})?/g, '$0.00');
          }
          if (variant === 'hostile') {
            document.querySelector('[data-testid="productName"]').textContent = '=HYPERLINK("javascript:alert(1)") <img src=x onerror=alert(1)>';
            document.querySelector('a[link-identifier="itemClick"]').setAttribute('href', 'javascript:alert(1)');
          }
        }, entry.variant);
        for (const script of ['utils.js', 'providers/base.js', 'providers/registry.js', 'providers/walmart-us.js']) {
          await page.addScriptTag({ path: path.join(__dirname, '../../public', script) });
        }
        const data = await page.evaluate(() => window.ProviderRegistry.getById('WALMART_US').scrapeOrder({}));
        assert.equal(data.orderNumber, FIXTURE_ORDER_ID);
        assert.equal(data.items.length, entry.items);
        assert.equal(data.orderTotal, entry.total);
        if (entry.subtotal) assert.equal(data.orderSubtotal, entry.subtotal);
        if (entry.delivery) assert.equal(data.deliveryCharges, entry.delivery);
        if (entry.paymentSplit) assert.equal(data.paymentSplit, entry.paymentSplit);
        if (entry.warning) assert.ok(data.extractionWarnings.includes(entry.warning));
        else assert.deepEqual(data.extractionWarnings, []);
        if (!entry.warning) {
          const cents = value => Math.round(Number(String(value).replace(/[^0-9.-]/g, '')) * 100);
          assert.equal(data.items.reduce((sum, item) => sum + cents(item.price), 0), cents(entry.subtotal));
          const s = loadSandbox({ scripts: ['utils.js'] });
          const downloads = captureDownloads(s);
          await s.convertMultipleOrdersToXlsx([data], ExcelJS);
          const workbook = new ExcelJS.Workbook();
          await workbook.xlsx.load(blobBuffer(downloads[0].blob));
          assert.equal(workbook.getWorksheet('Items').rowCount - 1, entry.items);
          const orders = workbook.getWorksheet('Orders');
          assert.equal(orders.getRow(2).getCell(orders.getRow(1).values.indexOf('Order Total')).value, cents(entry.total) / 100);
          for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => {
            assert.equal(cell.type === ExcelJS.ValueType.Formula, false);
            if (cell.hyperlink) assert.match(cell.hyperlink, /^https?:\/\//);
          }));
        }
        if (entry.variant === 'hostile') assert.equal(await page.locator('[data-testid="productName"] img').count(), 0);
      } finally { await page.close(); }
    });
  } finally { await browser.close(); }
});
