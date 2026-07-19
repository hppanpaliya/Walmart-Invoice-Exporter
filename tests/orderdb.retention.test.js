'use strict';

/**
 * OrderDb data retention (Settings → Advanced, off by default): purge orders
 * not written within N days so data doesn't pile up on the device and a
 * previous account's orders age out. purgeOlderThan does the deletion by each
 * record's updatedAt; applyRetention reads the setting and is a no-op when off.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, evalIn } = require('./helpers/sandbox');

function loadDb() {
  return loadSandbox({ scripts: ['utils.js', 'orderdb.js'] });
}

test('purgeOlderThan: deletes records whose updatedAt is before the cutoff, keeps newer ones', async () => {
  const sandbox = loadDb();
  const OrderDb = evalIn(sandbox, 'OrderDb');

  // Seed two orders (putSummaries stamps updatedAt = now).
  await OrderDb.putSummaries({ '1': { orderDate: '2026-01-01T00:00:00.000Z' } }, {});
  await OrderDb.putSummaries({ '2': { orderDate: '2026-02-01T00:00:00.000Z' } }, {});
  assert.equal((await OrderDb.getAllOrders()).length, 2);

  // A cutoff BEFORE they were written removes nothing.
  const noneCutoff = Date.now() - 60 * 1000;
  assert.equal(await OrderDb.purgeOlderThan(noneCutoff), 0);
  assert.equal((await OrderDb.getAllOrders()).length, 2);

  // A cutoff AFTER they were written removes them all.
  const allCutoff = Date.now() + 60 * 1000;
  assert.equal(await OrderDb.purgeOlderThan(allCutoff), 2);
  assert.equal((await OrderDb.getAllOrders()).length, 0);
});

test('applyRetention: no-op when the retention setting is off', async () => {
  const sandbox = loadDb();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putSummaries({ '1': { orderDate: '2026-01-01T00:00:00.000Z' } }, {});

  // Default: dataRetentionEnabled unset/false → nothing is purged.
  assert.equal(await OrderDb.applyRetention(), 0);
  assert.equal((await OrderDb.getAllOrders()).length, 1);
});

test('applyRetention: on, but freshly-collected data (within the window) is kept', async () => {
  const sandbox = loadDb();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putSummaries({ '1': { orderDate: '2026-01-01T00:00:00.000Z' } }, {});

  await new Promise((resolve) =>
    sandbox.chrome.storage.local.set({ dataRetentionEnabled: true, dataRetentionDays: 30 }, resolve)
  );

  // The record was just written, so it's inside the 30-day window → kept.
  assert.equal(await OrderDb.applyRetention(), 0);
  assert.equal((await OrderDb.getAllOrders()).length, 1);
});
