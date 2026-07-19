'use strict';

/**
 * OrderDb per-account scoping (multi-account support): records are tagged with a
 * hashed account key at collection time, and getAllOrders(provider, accountKey)
 * returns only that account's records (plus untagged legacy, grandfathered).
 * stampUntaggedAccount migrates untagged records into an account.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, evalIn } = require('./helpers/sandbox');

function loadDb() {
  return loadSandbox({ scripts: ['utils.js', 'orderdb.js'] });
}

const summ = (iso) => ({ orderDate: iso });

test('getAllOrders scopes to one account; a different account is hidden', async () => {
  const sandbox = loadDb();
  const OrderDb = evalIn(sandbox, 'OrderDb');

  await OrderDb.putSummaries({ a1: summ('2026-01-01T00:00:00.000Z') }, {}, 'WALMART_US', 'ACCT_A');
  await OrderDb.putSummaries({ b1: summ('2026-02-01T00:00:00.000Z') }, {}, 'WALMART_US', 'ACCT_B');

  const forA = await OrderDb.getAllOrders('WALMART_US', 'ACCT_A');
  assert.deepEqual(forA.map((r) => r.orderNumber), ['a1'], "account A sees only A's orders");

  const forB = await OrderDb.getAllOrders('WALMART_US', 'ACCT_B');
  assert.deepEqual(forB.map((r) => r.orderNumber).sort(), ['b1']);

  // No account key → no filter → everything.
  const all = await OrderDb.getAllOrders('WALMART_US', null);
  assert.deepEqual(all.map((r) => r.orderNumber).sort(), ['a1', 'b1']);
});

test('untagged (legacy) records are grandfathered — shown for any account until stamped', async () => {
  const sandbox = loadDb();
  const OrderDb = evalIn(sandbox, 'OrderDb');

  // Legacy record with no accountKey (4th arg omitted).
  await OrderDb.putSummaries({ old1: summ('2025-12-01T00:00:00.000Z') }, {}, 'WALMART_US');
  await OrderDb.putSummaries({ a1: summ('2026-01-01T00:00:00.000Z') }, {}, 'WALMART_US', 'ACCT_A');

  // Filtering by A shows A's own + the untagged legacy one.
  const forA = await OrderDb.getAllOrders('WALMART_US', 'ACCT_A');
  assert.deepEqual(forA.map((r) => r.orderNumber).sort(), ['a1', 'old1']);

  // Grandfather untagged into A → now it belongs to A, hidden from B.
  const tagged = await OrderDb.stampUntaggedAccount('WALMART_US', 'ACCT_A');
  assert.equal(tagged, 1);
  const forB = await OrderDb.getAllOrders('WALMART_US', 'ACCT_B');
  assert.deepEqual(forB.map((r) => r.orderNumber), [], 'B sees nothing after legacy is absorbed into A');
});

test('a known account tag is never blanked out by a later untagged write', async () => {
  const sandbox = loadDb();
  const OrderDb = evalIn(sandbox, 'OrderDb');

  await OrderDb.putSummaries({ a1: summ('2026-01-01T00:00:00.000Z') }, {}, 'WALMART_US', 'ACCT_A');
  // A later summary write for the same order without an account key must keep A.
  await OrderDb.putSummaries({ a1: summ('2026-01-01T00:00:00.000Z') }, {}, 'WALMART_US', null);

  const forA = await OrderDb.getAllOrders('WALMART_US', 'ACCT_A');
  assert.deepEqual(forA.map((r) => r.orderNumber), ['a1']);
  const forB = await OrderDb.getAllOrders('WALMART_US', 'ACCT_B');
  assert.deepEqual(forB.map((r) => r.orderNumber), []);
});
