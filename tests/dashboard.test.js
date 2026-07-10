'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, toPlain } = require('./helpers/sandbox');

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

test('computeDashboardStats groups monthly spend by ISO month, sorted ascending', () => {
  const sandbox = loadDashboardSandbox();
  const stats = sandbox.computeDashboardStats(syntheticRecords());

  // Only invoice-backed orders appear in the monthly bars.
  assert.deepEqual(toPlain(stats.monthly), [
    { month: '2026-05', total: 24.11 },
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
  assert.deepEqual(toPlain(stats.topItems), [{ name: 'Test Soda', orders: 2, quantity: 3 }]);
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

test('sidepanel.dashboard exposes renderDashboard on window.Sidepanel', () => {
  const sandbox = loadDashboardSandbox();
  assert.equal(typeof sandbox.window.Sidepanel.dashboard.renderDashboard, 'function');
});
