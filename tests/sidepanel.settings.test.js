'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, evalIn } = require('./helpers/sandbox');

/**
 * sidepanel.settings.js doesn't need sidepanel.js/actions.js/download.js
 * loaded — every cross-module call it makes (Sidepanel.applyTheme,
 * Sidepanel.actions.checkCurrentTab, Sidepanel.view.updateDownloadButtonLabels)
 * is guarded with `if (Sidepanel.x)` precisely so it degrades gracefully
 * when those modules aren't present, which is what makes it testable here
 * in isolation.
 */
function loadSettingsSandbox() {
  return loadSandbox({
    scripts: [
      'utils.js',
      'orderdb.js',
      'sidepanel.state.js',
      'sidepanel.components.js',
      'sidepanel.settings.js',
    ],
  });
}

test('Sidepanel.settings exposes renderSettings/SETTINGS_DEFAULTS/deleteAllSavedData/resetSettingsToDefaults', () => {
  const sandbox = loadSettingsSandbox();
  const settings = sandbox.window.Sidepanel.settings;

  assert.equal(typeof settings.renderSettings, 'function');
  assert.equal(typeof settings.deleteAllSavedData, 'function');
  assert.equal(typeof settings.resetSettingsToDefaults, 'function');

  // Scope guard: individual chrome.storage.local keys, NOT a consolidated
  // settings object — this is the exact set the main view already reads.
  assert.deepEqual(Object.keys(settings.SETTINGS_DEFAULTS).sort(), [
    'csvPreset',
    'exportFormat',
    'exportMode',
    'includeThumbnails',
    'incrementalCollect',
    'legacyExcel',
    'pageLimit',
    'theme',
  ]);
  assert.equal(settings.SETTINGS_DEFAULTS.theme, 'system');
  assert.equal(settings.SETTINGS_DEFAULTS.pageLimit, 0);
  assert.equal(settings.SETTINGS_DEFAULTS.legacyExcel, false);
});

test('deleteAllSavedData ("Delete all saved data", spec §4.4): clears OrderDb and resets session state via RESET_SESSION_STATE', async () => {
  const sandbox = loadSettingsSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');

  await OrderDb.putSummaries({ '111': { orderDate: '2026-01-01T00:00:00.000Z' } });
  await OrderDb.putInvoice('111', { schemaVersion: 3, orderTotal: '$9.99' });
  const before = await OrderDb.getStats();
  assert.equal(before.orders, 1);
  assert.equal(before.invoices, 1);

  const sentMessages = [];
  sandbox.chrome.runtime.sendMessage = (message, callback) => {
    sentMessages.push(message);
    if (callback) queueMicrotask(() => callback({ status: 'session_state_reset' }));
  };

  await sandbox.window.Sidepanel.settings.deleteAllSavedData();

  const after = await OrderDb.getStats();
  assert.equal(after.orders, 0, 'OrderDb.clearAll must have run — a true empty state, not just invoices');
  assert.equal(after.invoices, 0);

  assert.equal(sentMessages.length, 1, 'must send exactly one session-reset message');
  assert.equal(sentMessages[0].action, evalIn(sandbox, 'CONSTANTS.MESSAGES.RESET_SESSION_STATE'));
});

test('resetSettingsToDefaults ("Reset settings to defaults"): restores every settings key without touching stored orders', async () => {
  const sandbox = loadSettingsSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putSummaries({ '222': { orderDate: '2026-02-02T00:00:00.000Z' } });

  await new Promise((resolve) =>
    sandbox.chrome.storage.local.set(
      {
        exportMode: 'single',
        exportFormat: 'csv',
        csvPreset: 'xero',
        includeThumbnails: true,
        incrementalCollect: true,
        legacyExcel: true,
        theme: 'dark',
        pageLimit: 5,
      },
      resolve
    )
  );

  await sandbox.window.Sidepanel.settings.resetSettingsToDefaults();

  const stored = sandbox.chrome.storage.local._dump();
  const defaults = sandbox.window.Sidepanel.settings.SETTINGS_DEFAULTS;
  Object.keys(defaults).forEach((key) => {
    assert.equal(stored[key], defaults[key], `${key} must reset to its default`);
  });

  // The whole point of "reset settings" vs. "delete all saved data": this
  // must NEVER touch stored orders/invoices.
  const stats = await OrderDb.getStats();
  assert.equal(stats.orders, 1, 'reset settings must not touch stored order data');
});

test('the per-order badge is informational only (spec §4.4: no delete affordance)', () => {
  const sandbox = loadSandbox({ scripts: ['utils.js', 'orderdb.js'] });

  // createCacheIndicator no longer takes an options object with
  // onDelete/onAfterDelete callbacks — just the order number.
  assert.equal(sandbox.createCacheIndicator.length, 1);

  const indicator = sandbox.createCacheIndicator('123456789');
  assert.equal(indicator.title, 'Full invoice saved on this device');
  assert.doesNotMatch(indicator.title.toLowerCase(), /delete/);

  // The old per-order/bulk chrome.storage invoice-cache deletion helpers
  // are gone entirely — the ONLY way to remove saved data is now Settings'
  // "Delete all saved data" (OrderDb.clearAll).
  assert.equal(sandbox.deleteInvoiceCache, undefined);
  assert.equal(sandbox.clearAllInvoiceCache, undefined);
});

test('CONSTANTS.MESSAGES: CLEAR_CACHE is gone, replaced by RESET_SESSION_STATE', () => {
  const sandbox = loadSandbox({ scripts: ['utils.js'] });
  const messages = evalIn(sandbox, 'CONSTANTS.MESSAGES');
  assert.equal(messages.CLEAR_CACHE, undefined);
  assert.equal(messages.RESET_SESSION_STATE, 'resetSessionState');
});
