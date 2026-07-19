'use strict';

/**
 * Pure-logic tests for the v7.1 order list redesign (spec addendum
 * 2026-07-17): the row model builder and the "Showing" date-range filter.
 * The DOM assembly that consumes these (sidepanel.view.js's
 * displayOrderNumbers) is not unit-testable here — tests/helpers/sandbox.js's
 * document stub returns null/[] from every getElementById/querySelector
 * regardless of what's actually been appended, matching how the rest of
 * this suite already only covers view.js's DOM-free logic (see
 * sidepanel.actions.test.js's displayOrderNumbers spy).
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadSandbox, toPlain } from './helpers/sandbox';

function loadUtils() {
  return loadSandbox({ scripts: ['utils.js'] });
}

// ---------------------------------------------------------------------------
// parseWalmartTitleDate — dates recovered from Walmart's own title text
// ---------------------------------------------------------------------------

test('parseWalmartTitleDate: parses "Mon D, YYYY" title variants, requires an explicit year', () => {
  const sandbox = loadUtils();
  assert.equal(sandbox.parseWalmartTitleDate('Jun 15, 2022 order'), '2022-06-15');
  assert.equal(sandbox.parseWalmartTitleDate('June 15, 2022 purchase'), '2022-06-15');
  assert.equal(sandbox.parseWalmartTitleDate('Sep. 3, 2023 order'), '2023-09-03');
  assert.equal(sandbox.parseWalmartTitleDate('Dec 31 2021 order'), '2021-12-31');
  // Year-less delivery strings are ambiguous — must NOT guess a year.
  assert.equal(sandbox.parseWalmartTitleDate('Delivered on Jun 23'), '');
  assert.equal(sandbox.parseWalmartTitleDate(''), '');
  assert.equal(sandbox.parseWalmartTitleDate('Canceled'), '');
});

test('buildOrderRowModel: undated record falls back to the Walmart title date (old orders, issue: NO DATE pile)', () => {
  const sandbox = loadUtils();

  const fromRecordTitle = sandbox.buildOrderRowModel('11', {
    title: 'Jun 15, 2022 order',
    summary: { orderTotal: '$10.00', status: 'Delivered' },
  });
  assert.equal(fromRecordTitle.normalizedDate, '2022-06-15');

  const fromSessionTitle = sandbox.buildOrderRowModel('12', null, 'Mar 2, 2021 order');
  assert.equal(fromSessionTitle.normalizedDate, '2021-03-02');

  // A real stored date always wins over the title.
  const datedRecord = sandbox.buildOrderRowModel('13', {
    title: 'Jun 15, 2022 order',
    summary: { orderDate: '2026-01-05T00:00:00' },
  });
  assert.equal(datedRecord.normalizedDate, '2026-01-05');

  // No date anywhere and no parseable title → still undated.
  const undated = sandbox.buildOrderRowModel('14', { title: 'Delivered on Jun 23' });
  assert.equal(undated.normalizedDate, '');
});

test('buildOrderRowModel: the request order date WINS over the delivery date when both are present', () => {
  const sandbox = loadUtils();

  // A PurchaseHistoryV3 summary carries the specific order date (orderDate) AND
  // a later delivery date. The row must show the ORDER date, never delivery.
  const row = sandbox.buildOrderRowModel('30', {
    title: 'Mar 04, 2026 order',
    summary: {
      orderDate: '2026-03-04T17:59:29-08:00', // when the order was placed
      deliveredDate: '2026-03-09T16:40:21-05:00', // 5 days later — must NOT win
    },
  });

  assert.equal(row.normalizedDate, '2026-03-04', 'uses the order date from the request, not the delivery date');
});

test('buildOrderRowModel: undated record falls back to the delivered date before the title', () => {
  const sandbox = loadUtils();

  // List summaries store the delivery group timestamp as ISO.
  const fromSummary = sandbox.buildOrderRowModel('21', {
    title: 'Jun 15, 2022 order',
    summary: { deliveredDate: '2022-06-17T14:03:00-05:00' },
  });
  assert.equal(fromSummary.normalizedDate, '2022-06-17');

  // Invoices store it human-formatted, possibly ';'-joined across shipments.
  const fromInvoice = sandbox.buildOrderRowModel('22', {
    invoice: { deliveredDate: 'Jul 02, 2023; Jul 04, 2023' },
  });
  assert.equal(fromInvoice.normalizedDate, '2023-07-02');
});

// ---------------------------------------------------------------------------
// buildOrderRowModel
// ---------------------------------------------------------------------------

test('buildOrderRowModel: prefers summary.orderDate, falls back to record.orderDate, then invoice.orderDate', () => {
  const sandbox = loadUtils();

  const bySummary = sandbox.buildOrderRowModel('1', {
    orderDate: '2026-01-01',
    summary: { orderDate: '2026-06-14T00:00:00.000Z' },
    invoice: { orderDate: '2026-12-25' },
  });
  assert.equal(bySummary.normalizedDate, '2026-06-14');

  const byRecord = sandbox.buildOrderRowModel('2', {
    orderDate: '2026-01-01',
    summary: null,
    invoice: { orderDate: '2026-12-25' },
  });
  assert.equal(byRecord.normalizedDate, '2026-01-01');

  const byInvoice = sandbox.buildOrderRowModel('3', {
    orderDate: '',
    summary: null,
    invoice: { orderDate: 'Dec 25, 2026' },
  });
  assert.equal(byInvoice.normalizedDate, '2026-12-25');
});

test('buildOrderRowModel: a bare order number with no record at all still produces a usable (undated, no-invoice) row', () => {
  const sandbox = loadUtils();
  const row = sandbox.buildOrderRowModel('12345678901234', undefined, undefined);
  assert.equal(row.orderNumber, '12345678901234');
  assert.equal(row.normalizedDate, '');
  assert.equal(row.status, '');
  assert.equal(row.itemCount, '');
  assert.equal(row.total, '');
  assert.equal(row.hasInvoice, false);
  assert.deepEqual(toPlain(row.summaryItems), []);
  assert.equal(row.title, '');
});

test('buildOrderRowModel: status is the first ";"-separated segment of summary.status', () => {
  const sandbox = loadUtils();
  const row = sandbox.buildOrderRowModel('1', { summary: { status: 'Delivered; Refunded' } });
  assert.equal(row.status, 'Delivered');

  const noStatus = sandbox.buildOrderRowModel('2', { summary: { status: '' } });
  assert.equal(noStatus.status, '');
});

test('buildOrderRowModel: itemCount prefers summary.itemCount, falls back to invoice.items.length', () => {
  const sandbox = loadUtils();

  const fromSummary = sandbox.buildOrderRowModel('1', { summary: { itemCount: 5 }, invoice: { items: [{}, {}] } });
  assert.equal(fromSummary.itemCount, 5);

  const fromInvoice = sandbox.buildOrderRowModel('2', {
    summary: null,
    invoice: { schemaVersion: 3, items: [{}, {}, {}] },
  });
  assert.equal(fromInvoice.itemCount, 3);

  const neither = sandbox.buildOrderRowModel('3', { summary: {}, invoice: null });
  assert.equal(neither.itemCount, '');
});

test('buildOrderRowModel: hasInvoice requires BOTH a stored invoice AND schemaVersion >= ORDER_SCHEMA_VERSION', () => {
  const sandbox = loadUtils();

  const current = sandbox.buildOrderRowModel('1', { invoice: { schemaVersion: 3, items: [] } });
  assert.equal(current.hasInvoice, true);

  const stale = sandbox.buildOrderRowModel('2', { invoice: { schemaVersion: 2, items: [] } });
  assert.equal(stale.hasInvoice, false, 'a pre-v3 invoice must not be trusted for the "✓ saved" chip either');

  const none = sandbox.buildOrderRowModel('3', { invoice: null });
  assert.equal(none.hasInvoice, false);
});

test('buildOrderRowModel: summaryItems maps name/quantity only, defensively, for summary-only rows', () => {
  const sandbox = loadUtils();
  const row = sandbox.buildOrderRowModel('1', {
    summary: { items: [{ name: 'Milk', quantity: 2 }, { name: '', quantity: undefined }] },
  });
  assert.deepEqual(toPlain(row.summaryItems), [
    { name: 'Milk', quantity: 2 },
    { name: '', quantity: '' },
  ]);
});

test('buildOrderRowModel: a session title (live collection overlay) wins over the stored record title', () => {
  const sandbox = loadUtils();
  const row = sandbox.buildOrderRowModel('1', { title: 'Stored title' }, 'Fresh session title');
  assert.equal(row.title, 'Fresh session title');

  const fallback = sandbox.buildOrderRowModel('2', { title: 'Stored title' }, undefined);
  assert.equal(fallback.title, 'Stored title');
});

// ---------------------------------------------------------------------------
// monthGroupLabel / formatRowDateShort
// ---------------------------------------------------------------------------

test('monthGroupLabel: uppercase "MONTH YEAR", or "NO DATE" when unknown', () => {
  const sandbox = loadUtils();
  assert.equal(sandbox.monthGroupLabel('2026-07-09'), 'JULY 2026');
  assert.equal(sandbox.monthGroupLabel('2025-01-01'), 'JANUARY 2025');
  assert.equal(sandbox.monthGroupLabel(''), 'NO DATE');
});

test('formatRowDateShort: short "Mon D" format, empty when unknown', () => {
  const sandbox = loadUtils();
  assert.equal(sandbox.formatRowDateShort('2026-07-09'), 'Jul 9');
  assert.equal(sandbox.formatRowDateShort(''), '');
});

// ---------------------------------------------------------------------------
// Date-range bucketing (the "Showing" filter, spec §D)
// ---------------------------------------------------------------------------

const NOW = new Date('2026-07-17T12:00:00.000Z');

test('getRangeBounds: last3/last6 are inclusive [N months ago, today]; thisYear/lastYear are full calendar years', () => {
  const sandbox = loadUtils();
  assert.deepEqual(toPlain(sandbox.getRangeBounds('last3', NOW)), { from: '2026-04-17', to: '2026-07-17' });
  assert.deepEqual(toPlain(sandbox.getRangeBounds('last6', NOW)), { from: '2026-01-17', to: '2026-07-17' });
  assert.deepEqual(toPlain(sandbox.getRangeBounds('thisYear', NOW)), { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(toPlain(sandbox.getRangeBounds('lastYear', NOW)), { from: '2025-01-01', to: '2025-12-31' });
  assert.deepEqual(toPlain(sandbox.getRangeBounds('all', NOW)), { from: null, to: null });
});

test('getRangeBounds: custom uses the given from/to verbatim, null when blank', () => {
  const sandbox = loadUtils();
  assert.deepEqual(toPlain(sandbox.getRangeBounds('custom', NOW, '2026-01-01', '2026-02-01')), {
    from: '2026-01-01',
    to: '2026-02-01',
  });
  assert.deepEqual(toPlain(sandbox.getRangeBounds('custom', NOW, '', '')), { from: null, to: null });
});

test('isDateInRange: undated never matches a bounded range; bounds are inclusive', () => {
  const sandbox = loadUtils();
  const bounds = { from: '2026-01-01', to: '2026-12-31' };
  assert.equal(sandbox.isDateInRange('', bounds), false);
  assert.equal(sandbox.isDateInRange('2026-01-01', bounds), true);
  assert.equal(sandbox.isDateInRange('2026-12-31', bounds), true);
  assert.equal(sandbox.isDateInRange('2025-12-31', bounds), false);
  assert.equal(sandbox.isDateInRange('2027-01-01', bounds), false);
});

test('filterOrderRowsByRange: "all" is a pass-through that keeps undated rows, reporting zero hidden', () => {
  const sandbox = loadUtils();
  const rows = [{ normalizedDate: '2026-07-01' }, { normalizedDate: '' }];
  const result = toPlain(sandbox.filterOrderRowsByRange(rows, 'all', { now: NOW }));
  assert.equal(result.visible.length, 2);
  assert.equal(result.hiddenUndatedCount, 0);
});

test('filterOrderRowsByRange: a bounded range hides undated rows and reports how many', () => {
  const sandbox = loadUtils();
  const rows = [
    { normalizedDate: '2026-07-01' }, // within last3
    { normalizedDate: '2025-01-01' }, // outside last3
    { normalizedDate: '' },           // undated
    { normalizedDate: '' },           // undated
  ];
  const result = toPlain(sandbox.filterOrderRowsByRange(rows, 'last3', { now: NOW }));
  assert.equal(result.visible.length, 1);
  assert.equal(result.visible[0].normalizedDate, '2026-07-01');
  assert.equal(result.hiddenUndatedCount, 2);
});

test('filterOrderRowsByRange: custom range with no dates entered yet shows everything dated (unbounded)', () => {
  const sandbox = loadUtils();
  const rows = [{ normalizedDate: '2020-01-01' }, { normalizedDate: '2030-01-01' }];
  const result = toPlain(sandbox.filterOrderRowsByRange(rows, 'custom', { now: NOW, customFrom: '', customTo: '' }));
  assert.equal(result.visible.length, 2);
});

// ---------------------------------------------------------------------------
// getRangeLabelSuffix (filename suffix, spec §D)
// ---------------------------------------------------------------------------

test('getRangeLabelSuffix: all-time is unsuffixed; every other range has a distinct, deterministic suffix', () => {
  const sandbox = loadUtils();
  assert.equal(sandbox.getRangeLabelSuffix('all', NOW), '');
  assert.equal(sandbox.getRangeLabelSuffix(undefined, NOW), '');
  assert.equal(sandbox.getRangeLabelSuffix('last3', NOW), '_Last_3_Months');
  assert.equal(sandbox.getRangeLabelSuffix('last6', NOW), '_Last_6_Months');
  assert.equal(sandbox.getRangeLabelSuffix('thisYear', NOW), '_2026');
  assert.equal(sandbox.getRangeLabelSuffix('lastYear', NOW), '_2025');
  assert.equal(sandbox.getRangeLabelSuffix('custom', NOW), '_Custom');
});

// ---------------------------------------------------------------------------
// groupSelectionState (month-header "select all in this month", 2026-07-18):
// the pure rule behind the month-group checkbox's checked/indeterminate state.
// ---------------------------------------------------------------------------

test('groupSelectionState: none selected → unchecked; some → indeterminate; all → checked', () => {
  const sandbox = loadUtils();
  assert.deepEqual(toPlain(sandbox.groupSelectionState(4, 0)), { checked: false, indeterminate: false });
  assert.deepEqual(toPlain(sandbox.groupSelectionState(4, 1)), { checked: false, indeterminate: true });
  assert.deepEqual(toPlain(sandbox.groupSelectionState(4, 3)), { checked: false, indeterminate: true });
  assert.deepEqual(toPlain(sandbox.groupSelectionState(4, 4)), { checked: true, indeterminate: false });
});

test('groupSelectionState: an empty group is never checked or indeterminate', () => {
  const sandbox = loadUtils();
  assert.deepEqual(toPlain(sandbox.groupSelectionState(0, 0)), { checked: false, indeterminate: false });
});
