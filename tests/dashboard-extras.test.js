'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, evalIn, toPlain } = require('./helpers/sandbox');

/**
 * dashboard.view-extras.js is half pure helpers (the OverviewExtras global
 * under test here) and half DOM rendering that registers with the page's
 * WIEDash view registry — a bare registry stub satisfies that half so the
 * file loads in the vm sandbox without a dashboard page.
 */
function loadExtrasSandbox() {
  const sandbox = loadSandbox({ scripts: ['utils.js', 'sidepanel.dashboard.js'] });
  evalIn(sandbox, 'globalThis.WIEDash = { registerOverviewExtra() {} };');
  sandbox.importScripts('dashboard.view-extras.js');
  return sandbox;
}

/** Minimal OrderDb-shaped record builder (no real order data). */
function record(orderNumber, isoDate, { invoice = null, summary = {} } = {}) {
  return {
    orderNumber,
    orderDate: isoDate,
    summary: { orderDate: isoDate, ...summary },
    invoice,
  };
}

/* ------------------------------------------------------------------ *
 * monthSpend
 * ------------------------------------------------------------------ */

test('monthSpend counts only the current calendar month, invoice total beating the summary', () => {
  const sandbox = loadExtrasSandbox();
  const now = new Date(2026, 6, 15); // Jul 15, 2026
  const result = toPlain(sandbox.OverviewExtras.monthSpend([
    // Measured invoice in July: its own total wins over the summary's $99.99.
    record('111111111111111', '2026-07-03T10:00:00.000Z', {
      summary: { orderTotal: '$99.99' },
      invoice: { schemaVersion: 3, orderTotal: '$24.11' },
    }),
    // Summary-only July order still budgets via its summary total.
    record('222222222222222', '2026-07-10T09:00:00.000Z', {
      summary: { orderTotal: '$10.00' },
    }),
    // June order: outside the current month, excluded entirely.
    record('333333333333333', '2026-06-20T12:00:00.000Z', {
      summary: { orderTotal: '$50.00' },
      invoice: { schemaVersion: 3, orderTotal: '$50.00' },
    }),
    // Undated record: can't be placed in any month, excluded.
    { orderNumber: '444444444444444', summary: { orderTotal: '$99.00' } },
  ], now));

  assert.deepEqual(result, { spent: 34.11, orderCount: 2 });
});

test('monthSpend falls back to the summary total per record (fast-path and pre-v3 invoices)', () => {
  const sandbox = loadExtrasSandbox();
  const now = new Date(2026, 6, 15);
  const result = toPlain(sandbox.OverviewExtras.monthSpend([
    // Fast (SSR-fetch) invoice: measured but no price block — summary total wins.
    record('111111111111111', '2026-07-05T10:00:00.000Z', {
      summary: { orderTotal: '$76.88' },
      invoice: { schemaVersion: 3, orderTotal: '', items: [{ productName: 'X', quantity: 1 }] },
    }),
    // Pre-v3 invoice: untrusted values — the summary total is used instead.
    record('222222222222222', '2026-07-08T10:00:00.000Z', {
      summary: { orderTotal: '$45.00' },
      invoice: { schemaVersion: 1, orderTotal: '$50.00' },
    }),
    // No total anywhere: contributes nothing and is not counted.
    record('333333333333333', '2026-07-09T10:00:00.000Z', { summary: {} }),
  ], now));

  assert.deepEqual(result, { spent: 121.88, orderCount: 2 });
});

/* ------------------------------------------------------------------ *
 * budgetProjection
 * ------------------------------------------------------------------ */

test('budgetProjection extrapolates the month-to-date pace to month end', () => {
  const sandbox = loadExtrasSandbox();
  // $150 by Jul 10 → $15/day → $465 across July's 31 days.
  const result = toPlain(sandbox.OverviewExtras.budgetProjection(150, new Date(2026, 6, 10)));
  assert.deepEqual(result, { perDay: 15, projected: 465, daysElapsed: 10, daysInMonth: 31 });
});

test('budgetProjection guards day 1 (no divide-by-zero, full-month extrapolation)', () => {
  const sandbox = loadExtrasSandbox();
  const result = toPlain(sandbox.OverviewExtras.budgetProjection(40, new Date(2026, 6, 1)));
  assert.deepEqual(result, { perDay: 40, projected: 1240, daysElapsed: 1, daysInMonth: 31 });

  // Zero spend projects zero, never NaN.
  const zero = toPlain(sandbox.OverviewExtras.budgetProjection(0, new Date(2026, 6, 1)));
  assert.deepEqual(zero, { perDay: 0, projected: 0, daysElapsed: 1, daysInMonth: 31 });
});

test('budgetProjection uses the real month length (non-leap February)', () => {
  const sandbox = loadExtrasSandbox();
  // 2026 is not a leap year: February has 28 days. $140 by Feb 14 → $10/day.
  const result = toPlain(sandbox.OverviewExtras.budgetProjection(140, new Date(2026, 1, 14)));
  assert.deepEqual(result, { perDay: 10, projected: 280, daysElapsed: 14, daysInMonth: 28 });
});

/* ------------------------------------------------------------------ *
 * refundSummary
 * ------------------------------------------------------------------ */

test('refundSummary parses "$" strings invoice-first with summary fallback, skipping empty/zero', () => {
  const sandbox = loadExtrasSandbox();
  const result = toPlain(sandbox.OverviewExtras.refundSummary([
    // Invoice refund wins over the summary's value (moneyOf pairing).
    record('111111111111111', '2026-07-03T10:00:00.000Z', {
      summary: { refund: '$99.99' },
      invoice: { schemaVersion: 3, refund: '$3.98' },
    }),
    // Summary-only refund still counts.
    record('222222222222222', '2026-06-14T09:00:00.000Z', {
      summary: { refund: '$12.34' },
    }),
    // Empty, zero, and missing refund fields are all skipped.
    record('333333333333333', '2026-05-01T09:00:00.000Z', { summary: { refund: '' } }),
    record('444444444444444', '2026-05-02T09:00:00.000Z', { summary: { refund: '$0.00' } }),
    record('555555555555555', '2026-05-03T09:00:00.000Z', { summary: {} }),
  ]));

  assert.deepEqual(result, {
    total: 16.32,
    count: 2,
    orders: [
      // Sorted by refund size, largest first, with resolved ISO dates.
      { orderNumber: '222222222222222', date: '2026-06-14', refund: 12.34 },
      { orderNumber: '111111111111111', date: '2026-07-03', refund: 3.98 },
    ],
  });
});

test('refundSummary caps the list at the top 5 while total/count cover every refund', () => {
  const sandbox = loadExtrasSandbox();
  const records = [1, 2, 3, 4, 5, 6, 7].map((n) =>
    record(`${n}00000000000000`, `2026-07-0${n}T10:00:00.000Z`, {
      summary: { refund: `$${n}.00` },
    }));
  const result = toPlain(sandbox.OverviewExtras.refundSummary(records));

  assert.equal(result.count, 7, 'count covers every refunded order');
  assert.equal(result.total, 28, 'total sums all refunds, not just the listed five');
  assert.equal(result.orders.length, 5, 'the list itself is capped at 5');
  assert.deepEqual(result.orders.map((order) => order.refund), [7, 6, 5, 4, 3]);
});

test('refundSummary zero case: no refunds → empty summary (card hides on this)', () => {
  const sandbox = loadExtrasSandbox();
  assert.deepEqual(toPlain(sandbox.OverviewExtras.refundSummary([])), {
    total: 0,
    count: 0,
    orders: [],
  });
  // Records without any refund fields behave the same as an empty DB.
  assert.deepEqual(
    toPlain(sandbox.OverviewExtras.refundSummary([
      record('111111111111111', '2026-07-03T10:00:00.000Z', { summary: { orderTotal: '$5.00' } }),
    ])),
    { total: 0, count: 0, orders: [] }
  );
});
