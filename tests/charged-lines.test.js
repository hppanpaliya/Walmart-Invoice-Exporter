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
const { loadSandbox } = require('./helpers/sandbox');

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
