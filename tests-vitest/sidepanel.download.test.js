'use strict';

import { test } from 'vitest';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { loadSandbox, evalIn } from './helpers/sandbox';
import { captureDownloads, blobBuffer } from './helpers/capture-downloads';

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
    walmartExtractionVersion: 3,
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

test('extraction report link prefills actionable, privacy-safe diagnostics', () => {
  const sandbox = loadDownloadSandbox();
  const url = new URL(sandbox.window.Sidepanel.view.buildExtractionReportUrl([
    {
      orderNumber: '200010000000042',
      warnings: [
        'Order total came back empty',
        'Split tender across 2 payment methods, but no per-tender amounts were extracted',
      ],
    },
  ]));

  assert.equal(url.origin + url.pathname, 'https://github.com/hppanpaliya/Walmart-Invoice-Exporter/issues/new');
  assert.match(url.searchParams.get('title'), /2 detected problems/);
  assert.match(url.searchParams.get('body'), /order ending 0042: Order total was missing/);
  assert.match(url.searchParams.get('body'), /amount charged to each was unavailable/);
  assert.doesNotMatch(url.searchParams.get('body'), /200010000000042/, 'a public issue must not expose the full order number');
});

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

test('fetchOrderData: under the combined "All providers" view (app.provider === PROVIDER_ALL) reads/writes the CONCRETE provider partition that owns the order, not the "__ALL__" sentinel', async () => {
  const sandbox = loadDownloadSandbox();

  // The panel would load sidepanel.providers.js; the download sandbox doesn't,
  // so stand in a minimal selector exposing exactly what resolveProviderId
  // needs: the PROVIDER_ALL sentinel and scopeIds() over the enabled providers.
  const PROVIDER_ALL = '__ALL__';
  sandbox.window.Sidepanel.providers = {
    PROVIDER_ALL,
    scopeIds: async (active) =>
      active === PROVIDER_ALL ? ['WALMART_US', 'UBER_EATS'] : [active],
  };
  sandbox.window.Sidepanel.state.app.provider = PROVIDER_ALL;

  // The order lives ONLY in the UBER_EATS partition — the "__ALL__" sentinel is
  // not a real partition, so a direct getOrder(num, "__ALL__") would miss it.
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putInvoice(ORDER_NUMBER, sampleInvoice(), 'UBER_EATS');

  const data = await fetchOrderData(sandbox, ORDER_NUMBER);

  assert.equal(data.orderNumber, ORDER_NUMBER);
  assert.equal(data.orderTotal, '$28.11');
  assert.deepEqual(
    sandbox.chrome.tabs._calls.create,
    [],
    'the combined view must resolve the concrete partition and hit the fast path — no tab'
  );
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

// Regression coverage for incomplete invoices (#36). Exercise the real fetch,
// persistence and queue paths; only the browser/content-script boundary is mocked.
function mockInvoiceResponses(sandbox, respond) {
  sandbox.delay = async () => {};
  const calls = [];
  sandbox.chrome.tabs.sendMessage = (tabId, message, callback) => {
    const action = message.method || message.action;
    const isInvoice = action === 'getOrderData' || action === 'getOrderDataFast';
    if (isInvoice) calls.push({ action, url: sandbox.chrome.tabs._tabsById.get(tabId).url });
    const response = isInvoice ? { data: respond(calls.length, action) } : {};
    if (callback) queueMicrotask(() => callback(response));
  };
  return calls;
}

const FETCH_OPTIONS = { timeoutMs: 2000, stabilizeDelayMs: 0 };

test('incomplete invoice: re-reads the same page before saving delayed invoice content', async () => {
  const sandbox = loadDownloadSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  const writes = [];
  const putInvoice = OrderDb.putInvoice;
  OrderDb.putInvoice = async (...args) => { writes.push(args[1]); return putInvoice(...args); };
  const calls = mockInvoiceResponses(sandbox, (n) => sampleInvoice(n === 1 ? { items: [], orderTotal: '' } : {}));

  const data = await fetchOrderData(sandbox, ORDER_NUMBER, FETCH_OPTIONS);

  assert.equal(data.items.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, calls[1].url, 'wait for hydration before navigating away');
  assert.equal(sandbox.chrome.tabs._calls.update.length, 0);
  assert.equal(writes.length, 1, 'never persist the incomplete first response');
  assert.equal(writes[0].items.length, 1);
});

test('incomplete invoice: tries the alternate URL after two incomplete responses', async () => {
  const sandbox = loadDownloadSandbox();
  const calls = mockInvoiceResponses(sandbox, (n) => sampleInvoice(n <= 2 ? { items: [] } : {}));

  const data = await fetchOrderData(sandbox, ORDER_NUMBER, FETCH_OPTIONS);

  assert.equal(data.items.length, 1);
  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /storePurchase=true/);
});

for (const [reason, overrides] of [
  ['no usable items', { items: [] }],
  ['missing or invalid order total', { orderTotal: '' }],
  ['missing or invalid order total', { orderTotal: 'Unknown' }],
  ['missing or mismatched order number', { orderNumber: '200010000000099' }],
]) {
  test(`incomplete invoice: rejects ${JSON.stringify(overrides)} without caching it`, async () => {
    const sandbox = loadDownloadSandbox();
    const calls = mockInvoiceResponses(sandbox, () => sampleInvoice(overrides));

    await assert.rejects(() => fetchOrderData(sandbox, ORDER_NUMBER, FETCH_OPTIONS), new RegExp(reason));

    assert.equal(calls.length, 4, 'at most two reads per URL');
    const record = await evalIn(sandbox, 'OrderDb').getOrder(ORDER_NUMBER);
    assert.ok(!record?.invoice, 'failed extraction must not create an invoice');
  });
}

test('incomplete invoice: a cached missing total is refetched, never returned as a stale fallback', async () => {
  const sandbox = loadDownloadSandbox();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putInvoice(ORDER_NUMBER, sampleInvoice({ orderTotal: '' }));
  mockInvoiceResponses(sandbox, () => sampleInvoice({ items: [] }));

  await assert.rejects(() => fetchOrderData(sandbox, ORDER_NUMBER, FETCH_OPTIONS), /Incomplete invoice/);

  const stored = await OrderDb.getOrder(ORDER_NUMBER);
  assert.equal(stored.invoice.items.length, 1, 'failed live fetch leaves the old record intact');
  assert.equal(stored.invoice.orderTotal, '');
});

test('incomplete invoice: a bad fast-fetch response falls back to the page without being stored', async () => {
  const sandbox = loadDownloadSandbox();
  sandbox.ProviderRegistry = { getById: () => ({ supportsFastInvoice: true, ordersListUrl: 'https://www.walmart.com/orders' }) };
  sandbox.window.Sidepanel.state.app.fastFetch = true;
  const writes = [];
  const OrderDb = evalIn(sandbox, 'OrderDb');
  const putInvoice = OrderDb.putInvoice;
  OrderDb.putInvoice = async (...args) => { writes.push(args[1]); return putInvoice(...args); };
  const calls = mockInvoiceResponses(sandbox, (_n, action) => sampleInvoice(action === 'getOrderDataFast' ? { items: [] } : {}));

  const data = await fetchOrderData(sandbox, ORDER_NUMBER, FETCH_OPTIONS);

  assert.equal(calls[0].action, 'getOrderDataFast');
  assert.equal(calls[1].action, 'getOrderData');
  assert.equal(data.items.length, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].items.length, 1);
});

test('incomplete invoice: accepts matching long in-store IDs and a real numeric zero total', async () => {
  const sandbox = loadDownloadSandbox();
  const inStoreId = '999999999999999999999';
  mockInvoiceResponses(sandbox, () => sampleInvoice({ orderNumber: inStoreId, orderTotal: 0, items: [{ productName: 'Free sample', quantity: 1, price: 0 }] }));

  const data = await fetchOrderData(sandbox, inStoreId, FETCH_OPTIONS);

  assert.equal(data.orderNumber, inStoreId);
  assert.equal(data.orderTotal, 0);
});

for (const mode of ['multiple', 'single']) {
  test(`incomplete invoice: ${mode} export reports the failed order with Retry failed and produces no empty files`, async () => {
    const sandbox = loadDownloadSandbox();
    const downloads = captureDownloads(sandbox);
    const banners = [];
    const view = sandbox.window.Sidepanel.view;
    for (const name of ['clearStatusBanner', 'showDownloadProgress', 'updateDownloadProgress', 'hideDownloadProgress', 'setButtonLoading', 'updateDownloadButtonsState']) view[name] = () => {};
    view.renderStatusBanner = (id, options) => { banners.push({ id, ...options }); return null; };
    sandbox.window.Sidepanel.state.app.exportFormat = 'csv';
    sandbox.window.Sidepanel.state.app.orderSettleMs = 0;
    mockInvoiceResponses(sandbox, () => sampleInvoice({ items: [] }));

    await sandbox.window.Sidepanel.download.downloadSelectedOrders(mode, [ORDER_NUMBER]);

    assert.equal(downloads.length, 0);
    const result = banners.find((banner) => banner.id === 'downloadResultBanner');
    assert.equal(result.variant, 'danger');
    assert.match(result.message, /0 of 1 exported/);
    assert.ok(result.message.includes(ORDER_NUMBER));
    assert.match(result.actionHtml, /Retry failed/);
    assert.equal(sandbox.window.Sidepanel.state.app.downloadInProgress, false);
  });
}
