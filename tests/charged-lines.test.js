'use strict';

// Charged-truth traversal (categories, not the flat items list).
//
// The order node's groups_2101[].items is the ORDERED view: it still lists
// UNAVAILABLE items that were never charged, so exports built from it
// overstate the order. The categories tree is what Walmart's own printed
// invoice renders; its non-UNAVAILABLE linePrice values sum exactly to
// priceDetails.subTotal (verified against real invoices to the penny).
// Two traps this test pins:
//   - group.subGroups[].categories duplicates group.categories on
//     multi-fulfillment orders — traversing both doubles every line;
//   - real orders contain identical duplicate lines (same product, same
//     price, two lines) and item ids are NOT unique, so no content- or
//     id-based dedup may run on the categories path.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, evalIn } = require('./helpers/sandbox');

const money = (v) => ({ value: v, displayValue: `$${v.toFixed(2)}` });
const item = (id, name, qty, line) => ({
  id: String(id),
  uniqueId: String(id),
  quantity: qty,
  productInfo: { name, usItemId: `9${id}` },
  priceInfo: { linePrice: money(line) },
});

function orderNodeWithCategories() {
  const regularA = {
    type: 'REGULAR',
    items: [
      item(1, 'Milk, 1 Gallon', 1, 3.97),
      // Two REAL identical lines — same product, same price, both charged.
      item(2, 'Sliced Olives, 3.8 oz Can', 1, 2.22),
      item(3, 'Sliced Olives, 3.8 oz Can', 1, 2.22),
    ],
  };
  const unavailable = {
    type: 'UNAVAILABLE',
    name: 'Unavailable',
    items: [item(4, 'String Cheese, 12-Count', 1, 4.94)],
  };
  const returned = {
    type: 'RETURNED',
    items: [item(5, 'Toaster', 1, 19.99)],
  };
  return {
    props: {
      pageProps: {
        initialData: {
          data: {
            order: {
              id: '200010000000099',
              type: 'GLASS',
              orderDate: '2026-08-30T12:00:00.000Z',
              priceDetails: {
                // 3.97 + 2.22 + 2.22 + 19.99 (returned was charged) + 5.00
                subTotal: money(33.4),
                grandTotal: money(35.4),
              },
              groups_2101: [
                {
                  fulfillmentType: 'SC_PICKUP',
                  // subGroups carry a byte-identical COPY of categories.
                  categories: [regularA, unavailable, returned],
                  subGroups: [{ categories: [regularA, unavailable, returned] }],
                  // The flat ordered list, unavailable item included — the
                  // old traversal read this and overstated the order.
                  items: [...regularA.items, ...unavailable.items, ...returned.items],
                },
                {
                  fulfillmentType: 'SC_DELIVERY',
                  // categories missing here: the subGroups fallback must fire.
                  subGroups: [{ categories: [{ type: 'REGULAR', items: [item(6, 'Bread', 1, 5.0)] }] }],
                  items: [item(6, 'Bread', 1, 5.0)],
                },
              ],
            },
          },
        },
      },
    },
  };
}

test('categories traversal: unavailable excluded, duplicates kept, no double count', () => {
  const sandbox = loadSandbox({ nextData: orderNodeWithCategories() });
  const data = sandbox.extractOrderDataFromNextData();
  const items = data.items;

  // 3 regular + 1 returned + 1 from the subGroups-fallback group.
  assert.equal(items.length, 5);

  // The never-charged UNAVAILABLE line must not appear.
  assert.ok(!items.some((i) => /String Cheese/.test(i.productName)));

  // Both identical olive lines survive (no name|qty|price collapse).
  assert.equal(items.filter((i) => /Sliced Olives/.test(i.productName)).length, 2);

  // RETURNED was charged; it stays.
  assert.ok(items.some((i) => /Toaster/.test(i.productName)));

  // subGroups duplicate copy did not double anything, and the sum equals
  // the after-savings subtotal to the cent.
  const sum = items.reduce((a, i) => a + (parseFloat(String(i.price).replace(/[^0-9.]/g, '')) || 0), 0);
  assert.equal(sum.toFixed(2), '33.40');
});

test('merge never resurrects DOM rows the charged-truth traversal excluded', () => {
  const sandbox = loadSandbox({ nextData: orderNodeWithCategories() });
  const payloadItems = sandbox.extractOrderDataFromNextData().items;
  assert.equal(payloadItems.fromChargedCategories, true);

  // The print bill still renders the UNAVAILABLE line (with a price) and a
  // name-variant copy of a charged item — the classic tab path scrapes both.
  const domItems = [
    { productName: 'Milk, 1 Gallon', quantity: 'Qty 1', price: '$3.97', productLink: 'https://www.walmart.com/ip/91' },
    { productName: 'String Cheese, 12-Count', quantity: 'Qty 1', price: '$4.94' }, // unavailable — never charged
    { productName: 'Milk 1 Gallon (name variant)', quantity: 'Qty 1', price: '$3.97' },
  ];
  const merged = sandbox.mergeOrderItems(domItems, payloadItems);

  assert.equal(merged.length, payloadItems.length); // nothing appended
  assert.ok(!merged.some((i) => /String Cheese/.test(i.productName)));
  assert.ok(!merged.some((i) => /name variant/.test(i.productName)));
  // Field backfill from the matched DOM copy still works.
  assert.equal(merged.find((i) => i.productName === 'Milk, 1 Gallon').productLink, 'https://www.walmart.com/ip/91');
});

test('legacy flat-list payloads keep the historic DOM append', () => {
  const node = orderNodeWithCategories();
  const order = node.props.pageProps.initialData.data.order;
  order.groups_2101 = [
    { fulfillmentType: 'SC_PICKUP', items: [item(1, 'Milk, 1 Gallon', 1, 3.97)] },
  ];
  const sandbox = loadSandbox({ nextData: node });
  const payloadItems = sandbox.extractOrderDataFromNextData().items;
  assert.equal(payloadItems.fromChargedCategories, undefined);
  const merged = sandbox.mergeOrderItems(
    [{ productName: 'DOM-only extra', quantity: 'Qty 1', price: '$1.00' }],
    payloadItems
  );
  assert.equal(merged.length, 2); // unmatched DOM row still appended
});

test('flat-items fallback still works when no categories exist anywhere', () => {
  const node = orderNodeWithCategories();
  const order = node.props.pageProps.initialData.data.order;
  order.groups_2101 = [
    { fulfillmentType: 'SC_PICKUP', items: [item(1, 'Milk, 1 Gallon', 1, 3.97), item(6, 'Bread', 1, 5.0)] },
  ];
  const sandbox = loadSandbox({ nextData: node });
  const items = sandbox.extractOrderDataFromNextData().items;
  assert.equal(items.length, 2);
});

test('category labels without item arrays are summaries, not an authoritative empty invoice', () => {
  const sandbox = loadSandbox();
  const data = sandbox.extractOrderDataFromNextData({ id: '200010000000099',
    groups: [{ categories: [{ type: 'REGULAR' }, { type: 'UNAVAILABLE' }] }] });
  assert.equal(data.items.fromChargedCategories, undefined);
  const merged = sandbox.mergeOrderItems([{ productName: 'Delivered', quantity: '1', price: '$5.00' }], data.items);
  assert.equal(merged.length, 1);
});

for (const categoryType of ['UNAVAILABLE', 'CANCELED', 'CANCELLED']) {
  test(`all-${categoryType} categories remain empty despite legacy payload and DOM copies`, () => {
    const sandbox = loadSandbox();
    const excluded = item(7, 'Never charged item', 1, 12.00);
    const items = sandbox.extractOrderDataFromNextData({
      id: '200010000000099',
      groups_2101: [{ categories: [{ type: categoryType, items: [excluded] }] }],
      groups: [{ items: [excluded] }],
      items: [excluded],
    }).items;
    assert.equal(items.length, 0);
    assert.equal(items.fromChargedCategories, true);
    const merged = sandbox.mergeOrderItems([
      { productName: 'Never charged item', quantity: '1', price: '$12.00' },
    ], items);
    assert.equal(merged.length, 0);
  });
}

test('Canada keeps charged duplicate lines and excludes unavailable categories like the US adapter', () => {
  const sandbox = loadSandbox({ nextData: orderNodeWithCategories(), url: 'https://www.walmart.ca/orders/200010000000099',
    scripts: ['utils.js', 'providers/base.js', 'providers/registry.js', 'providers/walmart-ca.js'] });
  const data = evalIn(sandbox, 'WalmartCaProvider').scrapeOrder({});
  assert.equal(data.items.length, 5);
  assert.equal(data.items.filter(i => /Sliced Olives/.test(i.productName)).length, 2);
  assert.ok(!data.items.some(i => /String Cheese/.test(i.productName)));
  assert.ok(data.items.every(i => i.productLink.startsWith('https://www.walmart.ca/')));
});

test('Canada does not fall back to ordered items when all charged categories are canceled', () => {
  const nextData = orderNodeWithCategories();
  const order = nextData.props.pageProps.initialData.data.order;
  const excluded = item(7, 'Never charged', 1, 12);
  order.groups_2101 = [{ categories: [{ type: 'CANCELED', items: [excluded] }], items: [excluded] }];
  order.items = [excluded];
  const sandbox = loadSandbox({ nextData, url: 'https://www.walmart.ca/orders/200010000000099',
    scripts: ['utils.js', 'providers/base.js', 'providers/registry.js', 'providers/walmart-ca.js'] });
  assert.equal(evalIn(sandbox, 'WalmartCaProvider').scrapeOrder({}).items.length, 0);
});

for (const categoryType of ['CANCELED', 'UNAVAILABLE']) {
  test(`a fully ${categoryType} order is marked as having no charged items and raises no missing-items warning`, () => {
    const sandbox = loadSandbox();
    const excluded = item(7, 'Never charged item', 1, 12.00);
    const data = sandbox.extractOrderDataFromNextData({
      id: '200010000000099',
      groups_2101: [{ categories: [{ type: categoryType, items: [excluded] }] }],
    });
    assert.equal(data.items.length, 0);
    assert.equal(data.noChargedItems, true);
    const warnings = sandbox.computeExtractionWarnings({ ...data, orderNumber: '200010000000099', orderTotal: '$0.00' });
    assert.ok(!warnings.some((warning) => /No items/.test(warning)));
  });
}

test('an order whose items simply could not be read is NOT marked as having no charged items', () => {
  const sandbox = loadSandbox();
  const data = sandbox.extractOrderDataFromNextData({ id: '200010000000099', groups_2101: [{ items: [] }] });
  assert.equal(data.items.length, 0);
  assert.equal('noChargedItems' in data, false);
  const warnings = sandbox.computeExtractionWarnings({ ...data, orderNumber: '200010000000099', orderTotal: '$5.00' });
  assert.ok(warnings.some((warning) => /No items/.test(warning)));
});

test('a normal order never carries the no-charged-items marker', () => {
  const sandbox = loadSandbox();
  const data = sandbox.extractOrderDataFromNextData({
    id: '200010000000099',
    groups_2101: [{ categories: [{ type: 'REGULAR', items: [item(1, 'Milk, 1 Gallon', 1, 3.97)] }] }],
  });
  assert.equal(data.items.length, 1);
  assert.equal('noChargedItems' in data, false);
});

test('Canada marks a fully canceled order as having no charged items without a missing-items warning', () => {
  const nextData = orderNodeWithCategories();
  const order = nextData.props.pageProps.initialData.data.order;
  const excluded = item(7, 'Never charged', 1, 12);
  order.groups_2101 = [{ categories: [{ type: 'CANCELED', items: [excluded] }], items: [excluded] }];
  order.items = [excluded];
  const sandbox = loadSandbox({ nextData, url: 'https://www.walmart.ca/orders/200010000000099',
    scripts: ['utils.js', 'providers/base.js', 'providers/registry.js', 'providers/walmart-ca.js'] });
  const data = evalIn(sandbox, 'WalmartCaProvider').scrapeOrder({});
  assert.equal(data.noChargedItems, true);
  assert.ok(!data.extractionWarnings.some((warning) => /No items/.test(warning)));
});

// ---- Optional details (best effort: never required, never fatal) ----

function orderNodeWith(groups, extraOrderFields = {}) {
  return {
    props: { pageProps: { initialData: { data: { order: {
      id: '200010000000077',
      type: 'GLASS',
      orderDate: '2026-09-02T12:00:00.000Z',
      priceDetails: { subTotal: money(20), grandTotal: money(21.65) },
      groups_2101: groups,
      ...extraOrderFields,
    } } } } },
  };
}

test('optional line details are exported when Walmart sends them and left off when it does not', () => {
  const rich = {
    ...item(1, 'Peanut Butter, 16 oz', 2, 7.96),
    isReturnable: true,
    productInfo: { name: 'Peanut Butter, 16 oz', usItemId: '91', categoryPathId: '0:976759:976794:7433209' },
    priceInfo: {
      linePrice: money(7.96),
      itemPrice: { value: 3.98, displayValue: '$3.98 ea' },
      unitPrice: { value: 0.249, displayValue: '24.9¢/oz' },
      strikethroughPrice: money(4.48),
    },
    discounts: [{ label: '$1.00 from savings' }],
  };
  const weighed = {
    ...item(2, 'Bananas', 1, 1.24),
    priceInfo: { linePrice: money(1.24), additionalLines: [{ name: 'Final weight', value: '2.3 lbs' }] },
  };
  const plain = item(3, 'Paper Towels', 1, 5.0);
  const sandbox = loadSandbox({ nextData: orderNodeWith([{
    status: { statusType: 'DELIVERED' },
    categories: [
      { type: 'REGULAR', items: [rich, plain] },
      { type: 'WEIGHT_ADJUSTED', items: [weighed] },
      { type: 'SUBSTITUTED', items: [item(4, 'Oat Milk', 1, 4.5)] },
    ],
  }]) });
  const items = sandbox.extractOrderDataFromNextData().items;
  const byName = (name) => items.find((entry) => entry.productName === name);

  const butter = byName('Peanut Butter, 16 oz');
  assert.equal(butter.price, '$7.96', 'the line total is unchanged');
  assert.equal(butter.unitPrice, '$3.98');
  assert.equal(butter.comparisonPrice, '24.9¢/oz');
  assert.equal(butter.wasPrice, '$4.48');
  assert.equal(butter.discount, '$1.00 from savings');
  assert.equal(butter.categoryPathId, '0:976759:976794:7433209');
  assert.equal(butter.returnable, true);
  assert.equal(butter.fulfillment, undefined, 'a regular line carries no fulfillment note');

  assert.equal(byName('Bananas').fulfillment, 'Weight adjusted');
  assert.equal(byName('Bananas').priceNotes, 'Final weight: 2.3 lbs');
  assert.equal(byName('Oat Milk').fulfillment, 'Substituted');

  // A line with none of the optional data keeps exactly the historic fields.
  assert.deepEqual(Object.keys(byName('Paper Towels')).sort(),
    ['deliveryStatus', 'price', 'productLink', 'productName', 'quantity', 'thumbnailUrl', 'usItemId']);
});

test('unavailable and canceled lines are reported apart from the charged lines', () => {
  const categories = [
    { type: 'REGULAR', items: [item(1, 'Milk, 1 Gallon', 1, 3.97)] },
    { type: 'UNAVAILABLE', items: [item(2, 'String Cheese, 12-Count', 2, 9.88)] },
    { type: 'CANCELED', items: [item(3, 'Trash Bags', 1, 6.5)] },
  ];
  const sandbox = loadSandbox({ nextData: orderNodeWith([{
    status: { statusType: 'DELIVERED' },
    categories,
    subGroups: [{ categories }], // the duplicate copy must not double anything
  }]) });
  const data = sandbox.extractOrderDataFromNextData();
  assert.deepEqual(Array.from(data.items, (entry) => entry.productName), ['Milk, 1 Gallon'], 'totals still count charged lines only');
  assert.deepEqual(JSON.parse(JSON.stringify(data.unfulfilledItems)), [
    { productName: 'String Cheese, 12-Count', quantity: '2', reason: 'Unavailable', price: '$9.88', productLink: 'https://www.walmart.com/ip/92', usItemId: '92' },
    { productName: 'Trash Bags', quantity: '1', reason: 'Canceled', price: '$6.50', productLink: 'https://www.walmart.com/ip/93', usItemId: '93' },
  ]);
  assert.equal(data.orderStatus, 'Delivered');
});

test('order-level details: status, late delivery, store and return window', () => {
  const delivered = { status: { statusType: 'DELIVERED', wasDelayed: true }, store: { name: 'Springfield Supercenter' },
    returnEligibilityMessage: 'Return eligible until Sun, Jan 10', categories: [{ type: 'REGULAR', items: [item(1, 'Milk', 1, 3.97)] }] };
  const canceled = { status: { statusType: 'CANCELED', wasDelayed: true }, categories: [{ type: 'CANCELED', items: [item(2, 'Eggs', 1, 2.5)] }] };

  const mixed = loadSandbox({ nextData: orderNodeWith([canceled, delivered]) }).extractOrderDataFromNextData();
  assert.equal(mixed.orderStatus, 'Partly canceled');
  assert.equal(mixed.wasDelayed, true);
  assert.equal(mixed.storeName, 'Springfield Supercenter');
  assert.equal(mixed.returnWindow, 'Return eligible until Sun, Jan 10');

  const allCanceled = loadSandbox({ nextData: orderNodeWith([canceled]) }).extractOrderDataFromNextData();
  assert.equal(allCanceled.orderStatus, 'Canceled');
  assert.equal(allCanceled.noChargedItems, true);
  assert.equal(allCanceled.wasDelayed, undefined, 'a canceled group is not a late delivery');
  assert.equal(allCanceled.unfulfilledItems.length, 1);

  const inProgress = loadSandbox({ nextData: orderNodeWith([{ status: { statusType: 'IN_PROGRESS' }, categories: [{ type: 'REGULAR', items: [item(1, 'Milk', 1, 3.97)] }] }]) })
    .extractOrderDataFromNextData();
  assert.equal(inProgress.orderStatus, 'In progress');
  assert.equal('wasDelayed' in inProgress, false);
  assert.equal('unfulfilledItems' in inProgress, false);
});

test('malformed optional data never fails the order or its lines', () => {
  const odd = {
    ...item(1, 'Milk, 1 Gallon', 1, 3.97),
    isReturnable: 'yes',
    productInfo: { name: 'Milk, 1 Gallon', usItemId: '91', categoryPathId: { nested: true } },
    priceInfo: { linePrice: money(3.97), itemPrice: 42, unitPrice: null, strikethroughPrice: 'n/a', additionalLines: 'oops' },
    discounts: 'none',
  };
  const sandbox = loadSandbox({ nextData: orderNodeWith([{
    status: 'weird', store: 7, returnEligibilityMessage: { text: 1 },
    categories: [{ type: 'REGULAR', items: [odd] }, { type: 'UNAVAILABLE', items: [null, { productInfo: {} }, 5] }],
  }]) });
  const data = sandbox.extractOrderDataFromNextData();
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].productName, 'Milk, 1 Gallon');
  assert.equal(data.items[0].price, '$3.97');
  assert.deepEqual(Object.keys(data.items[0]).sort(),
    ['deliveryStatus', 'price', 'productLink', 'productName', 'quantity', 'thumbnailUrl', 'usItemId']);
  assert.equal('unfulfilledItems' in data, false, 'unreadable unfulfilled lines are skipped, not invented');
  assert.equal('orderStatus' in data, false);
});
