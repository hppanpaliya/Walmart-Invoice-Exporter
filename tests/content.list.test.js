'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadSandbox, evalIn, toPlain } = require('./helpers/sandbox');

const listPayload = require(path.join(__dirname, 'fixtures', 'purchase-history.json'));

function getSnapshot() {
  const sandbox = loadSandbox({ nextData: listPayload });
  return evalIn(sandbox, 'PurchaseHistoryDataSource.getBestSnapshot({ currentPage: 1 })');
}

test('purchase-history snapshot dedupes repeated orders and keeps page order', () => {
  const snapshot = getSnapshot();

  assert.ok(snapshot, 'snapshot should be built from the payload');
  assert.equal(snapshot.source, 'next-data');
  // Fixture has 3 order nodes but the first two are the same order.
  assert.deepEqual(toPlain(snapshot.orderNumbers), ['200010000000042', '77501234567890123456']);
  assert.equal(snapshot.hasNextPage, true);
  assert.equal(snapshot.nextPageCursor, 'cursor-page-2');
});

test('snapshot carries titles for tooltips', () => {
  const snapshot = getSnapshot();
  assert.equal(snapshot.additionalFields['200010000000042'], 'July 01, 2026 order');
  assert.equal(snapshot.additionalFields['77501234567890123456'], 'June 15, 2026 in-store purchase');
});

test('order summaries expose Quick Export fields including per-item data', () => {
  const snapshot = getSnapshot();
  const summary = snapshot.orderSummaries['200010000000042'];

  assert.equal(summary.orderDate, '2026-07-01T14:23:00.000-04:00');
  assert.equal(summary.itemCount, 3);
  assert.equal(summary.orderTotal, '$28.11');
  assert.equal(summary.subTotal, '$18.53');
  assert.equal(summary.driverTip, '$4.00');
  assert.equal(summary.status, 'Delivered');
  assert.equal(summary.fulfillmentTypes, 'DELIVERY');
  assert.equal(summary.items.length, 2);
  assert.equal(summary.items[0].name, 'Great Value Milk 1 Gallon');
  assert.equal(summary.items[0].quantity, 2);
});

test('in-store orders come through the list payload', () => {
  const snapshot = getSnapshot();
  const inStore = snapshot.orderSummaries['77501234567890123456'];

  assert.ok(inStore, 'in-store order must be collected');
  assert.equal(inStore.status, 'Purchased in store');
  assert.equal(inStore.fulfillmentTypes, 'IN_STORE');
});

test('missing summary fields degrade to empty strings, not undefined', () => {
  const sandbox = loadSandbox({
    nextData: {
      props: {
        pageProps: {
          initialData: {
            data: {
              purchaseHistory: {
                orders: [{ id: '111222333444555', title: 'Sparse order' }],
                pageInfo: {},
              },
            },
          },
        },
      },
    },
  });
  const snapshot = evalIn(sandbox, 'PurchaseHistoryDataSource.getBestSnapshot({ currentPage: 1 })');

  assert.equal(snapshot.hasNextPage, false);
  const summary = snapshot.orderSummaries['111222333444555'];
  assert.equal(summary.orderTotal, '');
  assert.equal(summary.status, '');
  assert.deepEqual(toPlain(summary.items), []);
});
