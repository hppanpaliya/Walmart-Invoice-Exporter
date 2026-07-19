'use strict';

/**
 * OrderDb per-account scoping (multi-account support): records are tagged with a
 * hashed account key at collection time, and getAllOrders(provider, accountKey)
 * returns ONLY that account's records. Untagged legacy records live in their own
 * bucket (selected via ACCOUNTS.UNTAGGED) and are never silently merged into a
 * real account — the old grandfather/stamp behaviour leaked and erased data
 * across accounts and has been removed.
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

test('untagged (legacy) records are their own bucket — never leaked into a real account', async () => {
  const sandbox = loadDb();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  const UNTAGGED = evalIn(sandbox, 'CONSTANTS.ACCOUNTS.UNTAGGED');

  // Legacy record with no accountKey (4th arg omitted).
  await OrderDb.putSummaries({ old1: summ('2025-12-01T00:00:00.000Z') }, {}, 'WALMART_US');
  await OrderDb.putSummaries({ a1: summ('2026-01-01T00:00:00.000Z') }, {}, 'WALMART_US', 'ACCT_A');

  // Selecting account A shows ONLY A's orders — the untagged legacy one does
  // NOT leak in (this is the bug fix: no cross-account grandfathering).
  const forA = await OrderDb.getAllOrders('WALMART_US', 'ACCT_A');
  assert.deepEqual(forA.map((r) => r.orderNumber), ['a1']);

  // ...and a different account sees neither A's nor the untagged orders.
  const forB = await OrderDb.getAllOrders('WALMART_US', 'ACCT_B');
  assert.deepEqual(forB.map((r) => r.orderNumber), []);

  // The untagged bucket is reachable on its own via the UNTAGGED sentinel.
  const untagged = await OrderDb.getAllOrders('WALMART_US', UNTAGGED);
  assert.deepEqual(untagged.map((r) => r.orderNumber), ['old1']);
});

test('clearAccount deletes ONE account; others untouched; null clears untagged', async () => {
  const sandbox = loadDb();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putSummaries({ a1: summ('2026-01-01T00:00:00.000Z') }, {}, 'WALMART_US', 'ACCT_A');
  await OrderDb.putSummaries({ b1: summ('2026-02-01T00:00:00.000Z') }, {}, 'WALMART_US', 'ACCT_B');
  await OrderDb.putSummaries({ old1: summ('2025-12-01T00:00:00.000Z') }, {}, 'WALMART_US'); // untagged

  assert.equal(await OrderDb.clearAccount('ACCT_A'), 1);
  assert.deepEqual((await OrderDb.getAllOrders('WALMART_US', null)).map((r) => r.orderNumber).sort(), ['b1', 'old1']);

  // null clears only the untagged bucket.
  assert.equal(await OrderDb.clearAccount(null), 1);
  assert.deepEqual((await OrderDb.getAllOrders('WALMART_US', null)).map((r) => r.orderNumber), ['b1']);
});

test('getAccountSummaries reports per-account counts + newest date', async () => {
  const sandbox = loadDb();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putSummaries(
    { a1: summ('2026-01-01T00:00:00.000Z'), a2: summ('2026-03-01T00:00:00.000Z') },
    {},
    'WALMART_US',
    'ACCT_A'
  );
  await OrderDb.putInvoice('a1', { schemaVersion: 3, orderTotal: '$1', items: [] }, 'WALMART_US', 'ACCT_A');
  await OrderDb.putSummaries({ b1: summ('2026-02-01T00:00:00.000Z') }, {}, 'WALMART_US', 'ACCT_B');

  const summaries = await OrderDb.getAccountSummaries();
  const a = summaries.find((s) => s.accountKey === 'ACCT_A');
  const b = summaries.find((s) => s.accountKey === 'ACCT_B');
  assert.equal(a.orderCount, 2);
  assert.equal(a.invoiceCount, 1);
  assert.equal(a.newestOrderDate.slice(0, 10), '2026-03-01');
  assert.equal(b.orderCount, 1);
  assert.equal(b.invoiceCount, 0);
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
