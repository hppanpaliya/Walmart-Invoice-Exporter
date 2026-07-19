'use strict';

/**
 * Local MCP bridge (public/mcp-bridge.js): the read-only tool handlers the
 * background answers over the localhost relay socket, exercised directly
 * against the real OrderDb (fake IndexedDB) — no WebSocket involved. The
 * socket lifecycle itself is deliberately untested here (it needs a live
 * relay; the walmart-invoice-mcp repo's e2e covers the full wire).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, evalIn, toPlain } = require('./helpers/sandbox');

function loadBridge() {
  return loadSandbox({
    scripts: [
      'utils.js',
      'providers/base.js',
      'providers/registry.js',
      'providers/walmart-us.js',
      'providers/walmart-ca.js',
      'flags.js',
      'orderdb.js',
      'mcp-bridge.js',
    ],
  });
}

const summ = (iso, extra = {}) => ({ orderDate: iso, source: 'payload', ...extra });

test('bridge stays dormant by default: disabled, no socket, no pairing', () => {
  const sandbox = loadBridge();
  const state = evalIn(sandbox, 'McpBridge._state');
  assert.equal(state.config.enabled, false);
  assert.equal(state.socket, null);
  assert.equal(state.paired, false);
});

test('clampPort falls back to the default for junk and out-of-range values', () => {
  const sandbox = loadBridge();
  const clampPort = evalIn(sandbox, 'McpBridge.clampPort');
  const DEFAULT_PORT = evalIn(sandbox, 'CONSTANTS.MCP_BRIDGE.DEFAULT_PORT');
  assert.equal(clampPort(9000), 9000);
  assert.equal(clampPort('nope'), DEFAULT_PORT);
  assert.equal(clampPort(80), DEFAULT_PORT); // below MIN_PORT
  assert.equal(clampPort(70000), DEFAULT_PORT);
  assert.equal(clampPort(undefined), DEFAULT_PORT);
});

test('ping and get_status report version and per-provider stats', async () => {
  const sandbox = loadBridge();
  const TOOLS = evalIn(sandbox, 'McpBridge.TOOLS');
  const OrderDb = evalIn(sandbox, 'OrderDb');

  await OrderDb.putSummaries({ o1: summ('2026-01-05T00:00:00.000Z') }, {}, 'WALMART_US');

  const ping = toPlain(await TOOLS.ping());
  assert.equal(ping.ok, true);
  assert.equal(ping.version, '0.0.0-test');

  const status = toPlain(await TOOLS.get_status());
  assert.equal(status.providers.WALMART_US.orders, 1);
  assert.equal(status.providers.WALMART_US.invoices, 0);
});

test('list_orders returns compact rows, newest first, with paging and date filters', async () => {
  const sandbox = loadBridge();
  const TOOLS = evalIn(sandbox, 'McpBridge.TOOLS');
  const OrderDb = evalIn(sandbox, 'OrderDb');

  await OrderDb.putSummaries(
    {
      jan: summ('2026-01-05T00:00:00.000Z', { orderTotal: 10.5, items: [{ name: 'a' }] }),
      mar: summ('2026-03-10T00:00:00.000Z', { orderTotal: 22 }),
      feb: summ('2026-02-20T00:00:00.000Z'),
    },
    { jan: 'January order' },
    'WALMART_US'
  );

  const all = toPlain(await TOOLS.list_orders({}));
  assert.equal(all.total, 3);
  assert.deepEqual(all.orders.map((o) => o.orderNumber), ['mar', 'feb', 'jan']);
  const janRow = all.orders[2];
  assert.equal(janRow.orderDate, '2026-01-05');
  assert.equal(janRow.title, 'January order');
  assert.equal(janRow.total, 10.5);
  assert.equal(janRow.itemCount, 1);
  assert.equal(janRow.hasInvoice, false);

  const paged = toPlain(await TOOLS.list_orders({ limit: 1, offset: 1 }));
  assert.deepEqual(paged.orders.map((o) => o.orderNumber), ['feb']);

  const ranged = toPlain(await TOOLS.list_orders({ since: '2026-02-01', until: '2026-02-28' }));
  assert.deepEqual(ranged.orders.map((o) => o.orderNumber), ['feb']);
});

test('get_order returns the full stored record; unknown order/provider are clean errors', async () => {
  const sandbox = loadBridge();
  const TOOLS = evalIn(sandbox, 'McpBridge.TOOLS');
  const OrderDb = evalIn(sandbox, 'OrderDb');

  await OrderDb.putSummaries({ o9: summ('2026-04-01T00:00:00.000Z') }, {}, 'WALMART_US', 'ACCT_A');

  const found = toPlain(await TOOLS.get_order({ orderNumber: 'o9' }));
  assert.equal(found.order.orderNumber, 'o9');
  assert.equal(found.order.accountKey, 'ACCT_A');

  await assert.rejects(() => TOOLS.get_order({ orderNumber: 'nope' }), /No saved order/);
  await assert.rejects(() => TOOLS.get_order({}), /orderNumber is required/);
  await assert.rejects(() => TOOLS.list_orders({ provider: 'TARGET' }), /Unknown provider/);
});

test('search_orders matches item names case-insensitively and reports matchedItems', async () => {
  const sandbox = loadBridge();
  const TOOLS = evalIn(sandbox, 'McpBridge.TOOLS');
  const OrderDb = evalIn(sandbox, 'OrderDb');

  await OrderDb.putSummaries(
    {
      o1: summ('2026-01-05T00:00:00.000Z', { items: [{ name: 'Ninja Air Fryer' }, { name: 'Paper towels' }] }),
      o2: summ('2026-02-05T00:00:00.000Z', { items: [{ name: 'Bananas' }] }),
    },
    {},
    'WALMART_US'
  );

  const hits = toPlain(await TOOLS.search_orders({ query: 'AIR fryer' }));
  assert.equal(hits.total, 1);
  assert.equal(hits.orders[0].orderNumber, 'o1');
  assert.deepEqual(hits.orders[0].matchedItems, ['Ninja Air Fryer']);

  const byNumber = toPlain(await TOOLS.search_orders({ query: 'o2' }));
  assert.equal(byNumber.total, 1);

  await assert.rejects(() => TOOLS.search_orders({}), /query is required/);
});

test('spending_summary totals parseable amounts and buckets by month', async () => {
  const sandbox = loadBridge();
  const TOOLS = evalIn(sandbox, 'McpBridge.TOOLS');
  const OrderDb = evalIn(sandbox, 'OrderDb');

  await OrderDb.putSummaries(
    {
      j1: summ('2026-01-05T00:00:00.000Z', { orderTotal: '$10.50' }),
      j2: summ('2026-01-20T00:00:00.000Z', { orderTotal: 4.5 }),
      f1: summ('2026-02-01T00:00:00.000Z', { orderTotal: '$1,000.00' }),
      f2: summ('2026-02-02T00:00:00.000Z', { orderTotal: 'unavailable' }),
    },
    {},
    'WALMART_US'
  );

  const summary = toPlain(await TOOLS.spending_summary({}));
  assert.equal(summary.orders, 4);
  assert.equal(summary.totalSpent, 1015);
  assert.deepEqual(summary.months.map((m) => m.month), ['2026-02', '2026-01']);
  assert.equal(summary.months[0].total, 1000);
  assert.equal(summary.months[0].orders, 2);
  assert.equal(summary.months[1].total, 15);
  assert.match(summary.note, /1 order/);

  const scoped = toPlain(await TOOLS.spending_summary({ since: '2026-02-01' }));
  assert.equal(scoped.orders, 2);
});

test('export_orders scopes by date and can omit invoices', async () => {
  const sandbox = loadBridge();
  const TOOLS = evalIn(sandbox, 'McpBridge.TOOLS');
  const OrderDb = evalIn(sandbox, 'OrderDb');

  await OrderDb.putSummaries(
    {
      e1: summ('2026-01-05T00:00:00.000Z', { orderTotal: 1 }),
      e2: summ('2026-03-05T00:00:00.000Z', { orderTotal: 2 }),
    },
    {},
    'WALMART_US'
  );
  await OrderDb.putInvoice('e1', { items: [{ name: 'thing' }] }, 'WALMART_US');

  const all = toPlain(await TOOLS.export_orders({}));
  assert.equal(all.total, 2);
  assert.deepEqual(all.orders.map((o) => o.orderNumber), ['e2', 'e1']);
  assert.ok(all.orders[1].invoice);
  assert.ok(all.orders[1].summary);

  const lean = toPlain(await TOOLS.export_orders({ includeInvoices: false, until: '2026-02-01' }));
  assert.equal(lean.total, 1);
  assert.equal(lean.orders[0].orderNumber, 'e1');
  assert.equal('invoice' in lean.orders[0], false);
});

test('parseMoneyCents handles strings, numbers, and junk', () => {
  const sandbox = loadBridge();
  const parseMoneyCents = evalIn(sandbox, 'McpBridge.parseMoneyCents');
  assert.equal(parseMoneyCents('$62.93'), 6293);
  assert.equal(parseMoneyCents('$1,234.56'), 123456);
  assert.equal(parseMoneyCents(10.5), 1050);
  assert.equal(parseMoneyCents('unavailable'), null);
  assert.equal(parseMoneyCents(''), null);
  assert.equal(parseMoneyCents(null), null);
});

test('action tools are gated: read-only by default, clear error message', async () => {
  const sandbox = loadBridge();
  const TOOLS = evalIn(sandbox, 'McpBridge.TOOLS');

  for (const call of [
    () => TOOLS.start_collection({}),
    () => TOOLS.stop_collection(),
    () => TOOLS.collect_invoices({}),
    () => TOOLS.cancel_invoice_job(),
  ]) {
    await assert.rejects(call, /read-only by default/);
  }

  // Reads stay available regardless of the toggle.
  const progress = toPlain(await TOOLS.get_collection_progress());
  assert.equal(progress.isCollecting, false);
  const job = toPlain(await TOOLS.get_invoice_job());
  assert.equal(job.running, false);
});

test('with actions allowed: start_collection needs the engine, collect_invoices no-ops when done', async () => {
  const sandbox = loadBridge();
  const TOOLS = evalIn(sandbox, 'McpBridge.TOOLS');
  const OrderDb = evalIn(sandbox, 'OrderDb');
  // Let init()'s async applyConfig settle before granting actions, or the
  // freshly-read (all-false) config would overwrite the grant.
  await new Promise((resolve) => setTimeout(resolve, 10));
  evalIn(sandbox, 'chrome.storage.local.set({ mcpBridgeAllowActions: true })');
  evalIn(sandbox, 'McpBridge._state').config.allowActions = true;

  // background-main.js isn't loaded in the sandbox → engine unavailable.
  await assert.rejects(() => TOOLS.start_collection({}), /Collection engine unavailable/);

  // Every order already has its invoice → nothing to fetch, no tab opened.
  await OrderDb.putSummaries({ done1: summ('2026-01-05T00:00:00.000Z') }, {}, 'WALMART_US');
  await OrderDb.putInvoice('done1', { items: [] }, 'WALMART_US');
  const result = toPlain(await TOOLS.collect_invoices({}));
  assert.equal(result.started, false);
  assert.match(result.note, /Nothing to do/);
});

test('list_accounts surfaces per-account summaries', async () => {
  const sandbox = loadBridge();
  const TOOLS = evalIn(sandbox, 'McpBridge.TOOLS');
  const OrderDb = evalIn(sandbox, 'OrderDb');

  await OrderDb.putSummaries({ a1: summ('2026-01-01T00:00:00.000Z') }, {}, 'WALMART_US', 'ACCT_A');
  await OrderDb.putSummaries({ b1: summ('2026-02-01T00:00:00.000Z') }, {}, 'WALMART_US', 'ACCT_B');

  const { accounts } = toPlain(await TOOLS.list_accounts());
  assert.deepEqual(accounts.map((a) => a.accountKey).sort(), ['ACCT_A', 'ACCT_B']);
  assert.equal(accounts.find((a) => a.accountKey === 'ACCT_A').orderCount, 1);
});
