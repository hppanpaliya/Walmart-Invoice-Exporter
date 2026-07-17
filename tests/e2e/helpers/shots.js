/**
 * UI screenshot driver (dev tool, not a test): boots the packed extension in
 * the e2e harness, walks the panel through its states, and saves PNGs.
 * Usage: node tests/e2e/helpers/shots.js <outDir>
 */
'use strict';

const path = require('node:path');
const { launch, collectOrders, renderOrderList } = require('./harness');

const OUT = process.argv[2] || '.';
const HEIGHT = 860;

async function shot(panel, name) {
  // The harness never sits on a real Walmart tab, so the off-tab banner is
  // a test artifact — hide it in captures.
  await panel.evaluate(() => {
    const banner = document.getElementById('offTabWarning');
    if (banner) banner.remove();
    const cacheInfo = document.getElementById('cacheInfo');
    if (cacheInfo) cacheInfo.remove();
  });
  await panel.waitForTimeout(200);
  await panel.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`saved ${name}.png`);
}

async function setTheme(panel, theme) {
  await panel.evaluate((t) => {
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }, theme);
}

(async () => {
  const { panel, close } = await launch();
  try {
    await panel.setViewportSize({ width: 380, height: HEIGHT });

    // First-run hero (empty DB => first-run macro state)
    await shot(panel, '01-first-run-light');
    await setTheme(panel, 'dark');
    await shot(panel, '02-first-run-dark');
    await setTheme(panel, null);

    // Collect via the real worker, render the receipt list
    const progress = await collectOrders(panel);
    await renderOrderList(panel, progress);
    const firstBox = panel.locator('.order-list input[type="checkbox"]').first();
    await firstBox.check();
    await shot(panel, '03-list-light');
    await setTheme(panel, 'dark');
    await shot(panel, '04-list-dark');

    // Expand the first row (click the row body, not the checkbox)
    await panel.locator('.order-list .order-row').first().click();
    await shot(panel, '05-row-expanded-dark');
    await setTheme(panel, null);

    // Range filter engaged (This year)
    const hasFilter = await panel.evaluate(() => {
      const select = document.getElementById('listRangeFilter');
      if (!select) return false;
      const option = Array.from(select.options).find((o) => o.value === 'thisYear');
      if (!option) return false;
      select.value = 'thisYear';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    });
    if (hasFilter) {
      await panel.waitForTimeout(300);
      await shot(panel, '06-filter-thisyear-light');
      await panel.evaluate(() => {
        const select = document.getElementById('listRangeFilter');
        select.value = 'all';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    } else {
      console.warn('listRangeFilter not found — skipping filter shot');
    }

    // Width sweep on the loaded list
    await panel.setViewportSize({ width: 300, height: HEIGHT });
    await shot(panel, '07-list-narrow-300');
    await panel.setViewportSize({ width: 460, height: HEIGHT });
    await shot(panel, '08-list-wide-460');
    await panel.setViewportSize({ width: 380, height: HEIGHT });

    // Horizontal-overflow check at the extreme narrow width
    await panel.setViewportSize({ width: 280, height: HEIGHT });
    const overflow = await panel.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    console.log(`overflow @280px: ${overflow}px ${overflow > 0 ? '*** HORIZONTAL SCROLL ***' : '(none, good)'}`);
    await shot(panel, '09-list-narrow-280');
  } finally {
    await close();
  }
})();
