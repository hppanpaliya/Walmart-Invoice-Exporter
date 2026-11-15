'use strict';
const path = require('node:path');
const os = require('node:os');
const lib = require('./launcher.cjs');
(async () => {
  const session = await lib.launchExt({ extDir: lib.DEFAULT_EXT });
  const out = {};
  try {
    const { panel } = session;
    await lib.seedOrderHistory(panel, { months: 14 });
    // A long-time customer: add large orders so the yearly total reaches five digits.
    await panel.evaluate(async () => {
      const now = new Date();
      for (let i = 0; i < 12; i += 1) {
        const d = new Date(now.getFullYear(), now.getMonth() - (i % 10), 5 + i);
        const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const id = '2000990000090' + String(10 + i);
        const total = 1450.37 + i * 131.11;
        await OrderDb.putSummaries({ [id]: { orderDate: iso, orderTotal: total, subTotal: total / 1.0825, itemCount: 1, status: 'Delivered', items: [{ name: 'Samsung 65-inch 4K Smart TV', quantity: 1 }] } }, {});
        await OrderDb.putInvoice(id, { schemaVersion: 3, orderDate: iso, orderNumber: id, orderSubtotal: Number((total / 1.0825).toFixed(2)), tax: Number((total - total / 1.0825).toFixed(2)), tip: 0, orderTotal: Number(total.toFixed(2)), savings: 210.5, items: [{ productName: 'Samsung 65-inch 4K Smart TV', quantity: 1, price: Number((total / 1.0825).toFixed(2)) }] });
      }
    });
    const page = session.watch(await session.context.newPage(), 'dashboard');
    for (const width of [1440, 1280, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`chrome-extension://${session.extensionId}/dashboard.html`);
      await page.waitForSelector('.cbar', { timeout: 10000 });
      await page.waitForTimeout(900);
      out[width] = await page.evaluate(() => {
        const result = {};
        for (const id of ['statTotal', 'statOrders', 'statAvgMonth', 'statAvgOrder', 'statSaved']) {
          const el = document.getElementById(id); if (!el) continue;
          const card = el.closest('.card'); const value = el.closest('.stat-value') || el;
          const range = document.createRange(); range.selectNodeContents(value);
          const textRight = range.getBoundingClientRect().right; const cardBox = card.getBoundingClientRect();
          const style = getComputedStyle(card);
          result[id] = { text: el.textContent.replace(/\d/g, '9'), overflowsCardPx: Math.round(textRight - (cardBox.right - parseFloat(style.paddingRight))), clippedPx: Math.round(textRight - cardBox.right), valueScrollOverflow: value.scrollWidth - value.clientWidth, fontPx: getComputedStyle(value).fontSize, wraps: value.getClientRects().length > 1 || range.getClientRects().length > 2 };
        }
        result.pageOverflowPx = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        return result;
      });
      await page.locator('#statsSection').screenshot({ path: path.join(process.env.WIE_SHOTS || os.tmpdir(), `wie-stats-${width}.png`) });
    }
    out.errors = [...new Set(session.errors)];
  } finally { await session.close().catch(() => {}); }
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.log('failed', String(e.message).slice(0, 300)); process.exit(1); });
