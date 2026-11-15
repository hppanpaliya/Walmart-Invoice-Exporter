'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const endpoint = '/orchestra/cph/graphql/PurchaseHistoryV3/' + 'a'.repeat(64) + '?variables=%7B%7D';
function bridge() {
  const listeners = {};
  const calls = [];
  const replies = [];
  const context = {
    URL, console,
    location: { origin: 'https://www.walmart.com' },
    XMLHttpRequest: function () {},
    addEventListener(type, fn) { listeners[type] = fn; },
    postMessage(msg) { replies.push(msg); },
    async fetch(url, options) {
      calls.push({ url, options });
      return { ok: true, status: 200, clone: () => ({ text: async () => '{}' }),
        json: async () => ({ data: { purchaseHistory: { orders: [] } } }) };
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/walmart-mainworld.js'), 'utf8'), context);
  const dispatch = (url, source = vm.runInContext('window', context)) => listeners.message({ source, data: {
    source: 'WIE_PURCHASE_HISTORY_BRIDGE', type: 'WIE_REPLAY_REQUEST', reqId: 'test', url,
  } });
  return { context, calls, replies, dispatch };
}

test('main-world replay refuses uncaptured credentials and foreign message senders', () => {
  const b = bridge();
  b.dispatch(endpoint, {});
  assert.equal(b.replies.length, 0);
  b.dispatch(endpoint);
  assert.equal(b.replies[0].reason, 'no-headers');
  assert.equal(b.calls.length, 0);
});

test('main-world replay cannot use captured headers for unrelated or normalized traversal routes', async () => {
  const b = bridge();
  await b.context.fetch(endpoint, { headers: { 'x-test': 'synthetic-header' } });
  b.calls.length = 0;
  for (const url of ['https://example.test/orchestra/cph/graphql/PurchaseHistoryV3/' + 'a'.repeat(64),
    '/orchestra/../../account', '/orchestra/orders/graphql/UnrelatedOperation/' + 'a'.repeat(64)]) {
    b.dispatch(url);
    assert.equal(b.replies.at(-1)?.reason, 'bad-url');
  }
  assert.equal(b.calls.length, 0);
});

test('main-world replay preserves captured headers for the legitimate purchase-history request', async () => {
  const b = bridge();
  await b.context.fetch(endpoint, { headers: { 'x-test': 'synthetic-header' } });
  b.dispatch(endpoint);
  await new Promise(setImmediate);
  assert.equal(b.replies.at(-1).ok, true);
  assert.equal(b.calls.at(-1).options.credentials, 'include');
  assert.equal(b.calls.at(-1).options.headers['x-test'], 'synthetic-header');
});
