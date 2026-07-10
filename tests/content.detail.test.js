'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadSandbox, evalIn, toPlain } = require('./helpers/sandbox');

const detailPayload = require(path.join(__dirname, 'fixtures', 'order-detail.json'));

function loadDetailSandbox() {
  return loadSandbox({ nextData: detailPayload });
}

test('extractOrderDataFromNextData pulls identity and money fields from the payload', () => {
  const sandbox = loadDetailSandbox();
  const order = sandbox.extractOrderDataFromNextData();

  assert.equal(order.orderNumber, '200010000000042');
  assert.equal(order.orderSubtotal, '$18.53');
  assert.equal(order.subtotalBeforeSavings, '$20.53');
  assert.equal(order.savings, '$2.00');
  assert.equal(order.tax, '$1.14');
  assert.equal(order.tip, '$4.00');
  // grandTotalWithTips wins over grandTotal
  assert.equal(order.orderTotal, '$28.11');
  assert.equal(order.refund, '$3.98');
  assert.equal(order.donations, '$1.00');
  assert.equal(order.barcodeImageUrl, 'https://receipts-query.edge.walmart.com/barcode?data=sanitized');
});

test('extractOrderDataFromNextData extracts items from groups and subGroups with links and thumbnails', () => {
  const sandbox = loadDetailSandbox();
  const order = sandbox.extractOrderDataFromNextData();

  assert.equal(order.items.length, 3);

  const milk = order.items[0];
  assert.equal(milk.productName, 'Great Value Milk 1 Gallon');
  assert.equal(milk.quantity, '2');
  assert.equal(milk.price, '$7.96');
  assert.equal(milk.deliveryStatus, 'Delivered');
  assert.equal(milk.productLink, 'https://www.walmart.com/ip/10450114');
  assert.equal(milk.thumbnailUrl, 'https://i5.walmartimages.com/asr/milk.jpg');
  assert.equal(milk.usItemId, '10450114');

  const marketplaceItem = order.items[2];
  assert.equal(marketplaceItem.productName, '=HYPERLINK Product "Deal", 2-pack');
  assert.equal(marketplaceItem.deliveryStatus, 'Canceled');
  // subGroups-nested items carry usItemId too (price-history keying).
  assert.equal(marketplaceItem.usItemId, '998877');
});

test('extractOrderDataFromNextData aggregates shipment metadata across groups', () => {
  const sandbox = loadDetailSandbox();
  const order = sandbox.extractOrderDataFromNextData();

  assert.equal(order.sellers, 'Walmart.com; Acme Marketplace LLC');
  assert.equal(order.fulfillmentTypes, 'DELIVERY, SHIPPING');
  assert.match(order.trackingNumbers, /1Z999AA10123456784/);
  assert.match(order.trackingNumbers, /1Z999AA10123456785/);
  // Date-only deliveredDate must not shift a day (parsed as local, not UTC)
  assert.equal(order.deliveredDate, 'Jul 02, 2026');
});

test('payment methods keep only amount-shaped displayValues', () => {
  const sandbox = loadDetailSandbox();
  const order = sandbox.extractOrderDataFromNextData();

  const visa = order.paymentMethodDetails.find((m) => m.brand === 'VISA');
  assert.equal(visa.amount, '$20.00');
  assert.equal(visa.message, 'Charged Jul 2');

  // Second card mixes a descriptive string into displayValues — it must not
  // leak into the amount.
  const gift = order.paymentMethodDetails.find((m) => m.brand === 'GIFTCARD');
  assert.equal(gift.amount, '$6.84');
});

test('scrapeOrderData (payload-only page) produces schemaVersion 2 with the payment split', () => {
  const sandbox = loadDetailSandbox();
  const data = sandbox.scrapeOrderData();

  assert.equal(data.schemaVersion, 2);
  assert.equal(data.orderNumber, '200010000000042');
  assert.equal(data.items.length, 3);
  assert.equal(data.paymentSplit, 'VISA ending in 1234: $20.00; GIFTCARD Gift Card: $6.84');
  assert.equal(data.address, 'Test Customer, 123 Main St, Springfield IL 62704');
  assert.equal(data.deliveryInstructions, 'Leave at door');
});

test('computeExtractionWarnings trips on blank data and stays quiet on healthy data', () => {
  const sandbox = loadDetailSandbox();
  const healthy = sandbox.scrapeOrderData();
  assert.deepEqual(toPlain(sandbox.computeExtractionWarnings(healthy)), []);

  const blank = { orderNumber: null, orderTotal: '', items: [{ productName: '' }] };
  const warnings = sandbox.computeExtractionWarnings(blank);
  assert.equal(warnings.length, 3);
});

test('mergeOrderItems backfills payload thumbnails into DOM-sourced items', () => {
  const sandbox = loadDetailSandbox();
  const domItems = [{ productName: 'Great Value Milk 1 Gallon', quantity: '2', price: '$7.96' }];
  const payloadItems = [
    {
      productName: 'Great Value Milk 1 Gallon',
      quantity: '2',
      price: '$7.96',
      thumbnailUrl: 'https://i5.walmartimages.com/asr/milk.jpg',
    },
    { productName: 'Extra payload item', quantity: '1', price: '$2.00' },
  ];

  const merged = sandbox.mergeOrderItems(domItems, payloadItems);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].thumbnailUrl, 'https://i5.walmartimages.com/asr/milk.jpg');
});

test('formatOrderDateFromIsoString treats date-only strings as local dates', () => {
  const sandbox = loadDetailSandbox();
  assert.equal(sandbox.formatOrderDateFromIsoString('2026-07-09'), 'Jul 09, 2026');
  assert.equal(sandbox.formatOrderDateFromIsoString('not a date'), 'not a date');
  assert.equal(sandbox.formatOrderDateFromIsoString(''), '');
});

test('buildPaymentSplit skips methods without amounts', () => {
  const sandbox = loadDetailSandbox();
  const split = sandbox.buildPaymentSplit([
    { brand: 'VISA', ending: 'ending in 1234', amount: '$20.00' },
    { brand: 'EBT', ending: '', amount: '' },
  ]);
  assert.equal(split, 'VISA ending in 1234: $20.00');
});

test('sandbox exposes PurchaseHistoryDataSource without a list payload', () => {
  const sandbox = loadDetailSandbox();
  // Detail payload has no purchaseHistory node — snapshot must be null.
  assert.equal(evalIn(sandbox, 'PurchaseHistoryDataSource.getBestSnapshot({ currentPage: 1 })'), null);
});
