'use strict';

import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadSandbox, evalIn, toPlain } from './helpers/sandbox';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const detailPayload = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'order-detail.json'), 'utf8'));

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

test('payload items without canonicalUrl still get a product link built from usItemId (live shape since 2026-07)', () => {
  const stripped = JSON.parse(JSON.stringify(detailPayload));
  const strip = (node) => {
    if (!node || typeof node !== 'object') return;
    if ('canonicalUrl' in node) delete node.canonicalUrl;
    Object.values(node).forEach(strip);
  };
  strip(stripped);

  const sandbox = loadSandbox({ nextData: stripped });
  const order = sandbox.extractOrderDataFromNextData();

  assert.equal(order.items.length, 3);
  assert.equal(order.items[0].productLink, 'https://www.walmart.com/ip/10450114');
  // subGroups-nested item builds its link from its own usItemId too.
  assert.equal(order.items[2].productLink, 'https://www.walmart.com/ip/998877');
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

  assert.equal(data.schemaVersion, 3);
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

test('computeExtractionWarnings flags split tender with no per-tender amounts', () => {
  const sandbox = loadDetailSandbox();
  const base = { orderNumber: '582515916131486157579', orderTotal: '$204.26',
    items: [{ productName: 'Fresh Strawberries, 1 lb Container', price: '$4.34' }] };

  // A real in-store export (#20): both tenders named, neither carrying an
  // amount, so paymentSplit is empty and the card was charged less than the
  // order total. Nothing else in the payload says so.
  const splitTender = sandbox.computeExtractionWarnings({
    ...base,
    paymentMethodDetails: [
      { cardId: 'card-description-0', brand: '', ending: 'Ending in 2043', amount: '' },
      { cardId: 'card-description-1', brand: '', ending: 'Walmart Visa ending in 8527', amount: '' },
    ],
  });
  assert.equal(splitTender.length, 1);
  assert.match(toPlain(splitTender)[0], /Split tender across 2 payment methods/);

  // One tender: its amount IS the order total, so nothing is lost — stay quiet.
  assert.deepEqual(toPlain(sandbox.computeExtractionWarnings({
    ...base,
    paymentMethodDetails: [{ brand: 'VISA', ending: 'ending in 1234', amount: '' }],
  })), []);

  // Amounts present — the healthy split-tender case, also quiet.
  assert.deepEqual(toPlain(sandbox.computeExtractionWarnings({
    ...base,
    paymentMethodDetails: [
      { brand: 'VISA', ending: 'ending in 1234', amount: '$20.00' },
      { brand: 'GIFTCARD', ending: 'Gift Card', amount: '$6.84' },
    ],
  })), []);

  // Partial extraction is not a silent loss: one known amount plus the order
  // total gives the other, so this stays quiet too.
  assert.deepEqual(toPlain(sandbox.computeExtractionWarnings({
    ...base,
    paymentMethodDetails: [
      { brand: 'VISA', ending: 'ending in 1234', amount: '$200.51' },
      { brand: '', ending: 'Ending in 2043', amount: '' },
    ],
  })), []);
});

test('readPaymentRowAmount reads the 2026 payment row (flex-auto moved off the amount)', () => {
  const sandbox = loadDetailSandbox();
  // `row` fakes an element: `.tr.flex-auto` via querySelector, `.tr` via querySelectorAll.
  const row = (map) => ({
    querySelector: (sel) => (map[sel] !== undefined ? { textContent: map[sel] } : null),
    querySelectorAll: (sel) => (Array.isArray(map[sel]) ? map[sel] : map[sel] !== undefined
      ? [{ textContent: map[sel] }] : []).map((v) => (typeof v === 'string' ? { textContent: v } : v)),
  });

  // Live markup, captured from an online order page 2026-08-11. The amount span carries
  // `tr` only; `flex-auto` now sits on the sibling label div, so the old `.tr.flex-auto`
  // matched nothing and every split-tender amount was dropped.
  assert.equal(sandbox.readPaymentRowAmount(row({ '.tr': '$107.75' })), '$107.75');
  assert.equal(sandbox.readPaymentRowAmount(row({ '.tr': '$8.00' })), '$8.00');

  // Older pages put both classes on the amount — keep working.
  assert.equal(
    sandbox.readPaymentRowAmount(row({ '.tr.flex-auto': '$20.00', '.tr': '$20.00' })),
    '$20.00');

  // The specific selector wins when the two disagree.
  assert.equal(
    sandbox.readPaymentRowAmount(row({ '.tr.flex-auto': '$9.99', '.tr': '$1.00' })),
    '$9.99');

  // `.tr` is a text-align utility, so a row may hold one that is NOT the amount. Skip
  // anything that does not look like money rather than exporting a label as a figure.
  assert.equal(sandbox.readPaymentRowAmount(row({ '.tr': ['Ending in 8527', '$75.29'] })),
               '$75.29');
  assert.equal(sandbox.readPaymentRowAmount(row({ '.tr': 'Ending in 8527' })), '');


  // Anchored, so text that merely CONTAINS a number is rejected.
  assert.equal(sandbox.readPaymentRowAmount(row({ '.tr': '12.31.25' })), '');
  assert.equal(sandbox.readPaymentRowAmount(row({ '.tr': '$75.29 charged' })), '');
  assert.equal(sandbox.readPaymentRowAmount(row({ '.tr': '3 hours or less' })), '');
  // Real formats that must still pass.
  assert.equal(sandbox.readPaymentRowAmount(row({ '.tr': '$1,234.56' })), '$1,234.56');
  assert.equal(sandbox.readPaymentRowAmount(row({ '.tr': '-$12.50' })), '-$12.50');
  // In-store rows show no amount at all — empty, never undefined.
  assert.equal(sandbox.readPaymentRowAmount(row({})), '');
  assert.equal(sandbox.readPaymentRowAmount(null), '');
});

test('buildTenderLabel does not say the brand twice', () => {
  const sandbox = loadDetailSandbox();
  const label = sandbox.buildTenderLabel;

  // Live case (order 200014610875731, 2026-08-11): the Walmart Cash row has the same
  // text in img[alt] and in the card description, which used to render as
  // "Walmart Cash Walmart Cash: $6.00".
  assert.equal(label('Walmart Cash', 'Walmart Cash'), 'Walmart Cash');
  // Description already carries the brand.
  assert.equal(label('Visa', 'Walmart Visa ending in 8527'), 'Walmart Visa ending in 8527');
  // Genuinely complementary — keep both.
  assert.equal(label('Visa', 'Ending in 4122'), 'Visa Ending in 4122');
  // Either side missing.
  assert.equal(label('', 'Ending in 2043'), 'Ending in 2043');
  assert.equal(label('GIFTCARD', ''), 'GIFTCARD');
  assert.equal(label('', ''), '');
});

test('extractPrintItem parses the 2026 Walmart print view (Qty label, double-price string)', () => {
  const sandbox = loadDetailSandbox();
  const el = (text) => ({ textContent: text });
  const fakeItem = {
    querySelector: (sel) => {
      if (sel === '.flex.justify-between') {
        return { querySelector: (s) => (s === ':scope > :first-child' ? el('Great Value Pepitas, 8 oz') : null) };
      }
      if (sel === '.print-bill-type') return el('12 shopped');
      if (sel === '.print-bill-qty') return el('Qty 2');
      if (sel === '.print-bill-price') return el('Discount price $6.30$7.72');
      return null;
    },
  };

  const item = sandbox.extractPrintItem(fakeItem);
  assert.equal(item.productName, 'Great Value Pepitas, 8 oz');
  assert.equal(item.quantity, '2', '"Qty 2" must parse to the number');
  assert.equal(item.price, '$6.30', 'the FIRST currency token is the charged price, not the strikethrough');
});

test('mergeOrderItems matches DOM "Qty N" quantities against payload numerics', () => {
  const sandbox = loadDetailSandbox();
  const merged = sandbox.mergeOrderItems(
    [{ productName: 'Great Value Pepitas, 8 oz', quantity: 'Qty 2', price: '' }],
    [{ productName: 'Great Value Pepitas, 8 oz', quantity: '2', price: '$6.30' }]
  );
  assert.equal(merged.length, 1, 'the label-formatted quantity must not create a duplicate');
  assert.equal(merged[0].price, '$6.30');
});

test('mergeOrderItems dedupes DOM garbage copies — payload prices win, no doubled items', () => {
  const sandbox = loadDetailSandbox();
  // Real-world failure: the DOM print-view scrape returned the same items
  // with $0.00 prices and progress text as status; the payload had the real
  // rows. Including price in the dedup key kept BOTH copies.
  const domItems = [
    { productName: 'Fresh Roma Tomato, Each', quantity: '3', price: '$0.00', deliveryStatus: '3 weight adjusted' },
    { productName: 'Whole Milk, Gallon', quantity: '1', price: '$0.00', deliveryStatus: '12 shopped' },
  ];
  const payloadItems = [
    { productName: 'Fresh Roma Tomato, Each', quantity: '3', price: '$0.60', deliveryStatus: 'Delivered on Jun 14' },
    { productName: 'Whole Milk, Gallon', quantity: '1', price: '$3.11', deliveryStatus: 'Delivered on Jun 14' },
  ];

  const merged = sandbox.mergeOrderItems(domItems, payloadItems);
  assert.equal(merged.length, 2, 'items must not be duplicated');
  assert.equal(merged[0].price, '$0.60', 'payload price wins over the DOM $0.00');
  assert.equal(merged[0].deliveryStatus, 'Delivered on Jun 14');
});

test('mergeOrderItems keeps genuinely distinct same-name/same-qty lines (multiset)', () => {
  const sandbox = loadDetailSandbox();
  // One payload line, but the invoice DOM legitimately shows the same
  // name+qty twice (e.g. shipped + re-priced substitution).
  const merged = sandbox.mergeOrderItems(
    [
      { productName: 'Weighted Grapes', quantity: '1', price: '$4.10' },
      { productName: 'Weighted Grapes', quantity: '1', price: '$3.85' },
    ],
    [{ productName: 'Weighted Grapes', quantity: '1', price: '$4.10' }]
  );
  assert.equal(merged.length, 2, 'the second real line must survive');
});

test('mergeOrderItems backfills the DOM price when the payload price is blank', () => {
  const sandbox = loadDetailSandbox();
  const merged = sandbox.mergeOrderItems(
    [{ productName: 'Payload-priceless item', quantity: '1', price: '$2.50' }],
    [{ productName: 'Payload-priceless item', quantity: '1', price: '' }]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].price, '$2.50', 'DOM price fills the payload gap');
});

test('mergeOrderItems keeps DOM-only items the payload missed', () => {
  const sandbox = loadDetailSandbox();
  const merged = sandbox.mergeOrderItems(
    [
      { productName: 'Payload-missed item', quantity: '1', price: '$2.00' },
      { productName: 'Shared item', quantity: '1', price: '$0.00' },
    ],
    [{ productName: 'Shared item', quantity: '1', price: '$5.00' }]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].price, '$5.00');
  assert.equal(merged[1].productName, 'Payload-missed item');
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
