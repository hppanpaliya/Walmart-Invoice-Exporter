/**
 * UI screenshot driver (dev tool, not a test): boots the packed extension in
 * the e2e harness, walks the panel through its main states, and saves PNGs
 * at side-panel width. Usage: node tests/e2e/helpers/shots.js <outDir>
 */
'use strict';

const path = require('node:path');
const { launch, collectOrders, renderOrderList } = require('./harness');

const OUT = process.argv[2] || '.';
const WIDTH = 380;
const HEIGHT = 820;

async function shot(panel, name) {
  await panel.waitForTimeout(250);
  await panel.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`saved ${name}.png`);
}

(async () => {
  const { panel, close } = await launch();
  try {
    await panel.setViewportSize({ width: WIDTH, height: HEIGHT });

    // Main view, empty state (before any collection)
    await shot(panel, '01-main-empty-light');

    // Collect via the real worker, render the list, select one order
    const progress = await collectOrders(panel);
    await renderOrderList(panel, progress);
    const firstBox = panel.locator('.order-list input[type="checkbox"]').first();
    await firstBox.check();
    await shot(panel, '02-main-orders-light');

    // Dark mode (manual override, same as the Settings toggle)
    await panel.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await shot(panel, '03-main-orders-dark');
    await panel.evaluate(() => {
      document.documentElement.removeAttribute('data-theme');
    });

    // Settings view (light + dark)
    await panel.evaluate(() => {
      window.Sidepanel.view.switchView('settings');
      window.Sidepanel.settings.renderSettings();
    });
    await shot(panel, '04-settings-light');
    await panel.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await shot(panel, '05-settings-dark');
    await panel.evaluate(() => {
      document.documentElement.removeAttribute('data-theme');
    });

    // Delete-all confirmation dialog
    await panel.click('#deleteAllDataButton');
    await shot(panel, '06-delete-dialog-light');

    // Dashboard
    await panel.evaluate(() => {
      const dialog = document.querySelector('.dialog-overlay .dialog-cancel');
      if (dialog) dialog.click();
      window.Sidepanel.view.switchView('dashboard');
      window.Sidepanel.dashboard.renderDashboard();
    });
    await shot(panel, '07-dashboard-light');
  } finally {
    await close();
  }
})();
