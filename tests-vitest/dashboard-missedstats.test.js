'use strict';

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadSandbox, toPlain } from './helpers/sandbox';

function loadMissedStatsSandbox() {
  return loadSandbox({ scripts: ['utils.js', 'sidepanel.dashboard.js', 'dashboard.missedstats.js'] });
}

function record(orderNumber, isoDate, invoice) {
  return {
    orderNumber,
    orderDate: `${isoDate}T10:00:00.000Z`,
    summary: { orderDate: `${isoDate}T10:00:00.000Z` },
    invoice: { schemaVersion: 3, walmartExtractionVersion: 6, items: [], ...invoice },
  };
}

test('missed summary counts unavailable, canceled, substituted and weight-adjusted lines', () => {
  const { MissedStats } = loadMissedStatsSandbox();
  const summary = toPlain(MissedStats.buildMissedSummary([
    record('1001', '2026-03-10', {
      wasDelayed: true,
      items: [
        { productName: 'Oat Milk', quantity: '1', price: '$4.50', fulfillment: 'Substituted' },
        { productName: 'Bananas', quantity: '3', price: '$1.24', fulfillment: 'Weight adjusted' },
        { productName: 'Paper Towels', quantity: '1', price: '$5.00' },
      ],
      unfulfilledItems: [
        { productName: 'String Cheese', quantity: '2', reason: 'Unavailable', price: '$9.88' },
        { productName: 'Trash Bags', quantity: '1', reason: 'Canceled', price: '$6.50' },
      ],
    }),
    record('1002', '2026-04-02', {
      items: [{ productName: 'Paper Towels', quantity: '1', price: '$5.00' }],
      unfulfilledItems: [{ productName: 'String Cheese', quantity: '1', reason: 'Unavailable', price: '$4.94' }],
    }),
    // Saved before these details were recorded: measured, but tells us nothing.
    record('1003', '2026-04-20', { walmartExtractionVersion: 5, items: [{ productName: 'Soap', quantity: '1', price: '$2.00' }] }),
    // Pre-v3 data is not a measured invoice at all.
    record('1004', '2026-05-01', { schemaVersion: 2, items: [{ productName: 'Old', quantity: '1', price: '$1.00' }] }),
  ]));

  assert.equal(summary.ordersMeasured, 3);
  assert.equal(summary.ordersWithDetail, 2);
  assert.equal(summary.ordersAffected, 2);
  assert.equal(summary.lateDeliveries, 1);
  assert.deepEqual(summary.totals.unavailable, { lines: 2, quantity: 3, value: 14.82 });
  assert.deepEqual(summary.totals.canceled, { lines: 1, quantity: 1, value: 6.5 });
  assert.deepEqual(summary.totals.substituted, { lines: 1, quantity: 1, value: 4.5 });
  assert.deepEqual(summary.totals.weightAdjusted, { lines: 1, quantity: 3, value: 1.24 });
  assert.deepEqual(summary.top.unavailable, [{ name: 'String Cheese', times: 2, quantity: 3, value: 14.82, lastDate: '2026-04-02' }]);
  assert.equal(summary.recent[0].date, '2026-04-02', 'newest first');
  assert.equal(summary.recent.length, 5);
});

test('missed summary: empty, malformed and detail-less input never throws or invents lines', () => {
  const { MissedStats } = loadMissedStatsSandbox();
  for (const input of [undefined, null, [], [null], [{}], [{ invoice: null }], [record('1', '2026-01-01', { unfulfilledItems: 'oops', items: [null, {}] })]]) {
    const summary = toPlain(MissedStats.buildMissedSummary(input));
    assert.equal(summary.ordersAffected, 0);
    assert.equal(summary.recent.length, 0);
    for (const kind of ['unavailable', 'canceled', 'substituted', 'weightAdjusted']) {
      assert.deepEqual(summary.totals[kind], { lines: 0, quantity: 0, value: 0 });
    }
  }
  assert.equal(MissedStats.hasDetail({ walmartExtractionVersion: 6 }), true);
  assert.equal(MissedStats.hasDetail({ walmartExtractionVersion: 5 }), false);
  assert.equal(MissedStats.hasDetail(null), false);
  assert.equal(MissedStats.hasDetail({ walmartExtractionVersion: 2 }, 'WALMART_CA'), true, 'Canada records the details from its version 2');
  assert.equal(MissedStats.hasDetail({ walmartExtractionVersion: 1 }, 'WALMART_CA'), false);
  assert.equal(MissedStats.hasDetail({ walmartExtractionVersion: 2 }, 'WALMART_US'), false);
});
