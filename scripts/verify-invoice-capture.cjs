'use strict';
// Replay a locally saved Chrome invoice. No cookies/profile or network access.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const { loadSandbox } = require('../tests/helpers/sandbox');
const { captureDownloads, blobBuffer } = require('../tests/helpers/capture-downloads');
const root = path.join(__dirname, '..');
const capturePath = process.argv[2];
if (!capturePath) throw new Error('Usage: node scripts/verify-invoice-capture.cjs /path/to/saved-invoice.html [baseline-ref]');
const baselineRef = process.argv[3] || 'faae6af27e38e46dc6ed189b0924aa7a3e9a875e';
const fakeId = '200010000000042';

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.request().isNavigationRequest()
      ? route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
      : route.abort());
    const capture = await context.newPage();
    await capture.goto(`https://www.walmart.com/orders/${fakeId}`);
    const raw = fs.readFileSync(capturePath, 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
    await capture.setContent(raw);
    const fixture = await capture.evaluate((id) => {
      const doc = document.implementation.createHTMLDocument('Anonymized live invoice');
      const clean = element => {
        for (const node of [element, ...element.querySelectorAll('*')]) {
          for (const attr of [...node.attributes]) {
            if (!['class', 'data-testid', 'link-identifier', 'aria-hidden', 'aria-labelledby', 'alt'].includes(attr.name)) node.removeAttribute(attr.name);
          }
        }
        return element;
      };
      const prune = node => {
        if (node.nodeType !== 1) { node.remove(); return; }
        if (node.matches('[data-testid="itemtile-stack"]')) return;
        if (node.querySelector('[data-testid="itemtile-stack"]')) {
          for (const child of [...node.childNodes]) prune(child);
        } else if (!/^\s*(?:\d+.*(?:unavailable|shopped|delivered|weight adjusted)|Delivered on|Delivery from store)/i.test(node.textContent)) {
          node.remove();
        }
      };
      for (const original of document.querySelectorAll('.print-bill-date, .print-bill-bar-id')) {
        const copy = clean(original.cloneNode(true));
        if (copy.matches('.print-bill-bar-id')) copy.textContent = `Order# ${id}`;
        doc.body.appendChild(copy);
      }
      for (const original of document.querySelectorAll('.print-bill-group')) {
        const copy = original.cloneNode(true);
        for (const child of [...copy.childNodes]) prune(child);
        let index = 0;
        for (const tile of copy.querySelectorAll('[data-testid="itemtile-stack"]')) {
          index++;
          const nameNode = tile.querySelector('[data-testid="productName"]');
          const oldName = nameNode?.textContent || '';
          const placeholder = `Captured product ${index}`;
          if (nameNode) nameNode.textContent = placeholder;
          for (const el of tile.querySelectorAll('[aria-label]')) el.removeAttribute('aria-label');
          for (const el of tile.querySelectorAll('[data-testid="productDescription"], img, button')) el.remove();
          clean(tile);
          for (const link of tile.querySelectorAll('a[link-identifier="itemClick"]')) link.setAttribute('href', `/ip/${1000 + index}`);
          if (oldName && tile.textContent.includes(oldName)) throw new Error('Product anonymization failed');
        }
        // Preserve class names and hierarchy, strip telemetry and identifiers.
        for (const el of [copy, ...copy.querySelectorAll('*')]) {
          for (const attr of [...el.attributes]) {
            if (!['class', 'data-testid', 'link-identifier', 'href'].includes(attr.name)) el.removeAttribute(attr.name);
          }
        }
        doc.body.appendChild(copy);
      }
      const payment = document.querySelector('.bill-order-payment-info');
      const section = doc.createElement('div'); section.className = 'print-bill-payment-section';
      if (payment) {
        const copy = clean(payment.cloneNode(true));
        for (const el of copy.querySelectorAll('[aria-labelledby^="card-description-"]')) el.textContent = el.textContent.replace(/\d{4}/g, '0000');
        section.appendChild(copy);
      }
      for (const original of document.querySelectorAll('.bill-order-payment-spacing')) {
        if (!original.querySelector('.justify-between')) continue;
        const copy = clean(original.cloneNode(true));
        for (const el of copy.querySelectorAll('button, img')) el.remove();
        section.appendChild(copy);
      }
      doc.body.appendChild(section);
      return '<!doctype html>' + doc.documentElement.outerHTML;
    }, fakeId);
    const fixturePath = path.join(root, 'tests/fixtures/live-redesigned-order.html');
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
