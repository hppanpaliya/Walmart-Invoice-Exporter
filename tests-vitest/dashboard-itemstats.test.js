'use strict';

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadSandbox, toPlain } from './helpers/sandbox';

// dashboard.itemstats.js depends on utils.js (parseNumericValue, CONSTANTS)
// and sidepanel.dashboard.js (dashboardRecordDate) — same load order as
// entrypoints/dashboard/index.html.
function loadItemStatsSandbox() {
  return loadSandbox({ scripts: ['utils.js', 'sidepanel.dashboard.js', 'dashboard.itemstats.js'] });
}

/** Minimal measured-invoice record: one order with the given line items. */
function invoiceRecord(orderNumber, isoDate, items, schemaVersion = 3) {
  return {
    orderNumber,
    orderDate: `${isoDate}T10:00:00.000Z`,
    summary: { orderDate: `${isoDate}T10:00:00.000Z` },
    invoice: { schemaVersion, items },
  };
}

test('buildItemIndex merges the same product across invoices (case-insensitive) and skips unmeasured records', () => {
  const { ItemStats } = loadItemStatsSandbox();
  const index = toPlain(ItemStats.buildItemIndex([
    invoiceRecord('1001', '2026-01-10', [
      { productName: 'Test Milk 1 Gallon', quantity: '2', price: '$7.00' },
      { productName: 'Test Bananas, each', quantity: '3', price: '$1.50' },
    ]),
    // Same product, different capitalization → must merge into one entry.
    invoiceRecord('1002', '2026-03-05', [
      { productName: 'TEST MILK 1 GALLON', quantity: '1', price: '$4.00' },
    ]),
    // Summary-only (no invoice) → never measured.
    { orderNumber: '1003', orderDate: '2026-04-01T10:00:00.000Z', summary: { items: [{ name: 'Test Milk 1 Gallon', quantity: 1 }] }, invoice: null },
    // Pre-v3 invoice → not trusted, not measured.
    invoiceRecord('1004', '2026-04-02', [{ productName: 'Test Milk 1 Gallon', quantity: '1', price: '$9.99' }], 2),
  ]));

  assert.equal(index.length, 2);
  const milk = index.find((entry) => entry.name === 'Test Milk 1 Gallon');
  assert.ok(milk, 'merged milk entry exists (first-seen casing kept)');
  assert.equal(milk.timesBought, 2);
  assert.equal(milk.totalQty, 3);
  assert.equal(milk.totalSpent, 11);
  assert.equal(milk.firstPrice, 3.5); // $7.00 / 2
  assert.equal(milk.lastPrice, 4);
  assert.equal(milk.minPrice, 3.5);
  assert.equal(milk.maxPrice, 4);
  assert.equal(milk.avgPrice, 3.67); // 11.00 / 3 qty, spend-weighted
  assert.equal(milk.percentChange, 14); // round((4 − 3.5) / 3.5 × 100)
  assert.deepEqual(milk.purchases.map((p) => p.orderNumber), ['1001', '1002']);
  assert.deepEqual(milk.purchases.map((p) => p.date), ['2026-01-10', '2026-03-05']);
});

test('buildItemIndex keys by usItemId when present and merges duplicate lines within one order', () => {
  const { ItemStats } = loadItemStatsSandbox();
  const index = toPlain(ItemStats.buildItemIndex([
    // Two lines of the same usItemId in ONE order → one purchase (qty/total summed).
    invoiceRecord('2001', '2026-02-01', [
      { productName: 'Great Value Eggs', usItemId: '777', quantity: '1', price: '$3.00' },
      { productName: 'Great Value Eggs', usItemId: '777', quantity: '2', price: '$6.00' },
    ]),
    // Renamed listing, same usItemId → merges with the entry above.
    invoiceRecord('2002', '2026-05-01', [
      { productName: 'GV Eggs Large 12ct', usItemId: '777', quantity: '1', price: '$3.60' },
    ]),
  ]));

  assert.equal(index.length, 1);
  const eggs = index[0];
  assert.equal(eggs.timesBought, 2, 'one purchase per order, duplicates merged');
  assert.equal(eggs.totalQty, 4);
  assert.equal(eggs.totalSpent, 12.6);
  assert.deepEqual(eggs.purchases.map((p) => p.quantity), [3, 1]);
  assert.deepEqual(eggs.purchases.map((p) => p.unitPrice), [3, 3.6]);
});

test('buildItemIndex sorts purchases by date ascending regardless of record order', () => {
  const { ItemStats } = loadItemStatsSandbox();
  const index = toPlain(ItemStats.buildItemIndex([
    invoiceRecord('3003', '2026-06-01', [{ productName: 'Bread', quantity: '1', price: '$3.00' }]),
    invoiceRecord('3001', '2025-01-15', [{ productName: 'Bread', quantity: '1', price: '$2.00' }]),
    invoiceRecord('3002', '2025-09-20', [{ productName: 'Bread', quantity: '1', price: '$2.50' }]),
  ]));

  assert.equal(index.length, 1);
  assert.deepEqual(index[0].purchases.map((p) => p.date), ['2025-01-15', '2025-09-20', '2026-06-01']);
  assert.equal(index[0].firstPrice, 2);
  assert.equal(index[0].lastPrice, 3);
  assert.equal(index[0].percentChange, 50);
});

test('buildItemIndex survives malformed/missing prices and quantities without inventing numbers', () => {
  const { ItemStats } = loadItemStatsSandbox();
  const index = toPlain(ItemStats.buildItemIndex([
    invoiceRecord('4001', '2026-01-01', [
      { productName: 'Mystery Item', quantity: '2', price: '' }, // unpriced
      { productName: 'Fancy TV', quantity: '', price: '$1,234.56' }, // empty qty → 1; grouped-string money
    ]),
    invoiceRecord('4002', '2026-02-01', [
      { productName: 'Mystery Item', quantity: '1', price: null }, // unpriced
    ]),
  ]));

  const mystery = index.find((entry) => entry.name === 'Mystery Item');
  assert.equal(mystery.timesBought, 2, 'unpriced purchases still count toward buy history');
  assert.equal(mystery.totalQty, 3);
  assert.equal(mystery.totalSpent, 0);
  assert.equal(mystery.avgPrice, 0);
  assert.equal(mystery.percentChange, null, 'no priced purchases → no price-change claim');

  const tv = index.find((entry) => entry.name === 'Fancy TV');
  assert.equal(tv.totalQty, 1);
  assert.equal(tv.totalSpent, 1234.56);
  assert.equal(tv.firstPrice, 1234.56);
  assert.equal(tv.percentChange, null, 'a single priced purchase is not a change');
});

test('buildItemIndex accepts a custom measured-record predicate', () => {
  const { ItemStats } = loadItemStatsSandbox();
  const records = [
    invoiceRecord('5001', '2026-01-01', [{ productName: 'Old Item', quantity: '1', price: '$1.00' }], 2),
  ];
  assert.equal(ItemStats.buildItemIndex(records).length, 0, 'pre-v3 rejected by default');
  const index = ItemStats.buildItemIndex(records, (record) => Boolean(record.invoice));
  assert.equal(index.length, 1, 'predicate override admits the record');
});

test('computePersonalInflation: hand-computed Laspeyres rate over a 3-item basket', () => {
  const { ItemStats } = loadItemStatsSandbox();
  // Windows for now = 2026-07-01: "now" is (2025-07-01, 2026-07-01],
  // "then" is (2024-07-01, 2025-07-01]. Boundary dates included below on
  // purpose: Bread's then purchase sits exactly ON the 12-month cut (→ then
  // window) and its now purchase exactly on `now` (→ now window).
  const index = ItemStats.buildItemIndex([
    // Apples: then avg $5.00 (qty 2, $10.00) → now avg $5.50. A 2023
    // purchase sits outside both windows and must not shift the averages.
    invoiceRecord('6000', '2023-05-01', [{ productName: 'Apples', quantity: '10', price: '$90.00' }]),
    invoiceRecord('6001', '2024-08-01', [{ productName: 'Apples', quantity: '2', price: '$10.00' }]),
    invoiceRecord('6002', '2025-09-01', [{ productName: 'Apples', quantity: '1', price: '$5.50' }]),
    // Bread: then avg $20.00 → now avg $22.00.
    invoiceRecord('6003', '2025-07-01', [{ productName: 'Bread', quantity: '1', price: '$20.00' }]),
    invoiceRecord('6004', '2026-07-01', [{ productName: 'Bread', quantity: '2', price: '$44.00' }]),
    // Carrots: then avg $2.00 (qty 4, $8.00) → now avg $1.80.
    invoiceRecord('6005', '2025-06-30', [{ productName: 'Carrots', quantity: '4', price: '$8.00' }]),
    invoiceRecord('6006', '2025-07-02', [{ productName: 'Carrots', quantity: '1', price: '$1.80' }]),
  ]);

  const inflation = toPlain(ItemStats.computePersonalInflation(index, new Date(2026, 6, 1)));
  assert.ok(inflation, '3 overlapping items → a rate is claimable');
  assert.equal(inflation.itemCount, 3);
  // basketThen = 2·5 + 1·20 + 4·2 = 38; basketNow = 2·5.5 + 1·22 + 4·1.8 = 40.2
  assert.equal(inflation.basketThen, 38);
  assert.equal(inflation.basketNow, 40.2);
  // (40.2 / 38 − 1) × 100 = 5.789…% → 5.8 at one decimal
  assert.equal(inflation.ratePercent, 5.8);
  // Risers tie at +10% → alphabetical; single faller at −10%.
  assert.deepEqual(inflation.topRisers.map((item) => [item.name, item.percent]), [['Apples', 10], ['Bread', 10]]);
  assert.deepEqual(inflation.topFallers.map((item) => [item.name, item.percent]), [['Carrots', -10]]);
  assert.deepEqual(inflation.topRisers[0], { name: 'Apples', thenAvg: 5, nowAvg: 5.5, percent: 10 });
});

test('computePersonalInflation returns null below 3 overlapping items (never invents a rate)', () => {
  const { ItemStats } = loadItemStatsSandbox();
  const index = ItemStats.buildItemIndex([
    invoiceRecord('7001', '2024-08-01', [{ productName: 'Apples', quantity: '1', price: '$5.00' }]),
    invoiceRecord('7002', '2025-09-01', [{ productName: 'Apples', quantity: '1', price: '$5.50' }]),
    invoiceRecord('7003', '2024-08-01', [{ productName: 'Bread', quantity: '1', price: '$2.00' }]),
    invoiceRecord('7004', '2025-09-01', [{ productName: 'Bread', quantity: '1', price: '$2.20' }]),
    // Cheese exists only in the now window → no overlap contribution.
    invoiceRecord('7005', '2025-09-01', [{ productName: 'Cheese', quantity: '1', price: '$4.00' }]),
  ]);

  assert.equal(ItemStats.computePersonalInflation(index, new Date(2026, 6, 1)), null);
  assert.equal(ItemStats.computePersonalInflation([], new Date(2026, 6, 1)), null);
});

test('computePersonalInflation ignores unpriced and undated purchases when windowing', () => {
  const { ItemStats } = loadItemStatsSandbox();
  const records = [];
  ['Apples', 'Bread', 'Carrots'].forEach((name, i) => {
    records.push(invoiceRecord(`800${i}a`, '2024-09-01', [{ productName: name, quantity: '1', price: '$2.00' }]));
    records.push(invoiceRecord(`800${i}b`, '2025-09-01', [{ productName: name, quantity: '1', price: '$2.20' }]));
    // Unpriced now-window purchase must not zero out the now average.
    records.push(invoiceRecord(`800${i}c`, '2025-10-01', [{ productName: name, quantity: '1', price: '' }]));
  });
  // An undated (no date anywhere) record cannot be windowed — must be skipped.
  records.push({ orderNumber: '8009', invoice: { schemaVersion: 3, items: [{ productName: 'Apples', quantity: '1', price: '$99.00' }] } });

  const inflation = ItemStats.computePersonalInflation(
    ItemStats.buildItemIndex(records), new Date(2026, 6, 1)
  );
  assert.ok(inflation);
  assert.equal(inflation.itemCount, 3);
  // Every item moved $2.00 → $2.20 → exactly +10.0%.
  assert.equal(inflation.ratePercent, 10);
});
