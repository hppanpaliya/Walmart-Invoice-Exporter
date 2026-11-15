/**
 * Demo order history for the Chrome Web Store media (screenshots and tour
 * video). Nothing here comes from a real account: the products are
 * well-known national brands at plausible prices, the order numbers are
 * sequential placeholders, and the dates are generated.
 *
 * Same record shape as seedOrderHistory() in tests/e2e/helpers/harness.js,
 * so it can be passed straight to it as `records`.
 */
'use strict';

// Well-known name-brand products.
const CATALOG = [
  ['Tide PODS Laundry Detergent, 42 ct', 12.97],
  ['Charmin Ultra Soft Toilet Paper, 12 Mega Rolls', 13.24],
  ['Bounty Select-A-Size Paper Towels, 6 Double Rolls', 11.48],
  ['Chobani Greek Yogurt, 4-pack', 4.48],
  ['Horizon Organic Whole Milk, Half Gallon', 4.98],
  ["Eggland's Best Large Eggs, 12 ct", 3.42],
  ['Dole Bananas, each', 0.28],
  ['Cheerios Whole Grain Oat Cereal, 18 oz', 4.93],
  ['Starbucks Pike Place Roast Ground Coffee, 12 oz', 9.97],
  ['Dawn Ultra Dish Soap, 28 oz', 3.94],
  ['Barilla Spaghetti Pasta, 16 oz', 1.84],
  ["Rao's Homemade Marinara Sauce, 24 oz", 6.88],
  ['Tropicana Pure Premium Orange Juice, 52 oz', 4.24],
  ['Nature Valley Crunchy Granola Bars, 12 ct', 3.98],
  ['Philadelphia Original Cream Cheese, 8 oz', 2.97],
  ['Colgate Total Whitening Toothpaste, 2-pack', 7.96],
  ['Dove Deep Moisture Body Wash, 22 oz', 6.97],
  ['Quaker Old Fashioned Oats, 42 oz', 5.48],
  ["Dave's Killer Bread 21 Whole Grains, 27 oz", 5.98],
  ['Kerrygold Pure Irish Butter, 8 oz', 4.48],
];

// Days of the month an order may fall on, so the list does not look stamped.
const ORDER_DAYS = [4, 11, 19, 26, 7, 15, 23];

/**
 * @param {Object} [options]
 * @param {number} [options.months=14] - months of history, walking back from now
 * @param {Date} [options.now] - anchor date (defaults to today, so "This year" has data)
 * @returns {Array<Object>} records for seedOrderHistory(panel, { records })
 */
function buildDemoRecords({ months = 14, now = new Date() } = {}) {
  // Small deterministic generator: the same media every run on the same day.
  let state = 20260;
  const next = (limit) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % limit;
  };

  const records = [];
  let n = 0;
  for (let m = 0; m < months; m += 1) {
    const first = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const lastDay = m === 0 ? now.getDate() : new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const perMonth = m % 3 === 0 ? 3 : 2;
    const days = [];
    for (let k = 0; k < perMonth; k += 1) {
      let day = Math.min(ORDER_DAYS[(m + k * 2) % ORDER_DAYS.length], lastDay);
      while (days.includes(day) && day > 1) day -= 1;
      days.push(day);
    }
    days.sort((a, b) => b - a);

    for (const day of days) {
      n += 1;
      const iso = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const orderNumber = `20009900000${String(1000 + n)}`;
      const itemCount = 3 + next(5);
      // Offset by the order index so neighbouring orders lead with different items.
      const start = (next(CATALOG.length) + n * 7) % CATALOG.length;
      const drift = 1 + m * 0.012; // older months slightly cheaper
      const lineItems = [];
      for (let i = 0; i < itemCount; i += 1) {
        const [name, price] = CATALOG[(start + i * 3) % CATALOG.length];
        if (lineItems.some((item) => item.name === name)) continue;
        lineItems.push({ name, quantity: next(4) === 0 ? 2 : 1, price: Number((price / drift).toFixed(2)) });
      }
      const subtotal = lineItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const tax = subtotal * 0.0825;
      const total = subtotal + tax;
      const summaryOnly = n % 6 === 0;
      records.push({
        orderNumber,
        summaryOnly,
        summary: {
          orderDate: iso,
          orderTotal: Number(total.toFixed(2)),
          subTotal: Number(subtotal.toFixed(2)),
          itemCount: lineItems.length,
          status: 'Delivered',
          items: lineItems.map((item) => ({ name: item.name, quantity: item.quantity })),
        },
        invoice: summaryOnly ? null : {
          schemaVersion: 3,
          orderDate: iso,
          orderNumber,
          orderSubtotal: Number(subtotal.toFixed(2)),
          tax: Number(tax.toFixed(2)),
          tip: 0,
          orderTotal: Number(total.toFixed(2)),
          savings: m % 2 === 0 ? Number((subtotal * 0.05).toFixed(2)) : 0,
          items: lineItems.map((item) => ({ productName: item.name, quantity: item.quantity, price: item.price })),
        },
      });
    }
  }
  return records;
}

// The tour's live-collection scene reads the mock order pages, whose
// fixtures carry short placeholder item names. Show catalog names instead.
const MOCK_ITEM_NAMES = {
  'Great Value Milk 1 Gallon': 'Horizon Organic Whole Milk, Half Gallon',
  'Bananas, each': 'Dole Bananas, each',
  'AA Batteries 8-pack': 'Duracell Coppertop AA Batteries, 8-pack',
  '=HYPERLINK Product "Deal", 2-pack': 'Kleenex Ultra Soft Facial Tissues, 2-pack',
};

/**
 * Rename the mock fixtures' items in place (every string that is exactly a
 * placeholder name, wherever it sits in the payload).
 * @param {Object} payload - a private copy of a fixture payload
 * @returns {Object} the same payload
 */
function withDemoItemNames(payload) {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(MOCK_ITEM_NAMES, value)) node[key] = MOCK_ITEM_NAMES[value];
      else walk(value);
    }
  };
  walk(payload);
  return payload;
}

module.exports = { CATALOG, buildDemoRecords, withDemoItemNames };
