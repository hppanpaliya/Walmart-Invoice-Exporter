'use strict';
// The two new dashboard views on the packaged build, with seeded invoices that
// carry the new details. Synthetic data only.
const path = require('node:path');
const os = require('node:os');
const lib = require('./launcher.cjs');
(async () => {
  const session = await lib.launchExt({ extDir: lib.DEFAULT_EXT });
  const shots = process.env.WIE_SHOTS || os.tmpdir();
  const out = {};
  try {
    const { panel } = session;
    await lib.seedOrderHistory(panel, { months: 5 });
    await panel.evaluate(async () => {
      const now = new Date();
      const iso = (day) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const put = async (id, day, invoice) => {
        await OrderDb.putSummaries({ [id]: { orderDate: iso(day), orderTotal: invoice.orderTotal, itemCount: invoice.items.length, status: 'Delivered', items: invoice.items.map((i) => ({ name: i.productName, quantity: i.quantity })) } }, {});
        await OrderDb.putInvoice(id, { schemaVersion: 3, walmartExtractionVersion: 6, orderDate: iso(day), orderNumber: id, tax: 0, tip: 0, savings: 0, ...invoice });
      };
      await put('200099000008001', 2, { orderTotal: 41, orderSubtotal: 41, orderStatus: 'Delivered', wasDelayed: true, storeName: 'Springfield Supercenter',
        items: [
          { productName: 'Mystery Item', usItemId: 'x1', quantity: 1, price: 5, categoryPathId: '0:976759:976794' },
          { productName: 'Whole Milk for Kittens', usItemId: 'x2', quantity: 1, price: 4, categoryPathId: '0:5440:202072' },
          { productName: 'Oat Milk <b>Barista</b>', usItemId: 'x3', quantity: 1, price: 12, categoryPathId: '0:976759:976794', fulfillment: 'Substituted' },
          { productName: 'Bananas', usItemId: 'x4', quantity: 3, price: 20, categoryPathId: '0:976759:976794', fulfillment: 'Weight adjusted', priceNotes: 'Final weight: 2.3 lbs' },
        ],
        unfulfilledItems: [
          { productName: 'String Cheese <img src=x onerror=alert(1)>', quantity: '2', reason: 'Unavailable', price: '$9.88' },
          { productName: 'Trash Bags', quantity: '1', reason: 'Canceled', price: '$6.50' },
        ] });
      await put('200099000008002', 1, { orderTotal: 5, orderSubtotal: 5, orderStatus: 'Delivered',
        items: [{ productName: 'Paper Towels', usItemId: 'x5', quantity: 1, price: 5, categoryPathId: '0:1115193:1' }],
        unfulfilledItems: [{ productName: 'String Cheese <img src=x onerror=alert(1)>', quantity: '1', reason: 'Unavailable', price: '$4.94' }] });
    });
    const page = session.watch(await session.context.newPage(), 'dashboard');
    let dialogs = 0; page.on('dialog', (d) => { dialogs += 1; d.dismiss().catch(() => {}); });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(`chrome-extension://${session.extensionId}/dashboard.html`);
    await page.waitForSelector('.cbar', { timeout: 10000 });
    out.nav = await page.evaluate(() => [...document.querySelectorAll('[data-nav]')].map((el) => el.getAttribute('data-nav')));

    await page.locator('[data-nav="categories"]').click();
    await page.waitForTimeout(1200);
    out.categories = await page.evaluate(() => {
      const root = document.getElementById('viewCategories');
      const cards = [...root.querySelectorAll('.cat-category')].map((card) => ({ title: card.querySelector('.cat-category-title') ? card.querySelector('.cat-category-title').childNodes[0].textContent.trim() : '', total: (card.querySelector('.cat-category-total') || {}).textContent }));
      return { visible: root.offsetParent !== null, heading: (root.querySelector('h1') || {}).textContent, total: (root.querySelector('.cat-total') || {}).textContent, cards, injected: root.querySelectorAll('img[src="x"], b').length, selects: root.querySelectorAll('select.cat-select').length, overflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    await page.screenshot({ path: path.join(shots, 'wie-categories.png') });
    // Assign a category by hand, then confirm it sticks after a reload.
    const firstSelect = page.locator('#viewCategories select.cat-select').first();
    const changed = await firstSelect.selectOption('pets').then(() => true).catch(() => false);
    await page.waitForTimeout(800);
    await page.reload();
    await page.locator('[data-nav="categories"]').click();
    await page.waitForTimeout(1200);
    out.manualAssignment = { changed, youSetThisShown: await page.evaluate(() => document.querySelectorAll('#viewCategories .cat-you-set').length) };

    await page.locator('[data-nav="missed"]').click();
    await page.waitForTimeout(900);
    out.missed = await page.evaluate(() => {
      const root = document.getElementById('viewMissed');
      return { visible: root.offsetParent !== null, heading: (root.querySelector('h1') || {}).textContent,
        tiles: [...root.querySelectorAll('.mis-tile')].map((tile) => tile.querySelector('.mis-tile-title').textContent + '=' + tile.querySelector('.mis-tile-value').textContent + ' (' + tile.querySelector('.mis-tile-note').textContent + ')'),
        coverage: (root.querySelector('.mis-coverage') || {}).textContent, cards: [...root.querySelectorAll('.mis-card h2')].map((h) => h.textContent),
        firstTopRow: [...(root.querySelector('.mis-table tbody tr') || { children: [] }).children].map((td) => td.textContent.trim()),
        injected: root.querySelectorAll('img[src="x"]').length, overflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    await page.screenshot({ path: path.join(shots, 'wie-missed.png') });
    await page.evaluate(() => chrome.storage.local.set({ theme: 'dark' }));
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(shots, 'wie-missed-dark.png') });
    await page.setViewportSize({ width: 820, height: 1000 });
    await page.waitForTimeout(400);
    out.narrow = await page.evaluate(() => ({ overflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    out.dialogs = dialogs;
    out.errors = [...new Set(session.errors)];
  } finally { await session.close().catch(() => {}); }
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.log('failed', String(e.stack || e.message).slice(0, 500)); process.exit(1); });
