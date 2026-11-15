'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launch, seedOrderHistory } = require('./helpers/harness');

test('dashboard refresh, hostile stored text, view navigation and bridge boundaries', async (t) => {
  const { context, extensionId, panel, close } = await launch();
  const hostileName = '<img src=x onerror="window.injected=true"> =HYPERLINK("bad")';
  try {
    const records = [{ orderNumber: '200010000000042', summary: { orderDate: '2026-05-31', orderTotal: '$99.00', status: '<svg onload=alert(1)>' },
      invoice: { schemaVersion: 3, orderNumber: '200010000000042', orderDate: 'May 31, 2026', orderTotal: '$10.00', tip: '$0.00',
        items: [{ productName: hostileName, quantity: 1, price: '$10.00' }] } }];
    await seedOrderHistory(panel, { records });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`chrome-extension://${extensionId}/dashboard.html`);
    await page.locator('#scopeSelect').selectOption('all');
    await page.waitForFunction(() => document.querySelector('#statTotal').textContent === '$10.00');

    await t.test('updating an existing invoice refreshes totals, rows, and detail amounts', async () => {
      await page.evaluate(async () => {
        const record = await OrderDb.getOrder('200010000000042');
        await OrderDb.putInvoice(record.orderNumber, { ...record.invoice, orderTotal: '$0.00' });
        window.dispatchEvent(new Event('focus'));
      });
      await page.waitForFunction(() => document.querySelector('#statTotal').textContent === '$0.00');
      await page.locator('[data-nav="orders"]').click();
      const row = page.locator('tr.order-row').first();
      assert.match(await row.textContent(), /\$0\.00/);
      assert.doesNotMatch(await row.textContent(), /\$99\.00/);
      await row.locator('.items-cell').click();
      assert.match(await page.locator('.detail-money').textContent(), /Total\$0\.00/);
    });

    await t.test('stored seller text stays inert and all dashboard views render', async () => {
      assert.ok((await page.locator('.detail-item-name').textContent()).includes(hostileName));
      assert.equal(await page.locator('.items-cell img, .status-chip svg, .detail-item-name img').count(), 0);
      for (const view of ['items', 'trends', 'review', 'overview', 'orders']) {
        await page.locator(`[data-nav="${view}"]`).click();
        await page.waitForFunction(expected => document.body.dataset.view === expected, view);
        assert.equal(await page.getAttribute('body', 'data-view'), view);
      }
      assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
    });

    await t.test('standalone panel rejects self-sent dashboard commands', async () => {
      const format = await panel.inputValue('#exportFormat');
      await panel.evaluate(() => window.postMessage({ source: 'wie-dashboard', type: 'SET_EXPORT_FORMAT', format: 'csv' }, location.origin));
      await panel.waitForTimeout(100);
      assert.equal(await panel.inputValue('#exportFormat'), format);
    });

    await t.test('embedded panel accepts its parent and rejects a sibling frame', async () => {
      await page.locator('[data-nav="orders"]').click();
      await page.waitForFunction(() => document.body.dataset.view === 'orders');
      const embedded = page.frames().find(frame => frame.url().endsWith('sidepanel.html'));
      await embedded.waitForSelector('#exportFormat');
      await page.locator('#pageExportFormat').selectOption('csv');
      await embedded.waitForFunction(() => document.querySelector('#exportFormat').value === 'csv');
      await page.evaluate(() => {
        const sibling = document.createElement('iframe');
        sibling.id = 'untrustedSibling';
        sibling.name = 'untrustedSibling';
        document.body.appendChild(sibling);
      });
      await page.frame({ name: 'untrustedSibling' }).evaluate(() => {
        parent.document.getElementById('panelFrame').contentWindow.postMessage({ source: 'wie-dashboard', type: 'SET_EXPORT_FORMAT', format: 'pdf' }, parent.location.origin);
      });
      await embedded.waitForTimeout(100);
      assert.equal(await embedded.locator('#exportFormat').inputValue(), 'csv');
      await page.locator('#untrustedSibling').evaluate(el => el.remove());
    });
    await t.test('an older refresh cannot overwrite a newer invoice snapshot', async () => {
      await page.evaluate(() => {
        const original = OrderDb.getAllOrders;
        window.__restoreOrderRead = () => { OrderDb.getAllOrders = original; };
        let first = true;
        OrderDb.getAllOrders = async (...args) => {
          const records = await original(...args);
          if (!first) return records;
          first = false;
          return new Promise(resolve => {
            window.__releaseOlderRead = () => resolve(records);
          });
        };
        window.dispatchEvent(new Event('focus'));
      });
      try {
        await page.waitForFunction(() => typeof window.__releaseOlderRead === 'function');
        await page.evaluate(async () => {
          const record = await OrderDb.getOrder('200010000000042');
          await OrderDb.putInvoice(record.orderNumber, { ...record.invoice, orderTotal: '$20.00' });
          window.dispatchEvent(new Event('focus'));
        });
        await page.waitForFunction(() => document.querySelector('#statTotal').textContent === '$20.00');
        await page.evaluate(async () => {
          window.__releaseOlderRead();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        assert.equal(await page.locator('#statTotal').textContent(), '$20.00');
      } finally {
        await page.evaluate(() => {
          window.__restoreOrderRead();
          delete window.__restoreOrderRead;
          delete window.__releaseOlderRead;
        });
      }
    });
    assert.deepEqual(errors, []);
  } finally { await close(); }
});
