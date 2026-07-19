'use strict';

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadSandbox, toPlain } from './helpers/sandbox';

/**
 * TrendStats (public/dashboard.trendstats.js) unit tests — pure computation
 * over hand-built OrderDb-shaped records. The module depends on the shared
 * globals from utils.js (parseNumericValue, CONSTANTS) and
 * sidepanel.dashboard.js (dashboardRecordDate, filterDashboardRecords,
 * roundMoneyToCents), so both load first — the same order the dashboard's
 * index.html uses. Results are toPlain()ed before deepEqual: they were built
 * in the vm realm, whose Object.prototype differs from the test realm's.
 */
function loadTrendStats() {
  const sandbox = loadSandbox({
    scripts: ['utils.js', 'sidepanel.dashboard.js', 'dashboard.trendstats.js'],
  });
  // The module exports through the window→self→globalThis root guard; the
  // sandbox provides a window object, so that's where TrendStats lands.
  return sandbox.window.TrendStats;
}

/** Deterministic "now": July 15, 2026 (local). */
const NOW = new Date(2026, 6, 15);

/** A measured record: schema-current invoice + summary, dated. */
function measured(orderNumber, date, invoiceFields = {}, summaryFields = {}) {
  return {
    orderNumber,
    orderDate: date,
    summary: { orderDate: date, ...summaryFields },
    invoice: { schemaVersion: 3, ...invoiceFields },
  };
}

/** A summary-only record — must NEVER be measured by any TrendStats money. */
function summaryOnly(orderNumber, date, summaryFields = {}) {
  return {
    orderNumber,
    orderDate: date,
    summary: { orderDate: date, ...summaryFields },
    invoice: null,
  };
}

test('cumulativeByMonth: exact running sums, zero-filled gap months, summary fallback, measured-only, range scoping', () => {
  const TrendStats = loadTrendStats();
  const records = [
    measured('1', '2026-01-10', { orderTotal: '$10.00' }),
    // Fast-path invoice with no price block: the summary total must be used.
    measured('2', '2026-03-05', { orderTotal: '' }, { orderTotal: '$1,234.56' }),
    // Summary-only order: excluded from money (its Feb month zero-fills).
    summaryOnly('3', '2026-02-02', { orderTotal: '$99.00' }),
    // Stale (pre-v3) invoice: counts as not measured.
    { orderNumber: '4', orderDate: '2026-02-20', summary: { orderTotal: '$77.00' }, invoice: { schemaVersion: 2, orderTotal: '$77.00' } },
    // Outside 'thisYear'.
    measured('5', '2025-12-31', { orderTotal: '$50.00' }),
  ];

  assert.deepEqual(toPlain(TrendStats.cumulativeByMonth(records, 'thisYear', NOW)), [
    { month: '2026-01', total: 10, cumulative: 10 },
    { month: '2026-02', total: 0, cumulative: 10 },
    { month: '2026-03', total: 1234.56, cumulative: 1244.56 },
  ]);

  // 'all' pulls the 2025 record back in and starts the running sum there.
  const all = toPlain(TrendStats.cumulativeByMonth(records, 'all', NOW));
  assert.equal(all[0].month, '2025-12');
  assert.deepEqual(all[0], { month: '2025-12', total: 50, cumulative: 50 });
  assert.equal(all[all.length - 1].cumulative, 1294.56);
});

test('yearOverYear: groups ALL records by calendar year, 12-slot monthly arrays, capped at the 3 most recent years with data', () => {
  const TrendStats = loadTrendStats();
  const records = [
    measured('1', '2026-02-14', { orderTotal: '$20.00' }),
    measured('2', '2025-02-01', { orderTotal: '$10.00' }),
    measured('3', '2025-11-20', { orderTotal: '$5.00' }),
    measured('4', '2023-06-06', { orderTotal: '$7.00' }),
    // 4th-most-recent year with data: dropped by the cap.
    measured('5', '2022-01-01', { orderTotal: '$3.00' }),
    // Summary-only: never measured.
    summaryOnly('6', '2026-03-03', { orderTotal: '$500.00' }),
  ];

  const { years } = toPlain(TrendStats.yearOverYear(records, NOW));
  assert.deepEqual(years.map((entry) => entry.year), [2023, 2025, 2026]);

  const y2025 = years.find((entry) => entry.year === 2025);
  assert.equal(y2025.monthly.length, 12);
  assert.equal(y2025.monthly[1], 10); // Feb
  assert.equal(y2025.monthly[10], 5); // Nov
  assert.equal(y2025.total, 15);

  const y2026 = years.find((entry) => entry.year === 2026);
  assert.equal(y2026.monthly[1], 20);
  assert.equal(y2026.total, 20);
});

test('calendarHeatmap: last-365-day window, per-day totals and counts, only days with orders, maxTotal', () => {
  const TrendStats = loadTrendStats();
  // Window for NOW=2026-07-15 is 2025-07-16 .. 2026-07-15 inclusive.
  const records = [
    measured('1', '2026-07-10', { orderTotal: '$10.50' }),
    measured('2', '2026-07-10', { orderTotal: '$4.50' }),
    measured('3', '2026-07-01', { orderTotal: '$30.00' }),
    measured('4', '2025-07-20', { orderTotal: '$8.00' }), // just inside
    measured('5', '2025-07-10', { orderTotal: '$99.00' }), // just outside
    summaryOnly('6', '2026-07-12', { orderTotal: '$50.00' }), // not measured
  ];

  const heat = toPlain(TrendStats.calendarHeatmap(records, NOW));
  assert.deepEqual(heat.days, [
    { date: '2025-07-20', total: 8, count: 1 },
    { date: '2026-07-01', total: 30, count: 1 },
    { date: '2026-07-10', total: 15, count: 2 },
  ]);
  assert.equal(heat.maxTotal, 30);
});

test('fulfillmentSplit: splits comma-joined types, merges case-insensitively, even money split, Other/in-store bucketing', () => {
  const TrendStats = loadTrendStats();
  const records = [
    // Two types → the $20 total splits evenly, $10 each.
    measured('1', '2026-05-01', { orderTotal: '$20.00' }, { fulfillmentTypes: 'Delivery, Pickup' }),
    // Invoice-side fallback + lowercase merges into the existing Delivery bucket.
    measured('2', '2026-05-02', { orderTotal: '$5.00', fulfillmentTypes: 'delivery' }),
    // No fulfillment info anywhere → Other.
    measured('3', '2026-05-03', { orderTotal: '$7.00' }),
    // In-store invoices carry isInStore instead of a fulfillment string.
    measured('4', '2026-05-04', { orderTotal: '$3.00', isInStore: true }),
    // Summary-only: excluded even though it names a type.
    summaryOnly('5', '2026-05-05', { orderTotal: '$400.00', fulfillmentTypes: 'Delivery' }),
  ];

  assert.deepEqual(toPlain(TrendStats.fulfillmentSplit(records)), [
    { type: 'Delivery', count: 2, total: 15 }, // display keeps first-seen casing
    { type: 'Pickup', count: 1, total: 10 },
    { type: 'Other', count: 1, total: 7 },
    { type: 'In-store', count: 1, total: 3 },
  ]);
});

test('orderSizeHistogram: half-open [min, max) buckets — exactly $25 lands in $25–50; zero/missing totals are skipped', () => {
  const TrendStats = loadTrendStats();
  const records = [
    measured('1', '2026-05-01', { orderTotal: '$24.99' }),
    measured('2', '2026-05-02', { orderTotal: '$25.00' }), // boundary → $25–50
    measured('3', '2026-05-03', { orderTotal: '$49.99' }),
    measured('4', '2026-05-04', { orderTotal: '$50.00' }), // boundary → $50–100
    measured('5', '2026-05-05', { orderTotal: '$100.00' }), // boundary → $100–200
    measured('6', '2026-05-06', { orderTotal: '$199.99' }),
    measured('7', '2026-05-07', { orderTotal: '$200.00' }), // boundary → $200+
    measured('8', '2026-05-08', { orderTotal: '$1,234.56' }),
    measured('9', '2026-05-09', { orderTotal: '' }), // no resolvable total → skipped
    summaryOnly('10', '2026-05-10', { orderTotal: '$30.00' }), // not measured → skipped
  ];

  assert.deepEqual(toPlain(TrendStats.orderSizeHistogram(records)), [
    { label: '$0–25', count: 1 },
    { label: '$25–50', count: 2 },
    { label: '$50–100', count: 1 },
    { label: '$100–200', count: 2 },
    { label: '$200+', count: 2 },
  ]);
});

test('dayOfWeekPattern: 7 fixed Sun..Sat buckets with order counts and totals; undated records are skipped', () => {
  const TrendStats = loadTrendStats();
  const records = [
    measured('1', '2026-07-12', { orderTotal: '$10.00' }), // Sunday
    measured('2', '2026-07-12', { orderTotal: '$20.00' }), // Sunday
    measured('3', '2026-07-13', { orderTotal: '$5.00' }), // Monday
    // No date anywhere → contributes to nothing.
    { orderNumber: '4', orderDate: '', summary: {}, invoice: { schemaVersion: 3, orderTotal: '$9.99' } },
  ];

  const pattern = toPlain(TrendStats.dayOfWeekPattern(records));
  assert.equal(pattern.length, 7);
  assert.deepEqual(pattern.map((entry) => entry.day), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  assert.deepEqual(pattern[0], { day: 'Sun', count: 2, total: 30 });
  assert.deepEqual(pattern[1], { day: 'Mon', count: 1, total: 5 });
  assert.deepEqual(pattern[2], { day: 'Tue', count: 0, total: 0 });
});

test('moneyComposition: per-month invoice→summary field pairs, "$1,234.56" parsing, missing fields, negative savings, gap zero-fill, range scoping', () => {
  const TrendStats = loadTrendStats();
  const records = [
    measured('1', '2026-05-10', {
      orderSubtotal: '$1,234.56',
      tax: '$88.00',
      tip: '', // must fall back to summary.driverTip
      deliveryCharges: '$5.00',
      bagFee: '$0.25',
      savings: '', // must fall back to summary.savings
    }, {
      driverTip: '$7.00',
      savings: '$3.10',
    }),
    // Everything missing on the invoice; subtotal from the summary, and a
    // stored NEGATIVE savings value keeps its sign (never Math.abs'd).
    measured('2', '2026-07-04', { savings: '-$2.00' }, { subTotal: '$40.00' }),
    // Outside 'thisYear' → excluded entirely.
    measured('3', '2025-05-01', { orderSubtotal: '$500.00' }),
    // Summary-only → excluded entirely.
    summaryOnly('4', '2026-06-06', { subTotal: '$60.00' }),
  ];

  assert.deepEqual(toPlain(TrendStats.moneyComposition(records, 'thisYear', NOW)), [
    { month: '2026-05', subtotal: 1234.56, tax: 88, tip: 7, fees: 5.25, savings: 3.1 },
    { month: '2026-06', subtotal: 0, tax: 0, tip: 0, fees: 0, savings: 0 }, // gap zero-filled
    { month: '2026-07', subtotal: 40, tax: 0, tip: 0, fees: 0, savings: -2 },
  ]);
});

test('every TrendStats function tolerates junk input (null/undefined/non-arrays) without throwing', () => {
  const TrendStats = loadTrendStats();
  assert.deepEqual(toPlain(TrendStats.cumulativeByMonth(null, 'all', NOW)), []);
  assert.deepEqual(toPlain(TrendStats.yearOverYear(undefined, NOW)), { years: [] });
  assert.deepEqual(toPlain(TrendStats.calendarHeatmap(null, NOW)), { days: [], maxTotal: 0 });
  assert.deepEqual(toPlain(TrendStats.fulfillmentSplit(undefined)), []);
  assert.equal(TrendStats.orderSizeHistogram(null).length, 5);
  assert.equal(TrendStats.dayOfWeekPattern({}).length, 7);
  assert.deepEqual(toPlain(TrendStats.moneyComposition(undefined, 'thisYear', NOW)), []);
});
