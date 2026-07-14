'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, evalIn } = require('./helpers/sandbox');

function loadActionsSandbox() {
  return loadSandbox({
    scripts: ['utils.js', 'orderdb.js', 'sidepanel.state.js', 'sidepanel.view.js', 'sidepanel.actions.js'],
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

test('displayOrdersFromDb: an empty DB with no progress overlay renders nothing and reports false', async () => {
  const sandbox = loadActionsSandbox();
  const calls = spyOnDisplayOrderNumbers(sandbox);

  const shown = await sandbox.window.Sidepanel.actions.displayOrdersFromDb(null);

  assert.equal(shown, false);
  assert.equal(calls.length, 0);
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

  assert.equal(calls.length, 0);
});
