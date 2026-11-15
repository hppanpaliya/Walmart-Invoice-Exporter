'use strict';
// Every control in Settings: default, change through the UI, what is stored,
// persistence across reload, sync to the main view, reset, delete-all.
// Packaged 8.8, synthetic seeded data, mock Walmart.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const lib = require('./launcher.cjs');

const HERE = __dirname;
const EXT = lib.DEFAULT_EXT;
const OUT = process.env.WIE_OUT || path.join(os.tmpdir(), 'wie-settings-sweep.json');
const result = { checks: {}, errors: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hide = (storage) => Object.fromEntries(Object.entries(storage).map(([key, value]) => [key, /token/i.test(key) ? `<${String(value).length} chars>` : value]));

(async () => {
  let session;
  try {
    session = await lib.launchExt({ extDir: EXT });
    const { panel } = session;
    const seeded = await lib.seedOrderHistory(panel, { months: 6 });
    result.seeded = { orders: seeded.length, invoices: seeded.filter((record) => record.invoice).length };

    const openSettings = async () => { await panel.click('#settingsButton'); await panel.waitForSelector('#settingsPageLimit', { timeout: 8000 }); await sleep(300); };
    const shown = () => panel.evaluate(() => {
      const out = {};
      document.querySelectorAll('input, select').forEach((el) => {
        if (!el.id || el.offsetParent === null) return;
        out[el.id] = el.type === 'checkbox' ? el.checked : el.value;
      });
      out.theme = document.documentElement.getAttribute('data-theme') || '<system: no attribute>';
      out.themeActive = [...document.querySelectorAll('#themeControl [aria-pressed="true"], #themeControl .active, #themeControl [aria-checked="true"]')].map((el) => el.textContent.trim()).join(',');
      return out;
    });
    const mainView = () => panel.evaluate(() => {
      const value = (id) => { const el = document.getElementById(id); if (!el) return '<missing>'; return el.type === 'checkbox' ? el.checked : el.value; };
      return Object.fromEntries(['pageLimit', 'incrementalCollect', 'exportFormat', 'csvPreset', 'includeThumbnails', 'legacyExcel'].map((id) => [id, value(id)]));
    });
    const setInput = (selector, value) => panel.evaluate(({ selector: s, value: v }) => {
      const el = document.querySelector(s); if (!el) return false;
      el.focus(); el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.blur();
      return true;
    }, { selector, value: String(value) });
    // Perform one UI action and report which storage keys changed.
    const change = async (label, action) => {
      const before = await lib.storageAll(panel);
      let ok = true;
      try { ok = (await action()) !== false; } catch (error) { ok = 'threw: ' + String(error.message).slice(0, 120); }
      await sleep(450);
      const after = await lib.storageAll(panel);
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      const diff = {};
      for (const key of keys) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) diff[key] = /token/i.test(key) ? `<changed, ${String(after[key]).length} chars>` : after[key];
      result.checks.changes[label] = { done: ok, stored: diff };
    };

    await openSettings();
    result.checks.inventory = await panel.evaluate(() => [...document.querySelectorAll('input, select, button')].filter((el) => el.offsetParent !== null).map((el) => {
      const label = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
      return `${el.tagName.toLowerCase()}${el.type ? '[' + el.type + ']' : ''}#${el.id || '(no id)'} "${((label && label.textContent) || el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 48)}"`;
    }));
    result.checks.defaultsShown = await shown();
    result.checks.defaultsStored = hide(await lib.storageAll(panel));
    result.checks.statsLine = String(await panel.textContent('#settingsStatsLine').catch(() => '<missing>')).replace(/\s+/g, ' ').trim();
    save();

    result.checks.changes = {};
    await change('pageLimit=7', () => setInput('#settingsPageLimit', 7));
    await change('incremental on', () => panel.check('#settingsIncrementalCollect'));
    await change('fastFetch on', () => panel.check('#settingsFastFetch'));
    await change('format=csv', () => panel.selectOption('#settingsExportFormat', 'csv'));
    result.checks.csvPresetVisibleForCsv = await panel.evaluate(() => { const el = document.getElementById('settingsCsvPreset'); return Boolean(el && el.offsetParent !== null); });
    await change('csvPreset=xero', () => panel.selectOption('#settingsCsvPreset', 'xero'));
    result.checks.mainViewWhileCsv = await mainView();
    await change('format=xlsx', () => panel.selectOption('#settingsExportFormat', 'xlsx'));
    await change('thumbnails on', () => panel.check('#settingsIncludeThumbnails'));
    await change('legacyExcel on', () => panel.check('#settingsLegacyExcel'));
    const timing = await panel.evaluate(() => [...document.querySelectorAll('input[data-timing-key]')].map((el) => ({ key: el.dataset.timingKey, min: el.min, max: el.max, step: el.step, value: el.value })));
    result.checks.timingInputs = timing;
    result.checks.timingClamp = {};
    for (const spec of timing) {
      const tries = { belowMin: Number(spec.min) - 100, aboveMax: Number(spec.max) + 1000, empty: '', valid: Number(spec.min) + 0.5 };
      const outcome = {};
      for (const [name, value] of Object.entries(tries)) {
        await setInput(`#timing-${spec.key}`, value);
        await sleep(350);
        const stored = (await lib.storageAll(panel))[spec.key];
        outcome[name] = { typed: value, stored: stored === undefined ? '<absent>' : stored, shown: await panel.inputValue(`#timing-${spec.key}`) };
      }
      result.checks.timingClamp[spec.key] = outcome;
    }
    await change('retention off', () => panel.uncheck('#dataRetentionEnabled'));
    await change('retention on', () => panel.check('#dataRetentionEnabled'));
    result.checks.retentionDays = {};
    for (const value of [0, 99999, 365]) {
      await setInput('#dataRetentionDays', value);
      await sleep(350);
      result.checks.retentionDays[value] = { stored: (await lib.storageAll(panel)).dataRetentionDays, shown: await panel.inputValue('#dataRetentionDays').catch(() => '<hidden>') };
    }
    result.checks.theme = {};
    for (const name of ['Light', 'Dark', 'System', 'Dark']) {
      await panel.locator('#themeControl').getByText(name, { exact: true }).click();
      await sleep(350);
      result.checks.theme[`${name}@${Object.keys(result.checks.theme).length}`] = { attribute: await panel.evaluate(() => document.documentElement.getAttribute('data-theme') || '<none>'), stored: (await lib.storageAll(panel)).theme };
    }
    const dash = session.watch(await session.context.newPage(), 'dashboard');
    await dash.goto(`chrome-extension://${session.extensionId}/dashboard.html`);
    await dash.waitForTimeout(1500);
    result.checks.theme.dashboardWhileDark = await dash.evaluate(() => document.documentElement.getAttribute('data-theme') || '<none>');
    await dash.goto(`chrome-extension://${session.extensionId}/dashboard.html?view=settings`);
    await dash.waitForTimeout(1500);
    result.checks.optionsPage = await dash.evaluate(() => ({ visibleTextLength: document.body.innerText.length, hasSettingsControlsInFrame: null }));
    result.checks.optionsPage.framesWithSettings = (await Promise.all(dash.frames().map((frame) => frame.evaluate(() => Boolean(document.getElementById('settingsPageLimit'))).catch(() => false)))).filter(Boolean).length;
    await dash.close();
    save();

    // MCP section, UI only. A private port so nothing else on this machine is dialled.
    await change('mcpPort=19555', () => setInput('#settingsMcpPort', 19555));
    await change('mcp on', () => panel.check('#settingsMcpEnabled'));
    const tokenA = (await lib.storageAll(panel)).mcpBridgeToken || '';
    result.checks.mcpUi = { tokenLength: tokenA.length, tokenLooksRandom: new Set(tokenA).size > 10, detailsVisible: await panel.evaluate(() => { const el = document.getElementById('settingsMcpDetails'); return Boolean(el && el.offsetParent !== null); }) };
    result.checks.mcpUi.portTries = {};
    for (const value of [80, 70000, '', 9001]) {
      await setInput('#settingsMcpPort', value);
      await sleep(350);
      result.checks.mcpUi.portTries[String(value) || 'empty'] = { stored: (await lib.storageAll(panel)).mcpBridgePort, shown: await panel.inputValue('#settingsMcpPort') };
    }
    await setInput('#settingsMcpPort', 19555);
    await change('mcp new token', () => panel.click('#settingsMcpNewToken'));
    if (await panel.locator('#confirmDialogProceed').isVisible().catch(() => false)) { result.checks.mcpUi.newTokenAsksToConfirm = true; await panel.click('#confirmDialogProceed'); await sleep(400); }
    const tokenB = (await lib.storageAll(panel)).mcpBridgeToken || '';
    result.checks.mcpUi.newTokenDiffers = tokenA !== tokenB && tokenB.length > 0;
    await session.context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    await panel.click('#settingsMcpCopyToken').catch(() => {});
    await sleep(300);
    result.checks.mcpUi.copyPutsTokenOnClipboard = await panel.evaluate(() => navigator.clipboard.readText()).then((text) => text === tokenB).catch((error) => 'clipboard not readable: ' + String(error.message).slice(0, 60));
    await change('mcp allow actions on', () => panel.check('#settingsMcpAllowActions'));
    await change('mcp off', () => panel.uncheck('#settingsMcpEnabled'));
    save();

    // Walmart sites: the permission prompt cannot be accepted here.
    const toggles = await panel.evaluate(() => [...document.querySelectorAll('input[id^="providerToggle_"]')].map((el) => ({ id: el.id, checked: el.checked, disabled: el.disabled })));
    result.checks.walmartSites = { toggles };
    if (toggles[0]) {
      await change('walmart.ca toggle', () => panel.click('#' + toggles[0].id));
      await sleep(1200);
      result.checks.walmartSites.afterClick = await panel.evaluate((id) => { const el = document.getElementById(id); return { checked: el && el.checked, nearbyText: el ? el.closest('section, .settings-section, div').innerText.replace(/\s+/g, ' ').slice(0, 260) : '' }; }, toggles[0].id);
    }
    save();

    // Persistence: reload the page and compare what Settings shows.
    await change('pageLimit=7 again', () => setInput('#settingsPageLimit', 7));
    const beforeReload = await shown();
    await panel.reload();
    await panel.waitForFunction(() => window.Sidepanel && window.Sidepanel.download);
    await sleep(800);
    result.checks.mainViewAfterReload = await mainView();
    await openSettings();
    const afterReload = await shown();
    result.checks.persistence = { controlsCompared: Object.keys(beforeReload).length, lostOnReload: Object.keys(beforeReload).filter((key) => JSON.stringify(beforeReload[key]) !== JSON.stringify(afterReload[key])).map((key) => `${key}: ${beforeReload[key]} -> ${afterReload[key]}`) };
    save();

    // Reset to defaults.
    const tokenBeforeReset = (await lib.storageAll(panel)).mcpBridgeToken || '';
    await panel.click('#resetSettingsButton');
    await sleep(400);
    if (await panel.locator('#confirmDialogProceed').isVisible().catch(() => false)) {
      result.checks.resetDialog = String(await panel.evaluate(() => document.getElementById('confirmDialogProceed').closest('[role="dialog"], dialog, .confirm-dialog, div').innerText)).replace(/\s+/g, ' ').slice(0, 260);
      await panel.click('#confirmDialogProceed');
    }
    await sleep(900);
    if (!(await panel.locator('#settingsPageLimit').isVisible().catch(() => false))) await openSettings();
    const afterReset = await shown();
    const defaults = result.checks.defaultsShown;
    result.checks.reset = {
      notBackToDefault: Object.keys(defaults).filter((key) => key in afterReset && JSON.stringify(defaults[key]) !== JSON.stringify(afterReset[key])).map((key) => `${key}: default ${defaults[key]}, now ${afterReset[key]}`),
      tokenKept: ((await lib.storageAll(panel)).mcpBridgeToken || '') === tokenBeforeReset,
      storedAfterReset: hide(await lib.storageAll(panel)),
      mainView: await mainView(),
      dataKept: (await lib.dumpIndexedDb(panel)).map((db) => Object.fromEntries(Object.entries(db.stores).map(([name, records]) => [name, Object.keys(records).length]))),
    };
    await panel.check('#settingsMcpEnabled');
    await sleep(700);
    result.checks.reset.allowActionsCheckboxAfterResetAndReEnable = await panel.isChecked('#settingsMcpAllowActions').catch(() => '<missing>');
    await panel.uncheck('#settingsMcpEnabled');
    await sleep(400);
    save();

    // Delete all saved data: cancel, then proceed.
    const count = async () => (await lib.dumpIndexedDb(panel)).map((db) => Object.fromEntries(Object.entries(db.stores).map(([name, records]) => [name, Object.keys(records).length])));
    const del = { before: await count(), buttonEnabled: await panel.isEnabled('#deleteAllDataButton') };
    const dialog = panel.locator('[role="dialog"]');
    await panel.click('#deleteAllDataButton');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    del.dialogText = String(await dialog.innerText()).replace(/\s+/g, ' ').slice(0, 320);
    del.dialogButtons = await dialog.locator('button').allInnerTexts();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await sleep(600);
    del.dialogClosedAfterCancel = !(await dialog.isVisible().catch(() => false));
    del.afterCancel = await count();
    await panel.click('#deleteAllDataButton');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await dialog.getByRole('button', { name: /^Delete \d+ order/ }).click();
    await sleep(1800);
    del.afterProceed = await count();
    del.statsLineAfter = String(await panel.textContent('#settingsStatsLine').catch(() => '<missing>')).replace(/\s+/g, ' ').trim();
    del.settingsKeptAfterDelete = hide(await lib.storageAll(panel));
    del.buttonEnabledAfter = await panel.isEnabled('#deleteAllDataButton').catch(() => '<missing>');
    await panel.click('#settingsBackButton').catch(() => {});
    await sleep(500);
    del.orderListRowsAfter = await panel.locator('.order-list .order-row').count();
    result.checks.deleteAll = del;
    result.extensionErrors = [...new Set(session.errors)].slice(0, 20);
    result.finished = true;
    save();
    console.log('FINISHED');
  } catch (error) {
    result.errors.push(String(error && error.stack ? error.stack : error).slice(0, 700));
    if (session) result.extensionErrors = [...new Set(session.errors)].slice(0, 20);
    result.finished = false;
    save();
    console.log('FAILED ' + String(error && error.message).slice(0, 200));
  } finally {
    if (session) await session.close().catch(() => {});
  }
})();
