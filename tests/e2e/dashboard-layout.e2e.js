/** Visual layout regressions in the packaged dashboard; synthetic data only. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, seedOrderHistory } = require('./helpers/harness');

test('dashboard contains stress data and keeps controls in view at narrow widths', async () => {
  const { context, extensionId, panel, close } = await launch({ reducedMotion: 'reduce' });
  try {
    const today = new Date();
    const iso = (year) => `${year}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    const longName = 'Chobani Greek Yogurt Family Pack ' + 'LongSyntheticProductLabel'.repeat(7);
    await seedOrderHistory(panel, { records: [1, 0].map((yearsAgo, i) => {
      const orderNumber = `20009900000100${i}`;
      const orderDate = iso(today.getFullYear() - yearsAgo);
      const total = yearsAgo ? 35 : 1254789.96;
      const summary = { orderDate, orderTotal: total, itemCount: 1, status: 'Delivered', items: [{ name: longName, quantity: 1 }] };
      return { orderNumber, summary, invoice: {
        schemaVersion: 3, walmartExtractionVersion: 6, orderNumber, orderDate,
        orderTotal: total, orderSubtotal: total, savings: yearsAgo ? 0 : 125000.19,
        items: [{ productName: longName, quantity: 1, price: total, categoryPathId: '0:976759:1' }],
        unfulfilledItems: [{ productName: longName, reason: 'Unavailable', quantity: 1, price: '$14.00' }],
      } };
    }) });

    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    const base = `chrome-extension://${extensionId}/dashboard.html`;
    const ready = {
      overview: '#statTotal', items: '.item-row', categories: '.cat-category summary',
      trends: '.hm-scroll', orders: 'tr.order-row', missed: '.mis-tiles', review: '.rv-hero-amount',
    };
    const open = async (view) => {
      await page.goto(`${base}#/${view}`);
      await page.locator(ready[view]).first().waitFor({ state: 'visible' });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const noPageOverflow = async (label) => {
      const px = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(px <= 1, `${label}: page overflowed by ${px}px`);
    };
    const exactAmountsFit = async (selector) => {
      const values = await page.locator(selector).evaluateAll(nodes => nodes.map(el => ({
        fullWidth: el.scrollWidth, width: el.clientWidth, size: parseFloat(getComputedStyle(el).fontSize),
      })));
      assert.ok(values.length);
      assert.ok(values.every(value => value.fullWidth <= value.width + 1 && value.size >= 16),
        `Headline amounts must fit without tiny text: ${JSON.stringify(values)}`);
    };

    for (const width of [1280, 1100, 1099]) {
      await page.setViewportSize({ width, height: 600 });
      await open('overview');
      await page.waitForFunction(() => document.querySelector('#statTotal').textContent.includes('1,254,789.96'));
      await exactAmountsFit('#statsSection .stat-value');
      await noPageOverflow(`Overview at ${width}`);
      if (width >= 1100) {
        const panelBottom = await page.locator('#panelFrame').evaluate(el => el.getBoundingClientRect().bottom);
        assert.ok(panelBottom <= 600, `${width}px: desktop panel extends below the viewport`);
      }
      await open('review');
      await exactAmountsFit('.rv-hero-amount');
      await noPageOverflow(`Year in Review at ${width}`);
    }

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 640 });
      for (const view of Object.keys(ready)) {
        await open(view);
        if (view === 'categories') {
          const category = page.locator('.cat-category').first();
          if (!(await category.evaluate(el => el.open))) await category.locator('summary').click();
          assert.ok(await page.locator('.cat-product-scroll').first().evaluate(el => el.scrollWidth > el.clientWidth),
            'A wide Categories table scrolls inside its card');
        }
        await noPageOverflow(`${view} at ${width}`);
        const controlsFit = await page.evaluate(() => {
          const settings = document.querySelector('#settingsBtn').getBoundingClientRect();
          const nav = document.querySelector('#appNav').getBoundingClientRect();
          const active = document.querySelector('[data-nav][aria-current="page"]').getBoundingClientRect();
          return settings.right <= innerWidth && active.left >= nav.left - 1 && active.right <= nav.right + 1;
        });
        assert.ok(controlsFit, `${view} at ${width}: settings or active navigation is clipped`);
      }
    }
    const spacing = await page.addStyleTag({ content: `
      * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; }
      p { margin-bottom: 2em !important; }
    ` });
    for (const view of Object.keys(ready)) {
      await open(view);
      await noPageOverflow(`${view} at 320 with extra text spacing`);
    }
    await spacing.evaluate(el => el.remove());

    await page.locator('#settingsBtn').click();
    const settings = page.frameLocator('#panelFrame');
    const deleteButton = settings.locator('#deleteAllDataButton');
    await deleteButton.waitFor();
    assert.ok(await deleteButton.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
      'Embedded settings must also reflow');
  } finally {
    await close();
  }
});
