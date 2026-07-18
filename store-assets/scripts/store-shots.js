/**
 * Capture raw UI screenshots (v7.3, seeded PII-free data) for the Chrome Web
 * Store listing kit. Output: scratchpad/store-raw/*.png
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { launch, seedOrderHistory } = require(path.join(__dirname, '..', '..', 'tests', 'e2e', 'helpers', 'harness'));

const OUT = path.join(__dirname, 'store-raw');  // gitignored scratch output
fs.mkdirSync(OUT, { recursive: true });
const raw = (name) => path.join(OUT, name);

(async () => {
  const { context, extensionId, panel, close } = await launch();
  try {
    await seedOrderHistory(panel, { months: 14 });

    const dash = await context.newPage();
    await dash.setViewportSize({ width: 1440, height: 900 });
    await dash.goto(`chrome-extension://${extensionId}/dashboard.html`);
    await dash.waitForSelector('.cbar', { timeout: 10000 });
    const frame = dash.frames().find((f) => f.url().endsWith('sidepanel.html'));
    await frame.waitForSelector('.order-list .order-row', { timeout: 10000 });
    await dash.waitForTimeout(800);

    // 1. Dashboard hero (light)
    await dash.screenshot({ path: raw('dash-light.png') });
    console.log('dash-light');

    // 2. Month drill-down (pick a mid bar so the chart shows a highlight)
    // Pick the richest visible month so the insight cards have content.
    const bars = dash.locator('.cbar');
    await bars.nth(0).click();
    await dash.waitForTimeout(400);
    await dash.screenshot({ path: raw('dash-month.png') });
    console.log('dash-month');
    await dash.locator('#backChip').click();
    await dash.waitForTimeout(300);

    // 3. Embedded panel close-up: select two orders so the export area is live
    const boxes = frame.locator('.order-list input[type="checkbox"]');
    await boxes.nth(0).click();
    await boxes.nth(1).click();
    await dash.waitForTimeout(300);
    const railEl = await dash.$('#panelFrame');
    const box = await railEl.boundingBox();
    await dash.screenshot({ path: raw('panel-list.png'), clip: box });
    console.log('panel-list', JSON.stringify(box));

    // 4. Settings view inside the panel (privacy shot)
    await frame.click('#settingsButton');
    await dash.waitForTimeout(400);
    await dash.screenshot({ path: raw('panel-settings.png'), clip: box });
    console.log('panel-settings');
    await frame.click('#settingsBackButton');
    await dash.waitForTimeout(300);

    // 5. Dark mode via the real shared setting (page + embed both flip)
    await dash.evaluate(() => chrome.storage.local.set({ theme: 'dark' }));
    await dash.waitForTimeout(600);
    await dash.screenshot({ path: raw('dash-dark.png') });
    console.log('dash-dark');
    await dash.evaluate(() => chrome.storage.local.set({ theme: 'system' }));

    // Overflow sanity
    const overflow = await dash.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    console.log('overflow@1440:', overflow);
  } finally {
    await close();
  }
})();
