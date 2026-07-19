'use strict';

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadSandbox, toPlain, evalIn } from './helpers/sandbox';

function loadDashboardSandbox() {
  return loadSandbox({ scripts: ['utils.js', 'sidepanel.dashboard.js'] });
}

/** Synthetic OrderDb-shaped records (no real order data). */
function syntheticRecords() {
  return [
    {
      orderNumber: '111111111111111',
      orderDate: '2026-05-03T10:00:00.000Z',
      title: 'Grocery order',
      summary: {
        orderDate: '2026-05-03T10:00:00.000Z',
        itemCount: 2,
        orderTotal: '$99.99', // must lose to the invoice total below
        subTotal: '$90.00',
        driverTip: '$9.99', // must lose to the invoice tip below
        status: 'Delivered',
        items: [
          { name: 'Test Milk 1 Gallon', quantity: 2 },
          { name: 'Test Bananas, each', quantity: 6 },
        ],
      },
      invoice: {
       schemaVersion: 3,
        schemaVersion: 3,
        orderTotal: '$24.11',
        orderSubtotal: '$18.53',
        savings: '$2.00',
        tax: '$1.14',
        tip: '$4.00',
        refund: '$3.98',
        donations: '$1.00',
        items: [
          { productName: 'Test Milk 1 Gallon', quantity: '2', price: '$7.96' },
          { productName: 'Test Bananas, each', quantity: '6', price: '$1.62' },
        ],
      },
      firstSeenAt: 1780000000000,
      updatedAt: 1780000000000,
    },
    {
      orderNumber: '222222222222222',
      orderDate: '2026-06-14T09:00:00.000Z',
      title: 'Summary-only order',
      summary: {
        orderDate: '2026-06-14T09:00:00.000Z',
        itemCount: 2,
        orderTotal: '$10.00',
        subTotal: '$9.00',
        driverTip: '$1.50',
        status: 'Delivered',
        items: [
          { name: 'Test Milk 1 Gallon', quantity: 1 },
          { name: 'Test Paper Towels 6-pack', quantity: 1 },
        ],
      },
      invoice: null,
      firstSeenAt: 1780000000000,
      updatedAt: 1780000000000,
    },
    {
      // Deliberately out of date order to prove monthly sorting.
      orderNumber: '333333333333333',
      orderDate: '2026-04-20T12:00:00.000Z',
      title: 'Earlier order',
      summary: {
        orderDate: '2026-04-20T12:00:00.000Z',
        itemCount: 1,
        orderTotal: '$5.89',
        subTotal: '$5.50',
        driverTip: '',
        status: 'Delivered',
        items: [{ name: 'Test Milk 1 Gallon', quantity: 1 }],
      },
      invoice: null,
      firstSeenAt: 1780000000000,
      updatedAt: 1780000000000,
    },
  ];
}

test('computeDashboardStats measures ONLY fully downloaded invoices — no half measurements', () => {
  const sandbox = loadDashboardSandbox();
  const stats = sandbox.computeDashboardStats(syntheticRecords());

  assert.equal(stats.orderCount, 3, 'stored count still reports everything for coverage display');
  assert.equal(stats.invoiceCount, 1);
  // ONLY the single invoice is measured; the two summary-only orders are excluded.
  assert.equal(stats.totalSpend, 24.11);
  assert.equal(stats.avgOrder, 24.11);
  assert.equal(stats.totalTips, 4);
  assert.equal(stats.totalSavings, 2);
  assert.equal(stats.totalTax, 1.14);
  assert.equal(stats.totalRefunds, 3.98);
  assert.equal(stats.totalDonations, 1);
});

test('computeDashboardStats falls back to the summary total when a measured invoice has no total (fast-path invoices)', () => {
  const sandbox = loadDashboardSandbox();
  // The fast (in-page fetch) invoice path stores line items but the SSR order
  // node carries no price block, so invoice.orderTotal comes back empty even
  // though the order IS a full, measured invoice. The purchase-history summary
  // still has the total — measure with it instead of showing $0.
  const stats = sandbox.computeDashboardStats([
    {
      orderNumber: '555',
      orderDate: '2026-06-01T00:00:00.000Z',
      summary: {
        orderDate: '2026-06-01T00:00:00.000Z',
        orderTotal: '$76.88',
        savings: '$5.00',
        tax: '$4.20',
        driverTip: '$3.00',
        subTotal: '$64.68',
      },
      invoice: { schemaVersion: 3, orderTotal: '', items: [{ productName: 'X', quantity: 1 }] },
    },
  ]);
  assert.equal(stats.invoiceCount, 1, 'still counts as a measured invoice');
  assert.equal(stats.totalSpend, 76.88, 'total comes from the summary, not $0');
  assert.equal(stats.monthly[0].total, 76.88, 'monthly bucket uses the fallback total too');
  // Savings/tax/tips also fall back to the summary (the fast payload carries them).
  assert.equal(stats.totalSavings, 5, 'savings falls back to the summary');
  assert.equal(stats.totalTax, 4.2, 'tax falls back to the summary');
  assert.equal(stats.totalTips, 3, 'tips fall back to the summary driverTip');
  assert.equal(stats.totalSubtotal, 64.68, 'subtotal falls back to the summary');
});

test('computeDashboardStats groups monthly spend by ISO month, sorted ascending', () => {
  const sandbox = loadDashboardSandbox();
  const stats = sandbox.computeDashboardStats(syntheticRecords());

  // Only invoice-backed orders appear in the monthly bars.
  assert.deepEqual(toPlain(stats.monthly), [
    { month: '2026-05', total: 24.11, orders: 1 },
  ]);
});

test('computeDashboardStats topItems keeps only items bought in more than one order', () => {
  const sandbox = loadDashboardSandbox();
  const stats = sandbox.computeDashboardStats(syntheticRecords());

  // Only invoice items count; the single invoice has no repeat purchases.
  assert.equal(stats.topItems.length, 0);
});

test('computeDashboardStats counts an item once per order even when duplicated in it', () => {
  const sandbox = loadDashboardSandbox();
  const records = [
    {
      orderNumber: '1',
      orderDate: '2026-01-01T00:00:00.000Z',
      summary: null,
      invoice: {
       schemaVersion: 3,
        schemaVersion: 3,
        orderTotal: '$4.00',
        items: [
          { productName: 'Test Soda', quantity: '1', price: '$2.00' },
          { productName: 'Test Soda', quantity: '1', price: '$2.00' },
        ],
      },
    },
    {
      orderNumber: '2',
      orderDate: '2026-02-01T00:00:00.000Z',
      summary: null,
      invoice: {
       schemaVersion: 3,
        schemaVersion: 3,
        orderTotal: '$2.00',
        items: [{ productName: 'Test Soda', quantity: '1', price: '$2.00' }],
      },
    },
  ];

  const stats = sandbox.computeDashboardStats(records);
  assert.deepEqual(toPlain(stats.topItems), [{ name: 'Test Soda', orders: 2, quantity: 3, spend: 6 }]);
});

test('computeDashboardStats buckets monthly spend for human-format and invoice-only dates', () => {
  const sandbox = loadDashboardSandbox();
  const stats = sandbox.computeDashboardStats([
    // Human-format record date (DOM-collected order later deep-downloaded)
    { orderNumber: '1', orderDate: 'Jun 14, 2026', summary: null, invoice: { schemaVersion: 3, orderTotal: '$20.00', items: [] } },
    // No record/summary date at all — invoice's own date is the fallback
    { orderNumber: '2', orderDate: '', summary: null, invoice: { schemaVersion: 3, orderDate: 'Jun 20, 2026', orderTotal: '$5.65', items: [] } },
    { orderNumber: '3', orderDate: '2026-06-01T00:00:00Z', summary: null, invoice: { schemaVersion: 3, orderTotal: '$1.84', items: [] } },
  ]);

  assert.equal(stats.totalSpend, 27.49);
  // Every dollar of measured spend must land in a month bucket.
  assert.deepEqual(toPlain(stats.monthly), [{ month: '2026-06', total: 27.49, orders: 3 }]);
});

test('computeDashboardStats rounds money to cents', () => {
  const sandbox = loadDashboardSandbox();
  const records = [
    { orderNumber: '1', orderDate: '2026-03-01T00:00:00.000Z', summary: null, invoice: { schemaVersion: 3, orderTotal: '$0.10', items: [] } },
    { orderNumber: '2', orderDate: '2026-03-02T00:00:00.000Z', summary: null, invoice: { schemaVersion: 3, orderTotal: '$0.20', items: [] } },
    { orderNumber: '3', orderDate: '2026-03-03T00:00:00.000Z', summary: null, invoice: { schemaVersion: 3, orderTotal: '$0.40', items: [] } },
  ];

  const stats = sandbox.computeDashboardStats(records);
  // 0.1 + 0.2 + 0.4 drifts in floating point without rounding.
  assert.equal(stats.totalSpend, 0.7);
  assert.equal(stats.monthly[0].total, 0.7);
  assert.equal(stats.avgOrder, 0.23);
});

test('computeDashboardStats handles empty and malformed input', () => {
  const sandbox = loadDashboardSandbox();

  for (const input of [[], null, undefined]) {
    const stats = sandbox.computeDashboardStats(input);
    assert.equal(stats.orderCount, 0);
    assert.equal(stats.invoiceCount, 0);
    assert.equal(stats.totalSpend, 0);
    assert.equal(stats.avgOrder, 0);
    assert.deepEqual(toPlain(stats.monthly), []);
    assert.deepEqual(toPlain(stats.topItems), []);
  }

  // Records with no summary/invoice/date must not throw.
  const stats = sandbox.computeDashboardStats([{ orderNumber: '9' }]);
  assert.equal(stats.orderCount, 1);
  assert.equal(stats.totalSpend, 0);
});

/** Build a minimal invoice-bearing record for price-history tests. */
function invoiceRecord(orderNumber, isoDate, items) {
  return {
    orderNumber,
    orderDate: isoDate,
    summary: null,
    invoice: { schemaVersion: 3, orderTotal: '$10.00', items },
  };
}

test('computePriceHistory tracks unit prices across orders with quantity math', () => {
  const sandbox = loadDashboardSandbox();
  const records = [
    // Later order first to prove points get sorted by date.
    invoiceRecord('2', '2026-06-01T00:00:00.000Z', [
      { productName: 'Test Milk 1 Gallon', usItemId: '10450114', quantity: '1', price: '$4.49' },
    ]),
    invoiceRecord('1', '2026-05-01T00:00:00.000Z', [
      // Line price $7.96 for quantity 2 → unit price $3.98
      { productName: 'Test Milk 1 Gallon', usItemId: '10450114', quantity: '2', price: '$7.96' },
    ]),
  ];

  const history = toPlain(sandbox.computePriceHistory(records));
  assert.equal(history.length, 1);
  assert.deepEqual(history[0], {
    name: 'Test Milk 1 Gallon',
    usItemId: '10450114',
    points: [
      { date: '2026-05-01', unitPrice: 3.98 },
      { date: '2026-06-01', unitPrice: 4.49 },
    ],
    minPrice: 3.98,
    maxPrice: 4.49,
    latestPrice: 4.49,
    changed: true,
  });
});

test('computePriceHistory keys by usItemId when present, else normalized name', () => {
  const sandbox = loadDashboardSandbox();
  const records = [
    invoiceRecord('1', '2026-05-01T00:00:00.000Z', [
      // Same usItemId under a renamed product — must group as one item.
      { productName: 'Test Cereal 18oz', usItemId: '555', quantity: '1', price: '$3.00' },
      { productName: 'Test Eggs Dozen', quantity: '1', price: '$2.50' },
    ]),
    invoiceRecord('2', '2026-06-01T00:00:00.000Z', [
      { productName: 'Test Cereal Family Size 18oz', usItemId: '555', quantity: '1', price: '$3.50' },
      // No usItemId — falls back to case-insensitive name keying.
      { productName: 'TEST EGGS DOZEN', quantity: '1', price: '$3.10' },
    ]),
  ];

  const history = toPlain(sandbox.computePriceHistory(records));
  assert.equal(history.length, 2);

  const cereal = history.find((entry) => entry.usItemId === '555');
  assert.equal(cereal.points.length, 2);
  assert.equal(cereal.name, 'Test Cereal 18oz');

  const eggs = history.find((entry) => entry.usItemId === '');
  assert.equal(eggs.name, 'Test Eggs Dozen');
  assert.deepEqual(
    eggs.points.map((point) => point.unitPrice),
    [2.5, 3.1]
  );
});

test('computePriceHistory includes stable prices with changed=false', () => {
  const sandbox = loadDashboardSandbox();
  const records = [
    invoiceRecord('1', '2026-05-01T00:00:00.000Z', [
      { productName: 'Test Bread', usItemId: '777', quantity: '1', price: '$2.48' },
    ]),
    invoiceRecord('2', '2026-06-01T00:00:00.000Z', [
      { productName: 'Test Bread', usItemId: '777', quantity: '1', price: '$2.48' },
    ]),
  ];

  const history = toPlain(sandbox.computePriceHistory(records));
  assert.equal(history.length, 1);
  assert.equal(history[0].changed, false);
  assert.equal(history[0].minPrice, 2.48);
  assert.equal(history[0].maxPrice, 2.48);
});

test('computePriceHistory excludes single-purchase items, invoiceless records, and bad quantities', () => {
  const sandbox = loadDashboardSandbox();
  const records = [
    invoiceRecord('1', '2026-05-01T00:00:00.000Z', [
      { productName: 'Test Once-Only Gadget', usItemId: '111', quantity: '1', price: '$9.99' },
      { productName: 'Test Zero Qty', usItemId: '222', quantity: '0', price: '$5.00' },
    ]),
    invoiceRecord('2', '2026-06-01T00:00:00.000Z', [
      { productName: 'Test Zero Qty', usItemId: '222', quantity: '0', price: '$6.00' },
    ]),
    {
      // Summary-only record: item names but no per-item prices → no points.
      orderNumber: '3',
      orderDate: '2026-07-01T00:00:00.000Z',
      summary: {
        orderDate: '2026-07-01T00:00:00.000Z',
        items: [{ name: 'Test Once-Only Gadget', quantity: 1 }],
      },
      invoice: null,
    },
  ];

  assert.deepEqual(toPlain(sandbox.computePriceHistory(records)), []);
  assert.deepEqual(toPlain(sandbox.computePriceHistory([])), []);
});

/*
 * Scoped dashboard model (v7.2 dashboard redesign): every number is scoped
 * by a range picker that reuses the list filter's range engine
 * (getRangeBounds), compares against the previous period, and reports
 * actionable coverage (which stored orders in range are not measured yet).
 */

/** Fixed "today" for deterministic range math: July 17, 2026 (local time). */
function fakeNow() {
  return new Date(2026, 6, 17);
}

test('computeDashboardStats reports items subtotal and fees for the ledger', () => {
  const sandbox = loadDashboardSandbox();
  const stats = sandbox.computeDashboardStats([
    {
      orderNumber: '1',
      orderDate: '2026-03-01T00:00:00.000Z',
      summary: null,
      invoice: {
        schemaVersion: 3,
        orderTotal: '$50.00',
        orderSubtotal: '$40.50',
        deliveryCharges: '$5.99',
        bagFee: '$0.25',
        items: [],
      },
    },
    {
      orderNumber: '2',
      orderDate: '2026-04-01T00:00:00.000Z',
      summary: null,
      invoice: { schemaVersion: 3, orderTotal: '$10.00', orderSubtotal: '$9.50', items: [] },
    },
  ]);

  assert.equal(stats.totalSubtotal, 50);
  assert.equal(stats.totalFees, 6.24);
});

test('computeDashboardStats topItems includes per-item spend (count AND weight)', () => {
  const sandbox = loadDashboardSandbox();
  const stats = sandbox.computeDashboardStats([
    invoiceRecord('1', '2026-05-01T00:00:00.000Z', [
      { productName: 'Test Tide Pods', quantity: '1', price: '$11.20' },
    ]),
    invoiceRecord('2', '2026-06-01T00:00:00.000Z', [
      { productName: 'Test Tide Pods', quantity: '1', price: '$12.97' },
    ]),
  ]);

  assert.deepEqual(toPlain(stats.topItems), [
    { name: 'Test Tide Pods', orders: 2, quantity: 2, spend: 24.17 },
  ]);
});

/** Records spanning this year, last year, and an undated one — for scoping tests. */
function scopedRecords() {
  return [
    invoiceRecord('202603', '2026-03-10T00:00:00.000Z', []),
    invoiceRecord('202607', '2026-07-01T00:00:00.000Z', []),
    invoiceRecord('202506', '2025-06-15T00:00:00.000Z', []),
    {
      orderNumber: '202605-summary',
      orderDate: '2026-05-05T00:00:00.000Z',
      summary: { orderDate: '2026-05-05T00:00:00.000Z', orderTotal: '$20.00' },
      invoice: null,
    },
    { orderNumber: 'undated', orderDate: '', summary: null, invoice: null },
  ];
}

test('filterDashboardRecords scopes records by range; undated excluded from bounded ranges', () => {
  const sandbox = loadDashboardSandbox();
  const records = scopedRecords();

  const thisYear = sandbox.filterDashboardRecords(records, 'thisYear', fakeNow());
  assert.deepEqual(
    thisYear.map((r) => r.orderNumber),
    ['202603', '202607', '202605-summary']
  );

  const lastYear = sandbox.filterDashboardRecords(records, 'lastYear', fakeNow());
  assert.deepEqual(lastYear.map((r) => r.orderNumber), ['202506']);

  // 'all' passes everything through, undated included.
  assert.equal(sandbox.filterDashboardRecords(records, 'all', fakeNow()).length, 5);
});

test('getPreviousRangeBounds returns the immediately preceding period, null for all-time', () => {
  const sandbox = loadDashboardSandbox();

  assert.deepEqual(toPlain(sandbox.getPreviousRangeBounds('thisYear', fakeNow())), {
    from: '2025-01-01',
    to: '2025-12-31',
  });
  assert.deepEqual(toPlain(sandbox.getPreviousRangeBounds('lastYear', fakeNow())), {
    from: '2024-01-01',
    to: '2024-12-31',
  });
  // last3 covers 2026-04-17..2026-07-17 → previous is 2026-01-17..2026-04-16.
  assert.deepEqual(toPlain(sandbox.getPreviousRangeBounds('last3', fakeNow())), {
    from: '2026-01-17',
    to: '2026-04-16',
  });
  assert.equal(sandbox.getPreviousRangeBounds('all', fakeNow()), null);
});

/** Model-test records: measured spend this year and last year plus an unmeasured order. */
function modelRecords() {
  const invoiceOf = (total) => ({ schemaVersion: 3, orderTotal: total, items: [] });
  return [
    { orderNumber: 'A', orderDate: '2026-03-10T00:00:00.000Z', summary: null, invoice: invoiceOf('$100.00') },
    { orderNumber: 'B', orderDate: '2026-07-01T00:00:00.000Z', summary: null, invoice: invoiceOf('$50.00') },
    { orderNumber: 'C', orderDate: '2025-06-15T00:00:00.000Z', summary: null, invoice: invoiceOf('$100.00') },
    {
      orderNumber: 'D',
      orderDate: '2026-05-05T00:00:00.000Z',
      summary: { orderDate: '2026-05-05T00:00:00.000Z', orderTotal: '$20.00' },
      invoice: null,
    },
  ];
}

test('computeDashboardModel compares against the previous period', () => {
  const sandbox = loadDashboardSandbox();
  const model = sandbox.computeDashboardModel(modelRecords(), 'thisYear', fakeNow());

  assert.equal(model.range, 'thisYear');
  assert.equal(model.stats.totalSpend, 150);
  assert.equal(model.prevTotalSpend, 100);
  // (150 - 100) / 100 → +50%.
  assert.equal(model.deltaPercent, 50);
});

test('computeDashboardModel hides the delta instead of lying when the previous period is empty', () => {
  const sandbox = loadDashboardSandbox();

  // lastYear's previous period (2024) has no data → delta must be null.
  const lastYear = sandbox.computeDashboardModel(modelRecords(), 'lastYear', fakeNow());
  assert.equal(lastYear.prevTotalSpend, 0);
  assert.equal(lastYear.deltaPercent, null);

  // All-time has no previous period at all.
  const allTime = sandbox.computeDashboardModel(modelRecords(), 'all', fakeNow());
  assert.equal(allTime.prevTotalSpend, null);
  assert.equal(allTime.deltaPercent, null);
});

test('computeDashboardModel zero-fills chart months from range start through the current month', () => {
  const sandbox = loadDashboardSandbox();
  const model = sandbox.computeDashboardModel(modelRecords(), 'thisYear', fakeNow());

  // Jan..Jul 2026 — never past "today" even though the range runs to Dec 31.
  assert.deepEqual(
    toPlain(model.chartMonths).map((entry) => entry.month),
    ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']
  );
  const march = model.chartMonths.find((entry) => entry.month === '2026-03');
  assert.deepEqual(toPlain(march), { month: '2026-03', total: 100, orders: 1 });
  const empty = model.chartMonths.find((entry) => entry.month === '2026-01');
  assert.deepEqual(toPlain(empty), { month: '2026-01', total: 0, orders: 0 });
});

test('computeDashboardModel chart months span min..max for all-time', () => {
  const sandbox = loadDashboardSandbox();
  const model = sandbox.computeDashboardModel(modelRecords(), 'all', fakeNow());
  assert.equal(model.chartMonths[0].month, '2025-06');
  assert.equal(model.chartMonths[model.chartMonths.length - 1].month, '2026-07');
  // Contiguous months, gaps zero-filled.
  assert.equal(model.chartMonths.length, 14);
});

test('computeDashboardModel reports actionable coverage: exactly which orders are unmeasured', () => {
  const sandbox = loadDashboardSandbox();
  const model = sandbox.computeDashboardModel(modelRecords(), 'thisYear', fakeNow());

  assert.deepEqual(toPlain(model.coverage), {
    stored: 3,
    measured: 2,
    missingOrderNumbers: ['D'],
  });
});

test('computeDashboardModel price watch: first vs latest unit price within the scope', () => {
  const sandbox = loadDashboardSandbox();
  const records = [
    invoiceRecord('1', '2026-02-01T00:00:00.000Z', [
      { productName: 'Test Tide Pods', usItemId: '42', quantity: '1', price: '$11.20' },
      { productName: 'Test Eggs', usItemId: '7', quantity: '1', price: '$3.35' },
      { productName: 'Test Bread', usItemId: '9', quantity: '1', price: '$2.48' },
    ]),
    invoiceRecord('2', '2026-06-01T00:00:00.000Z', [
      { productName: 'Test Tide Pods', usItemId: '42', quantity: '1', price: '$12.97' },
      { productName: 'Test Eggs', usItemId: '7', quantity: '1', price: '$2.98' },
      { productName: 'Test Bread', usItemId: '9', quantity: '1', price: '$2.48' },
    ]),
  ];

  const model = sandbox.computeDashboardModel(records, 'thisYear', fakeNow());
  // Stable-priced bread is excluded; movers sorted by |percent| descending.
  assert.deepEqual(toPlain(model.priceWatch), [
    { name: 'Test Tide Pods', firstPrice: 11.2, latestPrice: 12.97, percentChange: 16 },
    { name: 'Test Eggs', firstPrice: 3.35, latestPrice: 2.98, percentChange: -11 },
  ]);
});

test('computeDashboardModel avgPerMonth divides spend across months with data', () => {
  const sandbox = loadDashboardSandbox();
  const model = sandbox.computeDashboardModel(modelRecords(), 'thisYear', fakeNow());
  // $150 across 2 months with measured spend (Mar, Jul).
  assert.equal(model.avgPerMonth, 75);

  const empty = sandbox.computeDashboardModel([], 'thisYear', fakeNow());
  assert.equal(empty.avgPerMonth, 0);
});

/*
 * Multi-provider / currency-aware dashboard (2026-07-18): the dashboard
 * follows the stored active provider selection, formats money in the
 * provider's currency, and the combined "All providers" view groups spend
 * BY CURRENCY (no conversion, ever). The Walmart-only assertions above are
 * the compatibility contract — nothing below may change them.
 */

test('formatDashboardMoney keeps the historical USD rendering byte-for-byte', () => {
  const sandbox = loadDashboardSandbox();
  // The exact output shape the dashboard has always shown for Walmart.com.
  assert.equal(sandbox.formatDashboardMoney(1234.5, 'USD'), '$1,234.50');
  assert.equal(sandbox.formatDashboardMoney(0, 'USD'), '$0.00');
  // null/undefined currency (combined default, missing adapter) → USD shape.
  assert.equal(sandbox.formatDashboardMoney(24.11, null), '$24.11');
  assert.equal(sandbox.formatDashboardMoney('$42.17', undefined), '$42.17');
});

test('formatDashboardMoney disambiguates non-USD currencies without converting', () => {
  const sandbox = loadDashboardSandbox();
  // CAD renders with an explicit prefix so USD "$" and CAD amounts can
  // never be confused on a mixed-currency surface.
  assert.equal(sandbox.formatDashboardMoney(1234.5, 'CAD'), 'CA$1,234.50');
  assert.equal(sandbox.formatDashboardMoney('$4.49', 'CAD'), 'CA$4.49');
  // An unknown code degrades to a labeled amount, never a fake symbol.
  assert.equal(sandbox.formatDashboardMoney(5, 'NOPE!'), 'NOPE! 5.00');
});

/** Minimal schema-current invoice with just a total. */
function invoiceOfTotal(total) {
  return { schemaVersion: 3, orderTotal: total, items: [] };
}

/** Provider scopes spanning two currencies for combined-view tests. */
function combinedScopes() {
  return [
    {
      id: 'WALMART_US',
      label: 'Walmart.com',
      currency: 'USD',
      records: [
        { orderNumber: 'US1', orderDate: '2026-03-10T00:00:00.000Z', summary: null, invoice: invoiceOfTotal('$100.00') },
        { orderNumber: 'US2', orderDate: '2026-06-01T00:00:00.000Z', summary: null, invoice: invoiceOfTotal('$50.00') },
        {
          orderNumber: 'US3',
          orderDate: '2026-05-05T00:00:00.000Z',
          summary: { orderDate: '2026-05-05T00:00:00.000Z', orderTotal: '$20.00' },
          invoice: null, // summary-only: stored but never measured
        },
      ],
    },
    {
      id: 'STORE_B',
      label: 'Store B',
      currency: 'USD',
      records: [
        { orderNumber: 'T1', orderDate: '2026-04-01T00:00:00.000Z', summary: null, invoice: invoiceOfTotal('$30.00') },
      ],
    },
    {
      id: 'WALMART_CA',
      label: 'Walmart.ca',
      currency: 'CAD',
      records: [
        { orderNumber: 'CA1', orderDate: '2026-02-01T00:00:00.000Z', summary: null, invoice: invoiceOfTotal('$80.00') },
        { orderNumber: 'CA2', orderDate: '2025-06-15T00:00:00.000Z', summary: null, invoice: invoiceOfTotal('$40.00') },
      ],
    },
  ];
}

test('computeProviderDashboard groups spend BY CURRENCY — never sums across currencies', () => {
  const sandbox = loadDashboardSandbox();
  const combined = sandbox.computeProviderDashboard(combinedScopes(), 'all', fakeNow());

  assert.equal(combined.mixedCurrency, true);
  // Counts are currency-free and DO sum across every provider.
  assert.equal(combined.orderCount, 6);
  assert.equal(combined.invoiceCount, 5);

  // One subtotal per currency, biggest spend first; USD spend (100+50+30)
  // and CAD spend (80+40) never appear merged into a single number.
  assert.deepEqual(
    toPlain(combined.currencyTotals).map(({ currency, totalSpend, invoiceCount, orderCount }) => ({
      currency, totalSpend, invoiceCount, orderCount,
    })),
    [
      { currency: 'USD', totalSpend: 180, invoiceCount: 3, orderCount: 4 },
      { currency: 'CAD', totalSpend: 120, invoiceCount: 2, orderCount: 2 },
    ]
  );

  // Per-provider breakdown inside the USD group, biggest spender first.
  assert.deepEqual(
    toPlain(combined.currencyTotals[0].providers).map(({ id, totalSpend, invoiceCount }) => ({
      id, totalSpend, invoiceCount,
    })),
    [
      { id: 'WALMART_US', totalSpend: 150, invoiceCount: 2 },
      { id: 'STORE_B', totalSpend: 30, invoiceCount: 1 },
    ]
  );
});

test('computeProviderDashboard applies the range scope per provider', () => {
  const sandbox = loadDashboardSandbox();
  const combined = sandbox.computeProviderDashboard(combinedScopes(), 'thisYear', fakeNow());

  // CA2 (2025) drops out of the CAD subtotal; every 2026 order stays.
  const cad = combined.currencyTotals.find((group) => group.currency === 'CAD');
  assert.equal(cad.totalSpend, 80);
  assert.equal(cad.invoiceCount, 1);
  const usd = combined.currencyTotals.find((group) => group.currency === 'USD');
  assert.equal(usd.totalSpend, 180);
  assert.equal(combined.invoiceCount, 4);
});

test('computeProviderDashboard keeps unmeasured providers visible in their currency group', () => {
  const sandbox = loadDashboardSandbox();
  const scopes = [
    combinedScopes()[0],
    {
      id: 'STORE_C',
      label: 'Store C',
      currency: 'USD',
      records: [
        {
          orderNumber: 'I1',
          orderDate: '2026-06-20T00:00:00.000Z',
          summary: { orderDate: '2026-06-20T00:00:00.000Z', orderTotal: '$15.00' },
          invoice: null,
        },
      ],
    },
  ];
  const combined = sandbox.computeProviderDashboard(scopes, 'all', fakeNow());

  // Single currency across providers → one group, no mixed flag.
  assert.equal(combined.mixedCurrency, false);
  assert.equal(combined.currencyTotals.length, 1);
  const storeC = combined.currencyTotals[0].providers.find((p) => p.id === 'STORE_C');
  // Summary-only spend is never measured — but the provider is still listed.
  assert.deepEqual(toPlain(storeC), { id: 'STORE_C', label: 'Store C', totalSpend: 0, invoiceCount: 0, orderCount: 1 });
});

test('computeProviderDashboard over a lone Walmart scope matches computeDashboardStats exactly', () => {
  const sandbox = loadDashboardSandbox();
  const records = modelRecords();
  const combined = sandbox.computeProviderDashboard(
    [{ id: 'WALMART_US', label: 'Walmart.com', currency: 'USD', records }],
    'thisYear',
    fakeNow()
  );
  const direct = sandbox.computeDashboardStats(
    sandbox.filterDashboardRecords(records, 'thisYear', fakeNow())
  );

  // The combined machinery must never move a Walmart-only number.
  assert.equal(combined.currencyTotals.length, 1);
  assert.equal(combined.currencyTotals[0].totalSpend, direct.totalSpend);
  assert.equal(combined.invoiceCount, direct.invoiceCount);
  assert.equal(combined.orderCount, direct.orderCount);
  assert.equal(combined.mixedCurrency, false);
});

test('computeProviderDashboard handles empty and malformed input', () => {
  const sandbox = loadDashboardSandbox();
  for (const input of [[], null, undefined]) {
    const combined = sandbox.computeProviderDashboard(input, 'all', fakeNow());
    assert.equal(combined.orderCount, 0);
    assert.equal(combined.invoiceCount, 0);
    assert.deepEqual(toPlain(combined.currencyTotals), []);
    assert.equal(combined.mixedCurrency, false);
  }
  // A scope with no records/currency must not throw and defaults to USD.
  const combined = sandbox.computeProviderDashboard([{ id: 'X' }], 'all', fakeNow());
  assert.equal(combined.currencyTotals[0].currency, 'USD');
});

test('Sidepanel.dashboard.render entry point exists and is a safe no-op until a page registers', () => {
  const sandbox = loadDashboardSandbox();
  assert.equal(evalIn(sandbox, 'typeof window.Sidepanel.dashboard.render'), 'function');
  // No renderer registered (e.g. inside the side panel) → harmless undefined.
  assert.equal(evalIn(sandbox, 'window.Sidepanel.dashboard.render()'), undefined);
  // dashboard.page.js registers _renderImpl; render() must route through it.
  evalIn(sandbox, 'window.Sidepanel.dashboard._renderImpl = () => "re-rendered"');
  assert.equal(evalIn(sandbox, 'window.Sidepanel.dashboard.render()'), 're-rendered');
});
