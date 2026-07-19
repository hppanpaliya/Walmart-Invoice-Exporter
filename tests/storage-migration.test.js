'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, evalIn } = require('./helpers/sandbox');

function loadMigrationSandbox() {
  return loadSandbox({ scripts: ['utils.js', 'orderdb.js'] });
}

const INVOICE_CACHE_KEY = 'walmart_invoice_cache';
const ORDER_COLLECTION_KEY = 'walmart_order_cache';

function setLocalStorage(sandbox, items) {
  return new Promise((resolve) => sandbox.chrome.storage.local.set(items, resolve));
}

test('migrateLegacyStorage: a surviving invoice-cache entry lands in OrderDb and the legacy key is removed', async () => {
  const sandbox = loadMigrationSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  const invoice = {
    schemaVersion: 3,
    orderNumber: '300010000000099',
    orderTotal: '$45.67',
    items: [{ productName: 'Test Item', quantity: '1', price: '$45.67' }],
  };
  await setLocalStorage(sandbox, {
    [INVOICE_CACHE_KEY]: { '300010000000099': { data: invoice, timestamp: Date.now() } },
  });

  await sandbox.migrateLegacyStorage();

  const stored = await OrderDb.getOrder('300010000000099');
  assert.ok(stored && stored.invoice, 'the invoice must be upserted into OrderDb');
  assert.equal(stored.invoice.orderTotal, '$45.67');

  const dump = sandbox.chrome.storage.local._dump();
  assert.equal(dump[INVOICE_CACHE_KEY], undefined, 'the legacy key must be removed');
});

test('migrateLegacyStorage: folds every surviving entry, not just the first', async () => {
  const sandbox = loadMigrationSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await setLocalStorage(sandbox, {
    [INVOICE_CACHE_KEY]: {
      '1': { data: { schemaVersion: 3, orderNumber: '1', orderTotal: '$1.00', items: [] }, timestamp: Date.now() },
      '2': { data: { schemaVersion: 3, orderNumber: '2', orderTotal: '$2.00', items: [] }, timestamp: Date.now() },
      '3': { data: { schemaVersion: 3, orderNumber: '3', orderTotal: '$3.00', items: [] }, timestamp: Date.now() },
    },
  });

  await sandbox.migrateLegacyStorage();

  const all = await OrderDb.getAllOrders();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((r) => r.orderNumber).sort(), ['1', '2', '3']);
});

test('migrateLegacyStorage: removes walmart_order_cache too, even with no invoice cache present', async () => {
  const sandbox = loadMigrationSandbox();
  await setLocalStorage(sandbox, {
    [ORDER_COLLECTION_KEY]: { orderNumbers: ['1', '2'], timestamp: Date.now() },
  });

  await sandbox.migrateLegacyStorage();

  const dump = sandbox.chrome.storage.local._dump();
  assert.equal(dump[ORDER_COLLECTION_KEY], undefined);
});

test('migrateLegacyStorage: missing keys are safe — no throw, no writes, no unnecessary remove call', async () => {
  const sandbox = loadMigrationSandbox();
  let removeCalled = false;
  const originalRemove = sandbox.chrome.storage.local.remove.bind(sandbox.chrome.storage.local);
  sandbox.chrome.storage.local.remove = (keys, cb) => {
    removeCalled = true;
    originalRemove(keys, cb);
  };

  await assert.doesNotReject(() => sandbox.migrateLegacyStorage());

  assert.equal(removeCalled, false, 'nothing to remove — must not call storage.remove at all');
  const OrderDb = evalIn(sandbox, 'OrderDb');
  const all = await OrderDb.getAllOrders();
  assert.equal(all.length, 0);
});

test('migrateLegacyStorage: is idempotent — a second call is a safe no-op', async () => {
  const sandbox = loadMigrationSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await setLocalStorage(sandbox, {
    [INVOICE_CACHE_KEY]: {
      '1': { data: { schemaVersion: 3, orderNumber: '1', orderTotal: '$1.00', items: [] }, timestamp: Date.now() },
    },
  });

  await sandbox.migrateLegacyStorage();
  await assert.doesNotReject(() => sandbox.migrateLegacyStorage());

  const all = await OrderDb.getAllOrders();
  assert.equal(all.length, 1, 'a repeated migration must not duplicate or corrupt the record');
  assert.equal(sandbox.chrome.storage.local._dump()[INVOICE_CACHE_KEY], undefined);
});

test('migrateLegacyStorage: never touches settings keys', async () => {
  const sandbox = loadMigrationSandbox();
  await setLocalStorage(sandbox, {
    exportMode: 'single',
    exportFormat: 'csv',
    csvPreset: 'xero',
    includeThumbnails: true,
    incrementalCollect: true,
    [INVOICE_CACHE_KEY]: { '1': { data: { schemaVersion: 3, orderNumber: '1', orderTotal: '$1', items: [] } } },
  });

  await sandbox.migrateLegacyStorage();

  const dump = sandbox.chrome.storage.local._dump();
  assert.equal(dump.exportMode, 'single');
  assert.equal(dump.exportFormat, 'csv');
  assert.equal(dump.csvPreset, 'xero');
  assert.equal(dump.includeThumbnails, true);
  assert.equal(dump.incrementalCollect, true);
});

test('migrateLegacyStorage: a malformed/empty invoice-cache entry is skipped, not fatal', async () => {
  const sandbox = loadMigrationSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await setLocalStorage(sandbox, {
    [INVOICE_CACHE_KEY]: {
      'bad-entry': { data: null, timestamp: Date.now() },
      '': { data: { schemaVersion: 3, orderTotal: '$1', items: [] } },
      'good-entry': { data: { schemaVersion: 3, orderNumber: 'good-entry', orderTotal: '$1', items: [] } },
    },
  });

  await assert.doesNotReject(() => sandbox.migrateLegacyStorage());

  const all = await OrderDb.getAllOrders();
  assert.deepEqual(all.map((r) => r.orderNumber), ['good-entry']);
});

test('migrateLegacyStorage: called from both the background worker and sidepanel.js init (function is shared, not duplicated)', () => {
  const bgSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'background-main.js'), 'utf8');
  const panelSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'sidepanel.js'), 'utf8');
  assert.match(bgSource, /migrateLegacyStorage\(\)/);
  assert.match(panelSource, /migrateLegacyStorage\(\)/);
});
