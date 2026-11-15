/**
 * Local MCP bridge (public/mcp-bridge.js): the read-only tool handlers the
 * background answers over the localhost relay socket, exercised directly
 * against the real OrderDb (fake IndexedDB) — no WebSocket involved. The
 * socket lifecycle itself is deliberately untested here (it needs a live
 * relay; the walmart-invoice-mcp repo's e2e covers the full wire).
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadSandbox, evalIn, toPlain } from './helpers/sandbox';

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

test('bridge summaries prefer current invoices and preserve explicit zero totals', async () => {
  const sandbox = loadBridge();
  const db = evalIn(sandbox, 'OrderDb');
  const tools = evalIn(sandbox, 'McpBridge.TOOLS');
  await db.putSummaries({ o1: summ('2026-04-01', { orderTotal: '$99.00' }) }, {});
  await db.putInvoice('o1', { schemaVersion: 3, orderTotal: 0, items: [{ productName: 'Test', price: 0 }] });
  const result = await tools.spending_summary();
  assert.equal(result.totalSpent, 0);
  assert.equal((await tools.list_orders()).orders[0].total, 0);
});

async function socketBridge() {
  const s = loadSandbox({ scripts: ['utils.js', 'orderdb.js'] });
  const sockets = [];
  let changed;
  s.setInterval = () => 1;
  s.clearInterval = () => {};
  s.chrome.storage.onChanged.addListener = fn => { changed = fn; };
  s.WebSocket = class {
    static OPEN = 1;
    constructor() { this.readyState = 1; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() {}
  };
  const keys = evalIn(s, 'CONSTANTS.STORAGE_KEYS');
  s.chrome.storage.local.set({ [keys.MCP_BRIDGE_ENABLED]: true, [keys.MCP_BRIDGE_TOKEN]: 'test-token' });
  s.importScripts('mcp-bridge.js');
  await new Promise(setImmediate);
  return { s, sockets, keys, changed };
}

test('relay calls require pairing and only registered own tools can run', async () => {
  const { sockets } = await socketBridge();
  const socket = sockets[0];
  socket.onopen();
  socket.onmessage({ data: JSON.stringify({ type: 'call', id: 'early', tool: 'ping' }) });
  await new Promise(setImmediate);
  assert.ok(!socket.sent.some(m => m.type === 'result'), 'unpaired calls cannot access saved data');
  socket.onmessage({ data: JSON.stringify({ type: 'hello_ok' }) });
  socket.onmessage({ data: JSON.stringify({ type: 'call', id: 'ready', tool: 'ping' }) });
  socket.onmessage({ data: JSON.stringify({ type: 'call', id: 'inherited', tool: 'constructor' }) });
  await new Promise(setImmediate);
  assert.equal(socket.sent.find(m => m.id === 'ready').ok, true);
  assert.match(socket.sent.find(m => m.id === 'inherited').error, /Unknown tool/);
});

test('a closed socket from an older configuration cannot disconnect its replacement', async () => {
  const { s, sockets, keys, changed } = await socketBridge();
  const oldSocket = sockets[0];
  s.chrome.storage.local.set({ [keys.MCP_BRIDGE_TOKEN]: 'replacement-token' });
  changed({ [keys.MCP_BRIDGE_TOKEN]: { newValue: 'replacement-token' } }, 'local');
  await new Promise(setImmediate);
  const replacement = sockets[1];
  oldSocket.onclose();
  assert.equal(evalIn(s, 'McpBridge._state.socket'), replacement);
});
