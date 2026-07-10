'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadSandbox, evalIn } = require('./helpers/sandbox');

const listPayload = require(path.join(__dirname, 'fixtures', 'purchase-history.json'));
const detailPayload = require(path.join(__dirname, 'fixtures', 'order-detail.json'));

test('list snapshot summaries carry the order type and in-store flag', () => {
  const sandbox = loadSandbox({ nextData: listPayload });
  const snapshot = evalIn(sandbox, 'PurchaseHistoryDataSource.getBestSnapshot({ currentPage: 1 })');

  const online = snapshot.orderSummaries['200010000000042'];
  assert.equal(online.orderType, 'GLASS');
  assert.equal(online.isInStore, false);

  const inStore = snapshot.orderSummaries['77501234567890123456'];
  assert.equal(inStore.orderType, 'IN_STORE');
  assert.equal(inStore.isInStore, true);
});

test('detail extraction carries the order type through to scrapeOrderData', () => {
  const sandbox = loadSandbox({ nextData: detailPayload });

  const fromPayload = sandbox.extractOrderDataFromNextData();
  assert.equal(fromPayload.orderType, 'GLASS');
  assert.equal(fromPayload.isInStore, false);

  const scraped = sandbox.scrapeOrderData();
  assert.equal(scraped.orderType, 'GLASS');
  assert.equal(scraped.isInStore, false);
});

test('orderType and isInStore degrade safely when the payload omits them', () => {
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
  const summary = snapshot.orderSummaries['111222333444555'];
  assert.equal(summary.orderType, '');
  assert.equal(summary.isInStore, false);
});

test('formatOrderType prefers the In-store label over the raw type', () => {
  const sandbox = loadSandbox({ scripts: ['utils.js'] });
  assert.equal(sandbox.formatOrderType('GLASS', false), 'GLASS');
  assert.equal(sandbox.formatOrderType('IN_STORE', true), 'In-store');
  assert.equal(sandbox.formatOrderType('', true), 'In-store');
  assert.equal(sandbox.formatOrderType('', false), '');
  assert.equal(sandbox.formatOrderType(undefined, undefined), '');
});

test('every export surface gained an Order Type column', () => {
  const sandbox = loadSandbox({ scripts: ['utils.js'] });

  const orderHeaders = evalIn(sandbox, 'ORDER_CSV_COLUMNS.map(([header]) => header)');
  assert.ok(Array.from(orderHeaders).includes('Order Type'));

  const summaryHeaders = evalIn(sandbox, 'SUMMARY_CSV_COLUMNS.map(([header]) => header)');
  assert.ok(Array.from(summaryHeaders).includes('Order Type'));

  const orderTypeGetter = evalIn(sandbox, "ORDER_CSV_COLUMNS.find(([header]) => header === 'Order Type')[1]");
  assert.equal(orderTypeGetter({ orderType: 'GLASS', isInStore: false }), 'GLASS');
  assert.equal(orderTypeGetter({ orderType: 'IN_STORE', isInStore: true }), 'In-store');

  const summaryGetter = evalIn(sandbox, "SUMMARY_CSV_COLUMNS.find(([header]) => header === 'Order Type')[1]");
  assert.equal(summaryGetter({ orderType: 'In-store' }), 'In-store');
  assert.equal(summaryGetter({}), '');
});
