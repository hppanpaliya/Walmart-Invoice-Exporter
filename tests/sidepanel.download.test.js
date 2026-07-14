'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, evalIn } = require('./helpers/sandbox');

function loadDownloadSandbox() {
  return loadSandbox({
    scripts: [
      'utils.js',
      'orderdb.js',
      'sidepanel.state.js',
      'sidepanel.view.js',
      'sidepanel.download.js',
    ],
  });
}

const ORDER_NUMBER = '200010000000042';

/** A synthetic (never real) current-schema invoice, shaped like the content script's output. */
function sampleInvoice(overrides = {}) {
  return {
    schemaVersion: 3,
    orderNumber: ORDER_NUMBER,
    orderTotal: '$28.11',
    orderDate: '2026-06-01T00:00:00.000Z',
    items: [{ productName: 'Test Widget', quantity: '1', price: '$28.11' }],
    ...overrides,
  };
}

function fetchOrderData(sandbox, orderNumber, options) {
  return sandbox.window.Sidepanel.download.OrderDataFetcher.fetchOrderData(orderNumber, options);
}

test('fetchOrderData: a current-schema invoice already in IndexedDB is returned with NO tab opened (spec §4.2 fast path)', async () => {
  const sandbox = loadDownloadSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putInvoice(ORDER_NUMBER, sampleInvoice());

  const data = await fetchOrderData(sandbox, ORDER_NUMBER);

  assert.equal(data.orderNumber, ORDER_NUMBER);
  assert.equal(data.orderTotal, '$28.11');
  assert.equal(data.items.length, 1);
  assert.deepEqual(sandbox.chrome.tabs._calls.create, [], 'an already-downloaded order must open no tab');
  assert.deepEqual(sandbox.chrome.tabs._calls.get, [], 'nor even look one up');
});

test('fetchOrderData: re-exporting the SAME order twice only opens a tab once (the second call hits the DB)', async () => {
  const sandbox = loadDownloadSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putInvoice(ORDER_NUMBER, sampleInvoice());

  await fetchOrderData(sandbox, ORDER_NUMBER);
  await fetchOrderData(sandbox, ORDER_NUMBER);

  assert.equal(sandbox.chrome.tabs._calls.create.length, 0);
});

test('fetchOrderData: nothing stored yet falls through to the live-fetch path and DOES open a tab', async () => {
  const sandbox = loadDownloadSandbox();

  await assert.rejects(() => fetchOrderData(sandbox, ORDER_NUMBER, { timeoutMs: 50, stabilizeDelayMs: 0 }));

  assert.ok(sandbox.chrome.tabs._calls.create.length > 0, 'must attempt to open a tab when nothing is cached');
});

test('fetchOrderData: a stored invoice older than the current schema version does not satisfy the fast path', async () => {
  const sandbox = loadDownloadSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  // Pre-v3 invoices can contain doubled items with $0.00 prices — never
  // trusted by the fast path. (Both live re-fetch attempts fail in this
  // sandbox — no content script is present — so the existing "never
  // destroy usable data on a failed re-fetch" contract kicks in and the
  // stale record is still returned as a last resort; it is not fabricated
  // or silently upgraded, merely not trusted for the instant, tab-free
  // path.)
  await OrderDb.putInvoice(ORDER_NUMBER, sampleInvoice({ schemaVersion: 2 }));

  const data = await fetchOrderData(sandbox, ORDER_NUMBER, { timeoutMs: 50, stabilizeDelayMs: 0 });

  assert.equal(data.schemaVersion, 2);
  assert.ok(sandbox.chrome.tabs._calls.create.length > 0, 'a stale-schema record must not short-circuit the fetch');
});

test('fetchOrderData: an incomplete stored record (no usable items) does not satisfy the fast path', async () => {
  const sandbox = loadDownloadSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putInvoice(ORDER_NUMBER, sampleInvoice({ items: [] }));

  await assert.rejects(() => fetchOrderData(sandbox, ORDER_NUMBER, { timeoutMs: 50, stabilizeDelayMs: 0 }));

  assert.ok(sandbox.chrome.tabs._calls.create.length > 0);
});

test('fetchFromUrl (via fetchOrderData) persists newly-fetched invoices to OrderDb only — no chrome.storage.local invoice cache', async () => {
  const sandbox = loadDownloadSandbox();

  // Make the live fetch path actually succeed instead of rejecting: the
  // content script's GET_ORDER_DATA response is simulated directly.
  const originalSendMessage = sandbox.chrome.tabs.sendMessage.bind(sandbox.chrome.tabs);
  sandbox.chrome.tabs.sendMessage = (tabId, message, callback) => {
    if (message && message.method === 'getOrderData') {
      sandbox.chrome.tabs._calls.sendMessage.push({ tabId, message });
      if (callback) Promise.resolve().then(() => callback({ data: sampleInvoice() }));
      return;
    }
    originalSendMessage(tabId, message, callback);
  };

  const data = await fetchOrderData(sandbox, ORDER_NUMBER, { timeoutMs: 2000, stabilizeDelayMs: 0 });
  assert.equal(data.orderNumber, ORDER_NUMBER);
  assert.ok(sandbox.chrome.tabs._calls.create.length > 0, 'first fetch must open a tab');

  const OrderDb = evalIn(sandbox, 'OrderDb');
  const stored = await OrderDb.getOrder(ORDER_NUMBER);
  assert.ok(stored && stored.invoice, 'invoice must land in IndexedDB');
  assert.equal(stored.invoice.orderTotal, '$28.11');

  // The old chrome.storage.local invoice cache must never be written.
  const localDump = sandbox.chrome.storage.local._dump();
  assert.equal(localDump.walmart_invoice_cache, undefined);

  // A second fetch for the same order now hits the fast path — no new tab.
  const createCallsBefore = sandbox.chrome.tabs._calls.create.length;
  await fetchOrderData(sandbox, ORDER_NUMBER);
  assert.equal(sandbox.chrome.tabs._calls.create.length, createCallsBefore, 're-fetch must be served from IndexedDB');
});
