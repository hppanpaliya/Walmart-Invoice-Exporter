'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, toPlain } = require('./helpers/sandbox');

function loadUtils() {
  return loadSandbox({ scripts: ['utils.js'] });
}

const summaries = {
  111: {
    source: 'payload',
    orderDate: '2026-07-01T14:23:00.000-04:00',
    status: 'Delivered',
    items: [
      { name: 'Great Value Milk 1 Gallon', quantity: 2, statusCode: 'DELIVERED' },
      { name: 'Bananas, each', quantity: 6, statusCode: 'DELIVERED' },
    ],
  },
};

const invoices = {
  111: {
    items: [
      { productName: 'Great Value  Milk 1 Gallon', quantity: '2', price: '$7.96' },
      { productName: 'Bananas, each', quantity: '6', price: '$1.62' },
    ],
  },
};

test('buildSummaryItemRows explodes items into rows and joins invoice prices by name', () => {
  const sandbox = loadUtils();
  const rows = toPlain(
    sandbox.buildSummaryItemRows(['111'], summaries, invoices, { 111: 'Jul 1, 2026' })
  );

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    orderNumber: '111',
    orderDate: 'Jul 1, 2026',
    name: 'Great Value Milk 1 Gallon',
    quantity: 2,
    // Whitespace-normalized name matching bridges list vs invoice spellings.
    price: '$7.96',
    status: 'DELIVERED',
  });
  assert.equal(rows[1].price, '$1.62');
});

test('buildSummaryItemRows leaves price blank when no invoice is stored', () => {
  const sandbox = loadUtils();
  const rows = toPlain(sandbox.buildSummaryItemRows(['111'], summaries, {}, {}));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].price, '');
  assert.equal(rows[0].orderDate, '2026-07-01T14:23:00.000-04:00');
});

test('buildSummaryItemRows falls back to invoice items when the summary has none', () => {
  const sandbox = loadUtils();
  const rows = toPlain(
    sandbox.buildSummaryItemRows(
      ['222'],
      { 222: { source: 'dom', items: [] } },
      { 222: { items: [{ productName: 'AA Batteries', quantity: '1', price: '$8.44', deliveryStatus: 'Delivered' }] } },
      {}
    )
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'AA Batteries');
  assert.equal(rows[0].price, '$8.44');
  assert.equal(rows[0].status, 'Delivered');
});

test('buildSummaryItemRows returns nothing for orders with no item data at all', () => {
  const sandbox = loadUtils();
  const rows = toPlain(sandbox.buildSummaryItemRows(['333'], {}, {}, {}));
  assert.deepEqual(rows, []);
});
