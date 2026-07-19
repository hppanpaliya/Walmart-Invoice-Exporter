'use strict';

/**
 * OrderDb inactivity retention (Settings → Advanced, ON by default): if the
 * extension hasn't been used in N days, ALL saved data is wiped in one shot —
 * NOT per-order aging. An active user's clock (lastUsedAt, reset by markUsed)
 * keeps resetting, so they never lose data.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, evalIn } = require('./helpers/sandbox');

const DAY = 24 * 60 * 60 * 1000;

function loadDb() {
  return loadSandbox({ scripts: ['utils.js', 'orderdb.js'] });
}

function setLocal(sandbox, obj) {
  return new Promise((resolve) => sandbox.chrome.storage.local.set(obj, resolve));
}

test('enforceInactivityRetention: wipes EVERYTHING when unused past the window', async () => {
  const sandbox = loadDb();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putSummaries({ '1': { orderDate: '2026-01-01T00:00:00.000Z' } }, {}, 'WALMART_US');
  await OrderDb.putSummaries({ '2': { orderDate: '2026-02-01T00:00:00.000Z' } }, {}, 'WALMART_CA');

  // Enabled (default), 30-day window, last used 40 days ago → wipe all.
  await setLocal(sandbox, { dataRetentionDays: 30, lastUsedAt: Date.now() - 40 * DAY });

  const wiped = await OrderDb.enforceInactivityRetention();
  assert.equal(wiped, 2, 'both providers wiped');
  assert.equal((await OrderDb.getAllOrders('WALMART_US')).length, 0);
  assert.equal((await OrderDb.getAllOrders('WALMART_CA')).length, 0);
});

test('enforceInactivityRetention: keeps everything while the extension is still active', async () => {
  const sandbox = loadDb();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putSummaries({ '1': { orderDate: '2026-01-01T00:00:00.000Z' } }, {});

  // Used 5 days ago, 30-day window → nothing wiped.
  await setLocal(sandbox, { dataRetentionDays: 30, lastUsedAt: Date.now() - 5 * DAY });

  assert.equal(await OrderDb.enforceInactivityRetention(), 0);
  assert.equal((await OrderDb.getAllOrders()).length, 1);
});

test('enforceInactivityRetention: no-op when the setting is turned off', async () => {
  const sandbox = loadDb();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putSummaries({ '1': { orderDate: '2026-01-01T00:00:00.000Z' } }, {});

  // Disabled — even a long-abandoned install keeps its data.
  await setLocal(sandbox, { dataRetentionEnabled: false, dataRetentionDays: 30, lastUsedAt: Date.now() - 400 * DAY });

  assert.equal(await OrderDb.enforceInactivityRetention(), 0);
  assert.equal((await OrderDb.getAllOrders()).length, 1);
});

test('enforceInactivityRetention: no baseline yet (fresh install) never wipes', async () => {
  const sandbox = loadDb();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putSummaries({ '1': { orderDate: '2026-01-01T00:00:00.000Z' } }, {});

  // No lastUsedAt stored → nothing to compare against → keep data.
  assert.equal(await OrderDb.enforceInactivityRetention(), 0);
  assert.equal((await OrderDb.getAllOrders()).length, 1);
});

test('markUsed then enforce: a fresh "use" saves data that would otherwise be wiped', async () => {
  const sandbox = loadDb();
  const OrderDb = evalIn(sandbox, 'OrderDb');
  await OrderDb.putSummaries({ '1': { orderDate: '2026-01-01T00:00:00.000Z' } }, {});
  await setLocal(sandbox, { dataRetentionDays: 30, lastUsedAt: Date.now() - 400 * DAY });

  await OrderDb.markUsed(); // opening the panel resets the clock
  assert.equal(await OrderDb.enforceInactivityRetention(), 0, 'clock reset → nothing wiped');
  assert.equal((await OrderDb.getAllOrders()).length, 1);
});
