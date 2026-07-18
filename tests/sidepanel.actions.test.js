'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, evalIn } = require('./helpers/sandbox');

function loadActionsSandbox() {
  return loadSandbox({
    scripts: ['utils.js', 'orderdb.js', 'sidepanel.state.js', 'sidepanel.view.js', 'sidepanel.actions.js'],
  });
}

/**
 * Same as loadActionsSandbox plus the provider registry, a second (opt-in)
 * adapter, flags, and the Sidepanel.providers contract module — the pieces
 * the provider-scoped list, the combined "All providers" view, and the
 * tab-independent collection paths read.
 */
function loadProviderAwareSandbox() {
  return loadSandbox({
    scripts: [
      'utils.js',
      'orderdb.js',
      'providers/base.js',
      'providers/registry.js',
      'providers/walmart-us.js',
      'providers/amazon.js',
      'flags.js',
      'sidepanel.providers.js',
      'sidepanel.state.js',
      'sidepanel.view.js',
      'sidepanel.actions.js',
    ],
  });
}

/** Replace Sidepanel.view.displayOrderNumbers with a spy; returns the recorded calls. */
function spyOnDisplayOrderNumbers(sandbox) {
  const calls = [];
  sandbox.window.Sidepanel.view.displayOrderNumbers = (orderNumbers, additionalFields) => {
    calls.push({ orderNumbers: [...orderNumbers], additionalFields: { ...(additionalFields || {}) } });
    return Promise.resolve();
  };
  return calls;
}

test('displayOrdersFromDb: renders DB history sorted by order date, newest first', async () => {
  const sandbox = loadActionsSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putSummaries(
    {
      '1': { orderDate: '2026-01-01T00:00:00.000Z' },
      '2': { orderDate: '2026-03-01T00:00:00.000Z' },
    },
    { '1': 'January order' }
  );
  const calls = spyOnDisplayOrderNumbers(sandbox);

  const shown = await sandbox.window.Sidepanel.actions.displayOrdersFromDb(null);

  assert.equal(shown, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].orderNumbers, ['2', '1'], 'March order (newer) must lead');
  assert.equal(calls[0].additionalFields['1'], 'January order');
});

test('displayOrdersFromDb: an empty DB CLEARS the list and reports false (no stale rows linger)', async () => {
  const sandbox = loadActionsSandbox();
  const calls = spyOnDisplayOrderNumbers(sandbox);

  const shown = await sandbox.window.Sidepanel.actions.displayOrdersFromDb(null);

  assert.equal(shown, false);
  // Explicitly clears any rows still on screen — this is what makes "Delete
  // all saved data" take effect immediately instead of lingering until reopen.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].orderNumbers, []);
});

test('displayOrdersFromDb: overlays in-progress session order numbers not yet persisted to the DB (spec §4.3)', async () => {
  const sandbox = loadActionsSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putSummaries({ '1': { orderDate: '2026-01-01T00:00:00.000Z' } }, {});
  const calls = spyOnDisplayOrderNumbers(sandbox);

  const shown = await sandbox.window.Sidepanel.actions.displayOrdersFromDb({
    orderNumbers: ['1', '2'], // '1' is already in the DB, '2' was just found this session
    additionalFields: { '2': 'Fresh order title' },
  });

  assert.equal(shown, true);
  assert.deepEqual(calls[0].orderNumbers, ['2', '1'], 'newly-found order surfaces immediately, ahead of DB history');
  assert.equal(calls[0].additionalFields['2'], 'Fresh order title');
});

test('displayOrdersFromDb: the overlay never duplicates an order the DB already has', async () => {
  const sandbox = loadActionsSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putSummaries({ '1': { orderDate: '2026-01-01T00:00:00.000Z' } }, { '1': 'DB title' });
  const calls = spyOnDisplayOrderNumbers(sandbox);

  await sandbox.window.Sidepanel.actions.displayOrdersFromDb({
    orderNumbers: ['1'],
    additionalFields: { '1': 'Session title (must not win)' },
  });

  assert.deepEqual(calls[0].orderNumbers, ['1']);
  assert.equal(calls[0].additionalFields['1'], 'DB title', 'the DB record stays authoritative for a known order');
});

test('displayOrdersFromDb: an empty DB still shows a fresh collection\'s live progress via the overlay', async () => {
  const sandbox = loadActionsSandbox();
  const calls = spyOnDisplayOrderNumbers(sandbox);

  const shown = await sandbox.window.Sidepanel.actions.displayOrdersFromDb({
    orderNumbers: ['9'],
    additionalFields: {},
  });

  assert.equal(shown, true);
  assert.deepEqual(calls[0].orderNumbers, ['9']);
});

test('renderOrderList: falls back to the raw GET_PROGRESS numbers when the DB read itself fails', async () => {
  const sandbox = loadActionsSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  OrderDb.getAllOrders = () => Promise.reject(new Error('indexedDB unavailable in this simulated failure'));
  const calls = spyOnDisplayOrderNumbers(sandbox);

  await sandbox.window.Sidepanel.actions.renderOrderList({
    orderNumbers: ['42'],
    additionalFields: { '42': 'Still shown despite the DB error' },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].orderNumbers, ['42']);
});

test('renderOrderList: a null/empty GET_PROGRESS response with an empty DB renders nothing (no throw)', async () => {
  const sandbox = loadActionsSandbox();
  const calls = spyOnDisplayOrderNumbers(sandbox);

  await sandbox.window.Sidepanel.actions.renderOrderList({ orderNumbers: [], additionalFields: {} });

  // Clears to empty (one call with no orders) rather than leaving stale rows.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].orderNumbers, []);
});

// ---------------------------------------------------------------------------
// Active-provider scoping (the header dropdown drives app.provider; every
// read below must honor it) and tab-independence.
// ---------------------------------------------------------------------------

test('displayOrdersFromDb: reads ONLY the active provider\'s OrderDb partition', async () => {
  const sandbox = loadProviderAwareSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putSummaries({ w1: { orderDate: '2026-01-01T00:00:00.000Z' } }, {}, 'WALMART_US');
  await OrderDb.putSummaries({ a1: { orderDate: '2026-02-01T00:00:00.000Z' } }, {}, 'AMAZON');
  sandbox.window.Sidepanel.state.app.provider = 'AMAZON';
  const calls = spyOnDisplayOrderNumbers(sandbox);

  const shown = await sandbox.window.Sidepanel.actions.displayOrdersFromDb(null);

  assert.equal(shown, true);
  assert.deepEqual(calls[0].orderNumbers, ['a1'], 'Walmart records must not leak into the Amazon view');
});

test('displayOrdersFromDb: the combined "All providers" view unions every enabled provider\'s records', async () => {
  const sandbox = loadProviderAwareSandbox();
  // Opt Amazon in (flags live under settings.flags) so scopeIds(ALL) includes it.
  await new Promise((resolve) =>
    sandbox.chrome.storage.local.set({ settings: { flags: { 'provider.amazon': true } } }, resolve)
  );
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putSummaries({ w1: { orderDate: '2026-01-01T00:00:00.000Z' } }, {}, 'WALMART_US');
  await OrderDb.putSummaries({ a1: { orderDate: '2026-02-01T00:00:00.000Z' } }, {}, 'AMAZON');
  const providers = sandbox.window.Sidepanel.providers;
  sandbox.window.Sidepanel.state.app.provider = providers.PROVIDER_ALL;
  const calls = spyOnDisplayOrderNumbers(sandbox);

  const shown = await sandbox.window.Sidepanel.actions.displayOrdersFromDb(null);

  assert.equal(shown, true);
  assert.deepEqual(calls[0].orderNumbers, ['a1', 'w1'], 'both providers\' records, newest first');
});

test('displayOrdersFromDb: another provider\'s in-flight collection never overlays into this view', async () => {
  const sandbox = loadProviderAwareSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putSummaries({ a1: { orderDate: '2026-02-01T00:00:00.000Z' } }, {}, 'AMAZON');
  const app = sandbox.window.Sidepanel.state.app;
  app.provider = 'AMAZON';
  app.collectionProvider = 'WALMART_US'; // a Walmart crawl is what's running
  const calls = spyOnDisplayOrderNumbers(sandbox);

  await sandbox.window.Sidepanel.actions.displayOrdersFromDb({
    orderNumbers: ['w9'],
    additionalFields: { w9: 'Walmart order mid-crawl' },
  });

  assert.deepEqual(calls[0].orderNumbers, ['a1'], 'the Walmart overlay must not bleed into the Amazon view');
});

test('renderOrderList: a foreign provider\'s raw progress numbers are not rendered as a fallback either', async () => {
  const sandbox = loadProviderAwareSandbox();
  const app = sandbox.window.Sidepanel.state.app;
  app.provider = 'AMAZON'; // empty Amazon partition
  app.collectionProvider = 'WALMART_US';
  const calls = spyOnDisplayOrderNumbers(sandbox);

  await sandbox.window.Sidepanel.actions.renderOrderList({
    orderNumbers: ['w9'],
    additionalFields: {},
    isCollecting: true,
  });

  // The foreign crawl's numbers are NOT rendered; the Amazon view is cleared
  // to empty (one call, no orders) rather than showing 'w9'.
  assert.equal(calls.length, 1, 'an empty Amazon view stays empty while a Walmart crawl runs');
  assert.deepEqual(calls[0].orderNumbers, []);
});

test('handleStartCollection: never blocked off-tab — Walmart falls back to its orders-list URL (tab-independence)', async () => {
  const sandbox = loadProviderAwareSandbox();
  const app = sandbox.window.Sidepanel.state.app;
  app.currentOrdersUrl = null; // NOT on walmart.com/orders — the old flow bailed out here
  const sent = [];
  sandbox.chrome.runtime.sendMessage = (message) => {
    sent.push(message);
  };

  sandbox.window.Sidepanel.actions.handleStartCollection();

  assert.equal(sent.length, 1, 'collection must start instead of showing a blocking warning');
  assert.equal(sent[0].action, evalIn(sandbox, 'CONSTANTS.MESSAGES.START_COLLECTION'));
  assert.equal(sent[0].url, evalIn(sandbox, 'CONSTANTS.URLS.WALMART_ORDERS'));
  assert.equal(sent[0].provider, 'WALMART_US');
  assert.equal(app.collectionProvider, 'WALMART_US', 'the run is scoped for the progress guard');
});

test('handleStartCollection: a non-Walmart provider collects via its own ordersListUrl from ANY tab', async () => {
  const sandbox = loadProviderAwareSandbox();
  const app = sandbox.window.Sidepanel.state.app;
  app.provider = 'AMAZON';
  app.currentOrdersUrl = null;
  const sent = [];
  sandbox.chrome.runtime.sendMessage = (message) => {
    sent.push(message);
  };

  sandbox.window.Sidepanel.actions.handleStartCollection();

  const amazonUrl = evalIn(sandbox, "ProviderRegistry.getById('AMAZON').ordersListUrl");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, amazonUrl, 'the background worker opens the adapter\'s own orders list');
  assert.equal(sent[0].provider, 'AMAZON');
  assert.equal(app.collectionProvider, 'AMAZON');
});

test('checkCurrentTab: off the Walmart tab the panel renders saved data with the UI ENABLED (no blocking warning)', async () => {
  const sandbox = loadActionsSandbox();
  const sent = [];
  sandbox.chrome.runtime.sendMessage = (message) => {
    sent.push(message);
  };
  let uiEnabled = null;
  sandbox.window.Sidepanel.view.setUIEnabled = (enabled) => {
    uiEnabled = enabled;
  };

  // The sandbox's tabs.query answers with [] — no Walmart orders tab anywhere.
  sandbox.window.Sidepanel.actions.checkCurrentTab();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(uiEnabled, true, 'the old flow disabled the whole card off-tab; it must stay enabled now');
  assert.equal(
    sent.some((message) => message.action === evalIn(sandbox, 'CONSTANTS.MESSAGES.GET_PROGRESS')),
    true,
    'saved orders render from the DB/progress instead of a blocking "go to Walmart" warning'
  );
});
