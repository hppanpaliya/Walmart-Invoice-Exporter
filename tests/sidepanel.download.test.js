'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { loadSandbox, evalIn } = require('./helpers/sandbox');
const { captureDownloads, blobBuffer } = require('./helpers/capture-downloads');

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

/**
 * Legacy Excel toggle routing (design spec §5.3): exportCombinedOrders /
 * exportOneOrder (exposed on Sidepanel.download for exactly this purpose)
 * must pick convert*Legacy over the default writer when app.legacyExcel is
 * true and the format is Excel, and must leave every other format alone.
 * The legacy converters' own output shape is pinned in
 * tests/legacy-excel.test.js — these tests only pin the ROUTING decision.
 */
function loadRoutingSandbox({ legacyExcel, exportFormat }) {
  const sandbox = loadDownloadSandbox();
  // exportCombinedOrders/exportOneOrder read the bare `ExcelJS` global (the
  // real page loads it via <script src="exceljs.bare.min.js">); the sandbox
  // only stubs it as `{}`, so swap in the real, host-side library.
  sandbox.ExcelJS = ExcelJS;
  sandbox.window.Sidepanel.state.app.legacyExcel = Boolean(legacyExcel);
  sandbox.window.Sidepanel.state.app.exportFormat = exportFormat;
  return sandbox;
}

test('legacy toggle routing: legacyExcel=false (default) keeps the Orders+Items writer for exportCombinedOrders', async () => {
  const sandbox = loadRoutingSandbox({ legacyExcel: false, exportFormat: 'xlsx' });
  const downloads = captureDownloads(sandbox);

  await sandbox.window.Sidepanel.download.exportCombinedOrders([sampleInvoice()], 'Test');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(blobBuffer(downloads[0].blob));
  assert.deepEqual(workbook.worksheets.map((w) => w.name), ['Orders', 'Items']);
});

test('legacy toggle routing: legacyExcel=true selects the legacy single-sheet writer for exportCombinedOrders', async () => {
  const sandbox = loadRoutingSandbox({ legacyExcel: true, exportFormat: 'xlsx' });
  const downloads = captureDownloads(sandbox);

  await sandbox.window.Sidepanel.download.exportCombinedOrders([sampleInvoice()], 'Test');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(blobBuffer(downloads[0].blob));
  assert.deepEqual(
    workbook.worksheets.map((w) => w.name),
    ['Walmart Orders'],
    'legacyExcel=true must route through convertMultipleOrdersToXlsxLegacy'
  );
});

test('legacy toggle routing: legacyExcel=true selects the legacy writer for exportOneOrder too (no frozen-header polish)', async () => {
  const legacySandbox = loadRoutingSandbox({ legacyExcel: true, exportFormat: 'xlsx' });
  const legacyDownloads = captureDownloads(legacySandbox);
  await legacySandbox.window.Sidepanel.download.exportOneOrder(sampleInvoice());
  const legacyWorkbook = new ExcelJS.Workbook();
  await legacyWorkbook.xlsx.load(blobBuffer(legacyDownloads[0].blob));
  const legacySheet = legacyWorkbook.worksheets[0];
  assert.equal(legacySheet.name, 'Order Invoice');
  assert.ok(
    !legacySheet.views || legacySheet.views.length === 0,
    'legacy single-order writer skips polishWorksheet (no frozen header)'
  );

  const defaultSandbox = loadRoutingSandbox({ legacyExcel: false, exportFormat: 'xlsx' });
  const defaultDownloads = captureDownloads(defaultSandbox);
  await defaultSandbox.window.Sidepanel.download.exportOneOrder(sampleInvoice());
  const defaultWorkbook = new ExcelJS.Workbook();
  await defaultWorkbook.xlsx.load(blobBuffer(defaultDownloads[0].blob));
  const defaultSheet = defaultWorkbook.worksheets[0];
  assert.equal(defaultSheet.name, 'Order Invoice');
  assert.ok(defaultSheet.views.length > 0, 'default writer calls polishWorksheet (frozen header)');
});

test('legacy toggle routing: legacyExcel=true is ignored for non-Excel formats (CSV still exports normally)', async () => {
  const sandbox = loadRoutingSandbox({ legacyExcel: true, exportFormat: 'csv' });
  const downloads = captureDownloads(sandbox);

  await sandbox.window.Sidepanel.download.exportCombinedOrders([sampleInvoice()], 'Test');

  // Generic CSV preset writes an orders file + a companion items file —
  // the point here is just that it's still plain CSV, unaffected by the
  // Excel-only legacy toggle (no .xlsx / no "Walmart Orders" sheet).
  assert.equal(downloads.length, 2);
  downloads.forEach((download) => {
    assert.match(download.filename, /\.csv$/, 'CSV format must ignore the Excel-only legacy toggle');
  });
});
