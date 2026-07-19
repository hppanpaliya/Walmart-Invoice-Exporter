'use strict';

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadSandbox, evalIn, toPlain } from './helpers/sandbox';

/**
 * Load ReviewStats (dashboard.view-review.js, part a) into the vm sandbox:
 * the shared data layer first (utils.js for parseNumericValue/CONSTANTS,
 * sidepanel.dashboard.js for dashboardRecordDate), then a no-op WIEDash stub
 * so the file's view-module half registers into thin air, then the file
 * itself. Returns the pure ReviewStats global.
 */
function loadReviewStats() {
  const sandbox = loadSandbox({ scripts: ['utils.js', 'sidepanel.dashboard.js'] });
  evalIn(sandbox, 'globalThis.WIEDash = { registerView() {} };');
  sandbox.importScripts('dashboard.view-review.js');
  return evalIn(sandbox, 'ReviewStats');
}

/** A measured (schema-current) OrderDb-shaped record. Synthetic data only. */
function measured(orderNumber, date, invoice = {}, summary = {}) {
  return {
    orderNumber,
    orderDate: date,
    summary: { orderDate: date, ...summary },
    invoice: { schemaVersion: 3, ...invoice },
  };
}

/** A summary-only record — never measured. */
function summaryOnly(orderNumber, date, summary = {}) {
  return { orderNumber, orderDate: date, summary: { orderDate: date, ...summary }, invoice: null };
}

test('yearsAvailable: measured years only, descending, undated/stale-schema excluded', () => {
  const ReviewStats = loadReviewStats();
  const records = [
    measured('1', '2024-05-01', { orderTotal: '$10.00' }),
    measured('2', '2026-01-15', { orderTotal: '$20.00' }),
    summaryOnly('3', '2025-02-02', { orderTotal: '$30.00' }), // not measured
    { orderNumber: '4', orderDate: '2023-03-03', summary: { orderDate: '2023-03-03' }, invoice: { schemaVersion: 1 } }, // pre-v3
    measured('5', '', { orderTotal: '$5.00' }), // undated — belongs to no year
  ];
  assert.deepStrictEqual(toPlain(ReviewStats.yearsAvailable(records)), [2026, 2024]);
  assert.deepStrictEqual(toPlain(ReviewStats.yearsAvailable([])), []);
});

test('computeYearReview: totals with summary fallback, item counts, measured-only filtering', () => {
  const ReviewStats = loadReviewStats();
  const records = [
    measured('101', '2025-01-05', {
      orderTotal: '$24.11', savings: '$2.00', tip: '$4.00', refund: '$3.98',
      items: [
        { productName: 'Test Milk 1 Gallon', quantity: '2', price: '$7.96' },
        { productName: 'Test Bananas, each', quantity: '6', price: '$1.62' },
      ],
    }),
    // Fast-fetch style invoice: no price block of its own — every money
    // field must fall back to the purchase-history summary.
    measured('102', '2025-02-10', {
      orderTotal: '', savings: '', tip: '', refund: '',
      items: [{ productName: 'Test Milk 1 Gallon', quantity: '', price: '$3.98' }],
    }, { orderTotal: '$10.50', savings: '$1.00', driverTip: '$1.50', refund: '$1.02' }),
    // Summary-only order in the same year: must not count anywhere.
    summaryOnly('103', '2025-03-01', { orderTotal: '$99.99', savings: '$50.00' }),
  ];
  const review = ReviewStats.computeYearReview(records, 2025);
  assert.strictEqual(review.year, 2025);
  assert.strictEqual(review.orderCount, 2); // the summary-only order is NOT measured
  assert.strictEqual(review.totalSpent, 34.61); // 24.11 + summary-fallback 10.50
  assert.strictEqual(review.itemCount, 9); // 2 + 6 + blank-quantity→1
  assert.strictEqual(review.distinctItems, 2);
  assert.strictEqual(review.totalSaved, 3); // 2.00 + summary-fallback 1.00
  assert.strictEqual(review.tipTotal, 5.5); // 4.00 + summary-fallback 1.50
  assert.strictEqual(review.refundTotal, 5); // 3.98 + summary-fallback 1.02
});

test('computeYearReview: savingsRate is saved / (spent + saved), null on a zero base', () => {
  const ReviewStats = loadReviewStats();
  const records = [measured('201', '2025-04-01', { orderTotal: '$90.00', savings: '$10.00' })];
  const review = ReviewStats.computeYearReview(records, 2025);
  assert.strictEqual(review.savingsRate, 0.1); // 10 / (90 + 10)
  // Empty year → nothing spent or saved → no rate, never NaN.
  assert.strictEqual(ReviewStats.computeYearReview(records, 2020).savingsRate, null);
});

test('computeYearReview: biggestOrder parses "$1,234.56" strings and ties break to the earlier date', () => {
  const ReviewStats = loadReviewStats();
  const review = ReviewStats.computeYearReview([
    measured('301', '2025-06-15', { orderTotal: '$1,234.56' }),
    measured('302', '2025-01-02', { orderTotal: '$999.99' }),
  ], 2025);
  assert.deepStrictEqual(toPlain(review.biggestOrder), {
    orderNumber: '301', date: '2025-06-15', total: 1234.56,
  });

  // Tie on total: the earlier date wins regardless of record order.
  const tied = ReviewStats.computeYearReview([
    measured('312', '2025-08-01', { orderTotal: '$50.00' }),
    measured('311', '2025-03-01', { orderTotal: '$50.00' }),
  ], 2025);
  assert.deepStrictEqual(toPlain(tied.biggestOrder), {
    orderNumber: '311', date: '2025-03-01', total: 50,
  });
});

test('computeYearReview: longestGapDays, avgDaysBetweenOrders, first/last order (hand-computed fixture)', () => {
  const ReviewStats = loadReviewStats();
  // Gaps: Jan 1→Jan 10 = 9d, Jan 10→Mar 3 = 52d, Mar 3→Mar 26 = 23d.
  const records = [
    measured('401', '2025-01-01', { orderTotal: '$10.00' }),
    measured('402', '2025-01-10', { orderTotal: '$10.00' }),
    measured('403', '2025-03-03', { orderTotal: '$10.00' }),
    measured('404', '2025-03-26', { orderTotal: '$10.00' }),
  ];
  const review = ReviewStats.computeYearReview(records, 2025);
  assert.deepStrictEqual(toPlain(review.longestGapDays), { days: 52, from: '2025-01-10', to: '2025-03-03' });
  assert.strictEqual(review.avgDaysBetweenOrders, 28); // 84 days / 3 gaps
  assert.deepStrictEqual(toPlain(review.firstOrder), { date: '2025-01-01' });
  assert.deepStrictEqual(toPlain(review.lastOrder), { date: '2025-03-26' });

  // A single order has no gaps and no cadence.
  const single = ReviewStats.computeYearReview(records.slice(0, 1), 2025);
  assert.strictEqual(single.longestGapDays, null);
  assert.strictEqual(single.avgDaysBetweenOrders, null);
});

test('computeYearReview: busiest month and busiest day of week', () => {
  const ReviewStats = loadReviewStats();
  const records = [
    measured('501', '2025-01-01', { orderTotal: '$5.00' }), // Wednesday
    measured('502', '2025-03-03', { orderTotal: '$10.00' }), // Monday
    measured('503', '2025-03-10', { orderTotal: '$20.00' }), // Monday
    measured('504', '2025-03-17', { orderTotal: '$30.00' }), // Monday
    measured('505', '2025-03-26', { orderTotal: '$40.00' }), // Wednesday
  ];
  const review = ReviewStats.computeYearReview(records, 2025);
  assert.deepStrictEqual(toPlain(review.busiestMonth), { month: '2025-03', count: 4, total: 100 });
  assert.deepStrictEqual(toPlain(review.busiestDay), { name: 'Monday', count: 3 });
});

test('computeYearReview: prevYearTotal present only when the prior year has measured invoices', () => {
  const ReviewStats = loadReviewStats();
  const records = [
    measured('601', '2024-07-04', { orderTotal: '$60.00' }),
    measured('602', '2024-11-20', { orderTotal: '$40.00' }),
    measured('603', '2025-05-05', { orderTotal: '$25.00' }),
    summaryOnly('604', '2023-05-05', { orderTotal: '$500.00' }), // unmeasured prior years never count
  ];
  assert.strictEqual(ReviewStats.computeYearReview(records, 2025).prevYearTotal, 100);
  assert.strictEqual(ReviewStats.computeYearReview(records, 2024).prevYearTotal, null);
});

test('computeYearReview: mostBought, topItemsBySpend (top 5, spend-sorted), deliverySplit', () => {
  const ReviewStats = loadReviewStats();
  const records = [
    measured('701', '2025-02-01', {
      orderTotal: '$40.00', orderType: 'Delivery',
      items: [
        { productName: 'Test Bananas', quantity: '3', price: '$1.50' },
        { productName: 'Test Milk', quantity: '2', price: '$8.00' },
        { productName: 'Test Eggs', quantity: '1', price: '$5.00' },
        { productName: 'Test Bread', quantity: '1', price: '$2.00' },
      ],
    }),
    measured('702', '2025-06-01', {
      orderTotal: '$30.00', orderType: 'Delivery',
      items: [
        { productName: 'Test Bananas', quantity: '4', price: '$2.00' },
        { productName: 'Test Chicken', quantity: '1', price: '$9.00' },
        { productName: 'Test Apples', quantity: '1', price: '$1.00' },
      ],
    }),
    measured('703', '2025-06-15', { orderTotal: '$12.00', isInStore: true }),
  ];
  const review = ReviewStats.computeYearReview(records, 2025);
  assert.deepStrictEqual(toPlain(review.mostBought), { name: 'Test Bananas', count: 7 });
  // Spend-sorted, six distinct items squeezed to five — Bread ($2) and
  // Apples ($1) fight for the last slot, Bread wins.
  assert.deepStrictEqual(toPlain(review.topItemsBySpend), [
    { name: 'Test Chicken', total: 9 },
    { name: 'Test Milk', total: 8 },
    { name: 'Test Eggs', total: 5 },
    { name: 'Test Bananas', total: 3.5 },
    { name: 'Test Bread', total: 2 },
  ]);
  assert.deepStrictEqual(toPlain(review.deliverySplit), [
    { type: 'Delivery', count: 2 },
    { type: 'In-store', count: 1 },
  ]);
});

test('computeYearReview: months is a zero-filled 12-bucket series for the chart', () => {
  const ReviewStats = loadReviewStats();
  const records = [
    measured('801', '2025-03-03', { orderTotal: '$10.00' }),
    measured('802', '2025-03-20', { orderTotal: '$5.50' }),
    measured('803', '2025-11-11', { orderTotal: '$7.25' }),
  ];
  const review = ReviewStats.computeYearReview(records, 2025);
  assert.strictEqual(review.months.length, 12);
  assert.deepStrictEqual(toPlain(review.months[0]), { month: '2025-01', count: 0, total: 0 });
  assert.deepStrictEqual(toPlain(review.months[2]), { month: '2025-03', count: 2, total: 15.5 });
  assert.deepStrictEqual(toPlain(review.months[10]), { month: '2025-11', count: 1, total: 7.25 });
});

test('computeYearReview: an empty year returns zeros and nulls, never NaN', () => {
  const ReviewStats = loadReviewStats();
  const review = ReviewStats.computeYearReview([], 2025);
  assert.strictEqual(review.totalSpent, 0);
  assert.strictEqual(review.orderCount, 0);
  assert.strictEqual(review.itemCount, 0);
  assert.strictEqual(review.distinctItems, 0);
  assert.strictEqual(review.totalSaved, 0);
  assert.strictEqual(review.savingsRate, null);
  assert.strictEqual(review.biggestOrder, null);
  assert.strictEqual(review.busiestMonth, null);
  assert.strictEqual(review.busiestDay, null);
  assert.strictEqual(review.mostBought, null);
  assert.deepStrictEqual(toPlain(review.topItemsBySpend), []);
  assert.strictEqual(review.longestGapDays, null);
  assert.strictEqual(review.avgDaysBetweenOrders, null);
  assert.strictEqual(review.firstOrder, null);
  assert.strictEqual(review.lastOrder, null);
  assert.deepStrictEqual(toPlain(review.deliverySplit), []);
  assert.strictEqual(review.refundTotal, 0);
  assert.strictEqual(review.tipTotal, 0);
  assert.strictEqual(review.prevYearTotal, null);
  assert.strictEqual(review.months.length, 12);
});
