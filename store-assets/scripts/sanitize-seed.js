/**
 * Sanitize a REAL order export into a PII-free seed fixture for store media.
 *
 *   1. In your real browser: open the extension on walmart.com/orders,
 *      "Select all", set Export format to JSON, click "Single file (.json)".
 *   2. node store-assets/scripts/sanitize-seed.js ~/Downloads/Walmart_Orders.json
 *   3. Re-run generate-store-assets.sh / generate-store-video.sh — both use
 *      store-assets/scripts/seed-data.json automatically when it exists.
 *
 * Privacy model: ALLOWLIST, not blocklist. Only the fields named below are
 * ever copied into the fixture — names, addresses, payment methods, tracking
 * numbers, barcodes, emails, account info, product links, and every field
 * this script doesn't know about are dropped by construction. Real order
 * numbers are replaced with sequential fake ones. The output file is
 * gitignored; review the printed item list before recording (product names
 * and prices are kept — that's the realism — so veto anything you'd rather
 * not show with --exclude).
 *
 * Usage:
 *   node sanitize-seed.js <export.json> [--exclude <regex>] [--max <n>]
 *
 *   --exclude  case-insensitive regex; matching items are removed and
 *              order totals recomputed (e.g. --exclude "pharmacy|vitamin")
 *   --max      keep at most n most-recent orders (default: all)
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const OUT = path.join(__dirname, 'seed-data.json');

function fail(message) {
  console.error(`sanitize-seed: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const inputPath = args.find((a) => !a.startsWith('--'));
if (!inputPath) fail('usage: node sanitize-seed.js <export.json> [--exclude <regex>] [--max <n>]');
const excludeIdx = args.indexOf('--exclude');
const exclude = excludeIdx !== -1 ? new RegExp(args[excludeIdx + 1], 'i') : null;
const maxIdx = args.indexOf('--max');
const maxOrders = maxIdx !== -1 ? Number(args[maxIdx + 1]) : Infinity;

const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const orders = Array.isArray(raw) ? raw : [raw];
if (orders.length === 0) fail('export contains no orders');

/** "$1,234.56" | "1234.56" | 1234.56 → number (0 for blank/unparsable). */
function money(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = Number(String(value ?? '').replace(/[^0-9.-]+/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** First non-empty candidate, as trimmed string. */
function pick(...values) {
  for (const v of values) {
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return '';
}

const round2 = (n) => Number(n.toFixed(2));

const skipped = { excludedItems: 0, emptyOrders: 0 };
const distinctItems = new Map(); // name -> count

let seq = 0;
const records = [];
for (const order of orders) {
  if (!order || typeof order !== 'object') continue;

  // --- items: name, quantity, price. Nothing else survives. ---
  const rawItems = Array.isArray(order.items) ? order.items : [];
  const items = [];
  for (const item of rawItems) {
    const name = pick(item && item.productName, item && item.name);
    if (!name) continue;
    if (exclude && exclude.test(name)) { skipped.excludedItems += 1; continue; }
    const quantity = Math.max(1, Math.round(money(item.quantity)) || 1);
    const price = round2(money(item.price));
    items.push({ name, quantity, price });
    distinctItems.set(name, (distinctItems.get(name) || 0) + quantity);
  }
  if (items.length === 0) { skipped.emptyOrders += 1; continue; }

  const orderDate = pick(order.orderDate, order.date);
  const status = pick(order.deliveryStatus, order.status, 'Delivered').split(';')[0].trim();

  // --- money: recompute subtotal when items were excluded, so nothing is
  // internally inconsistent; otherwise keep the order's own numbers. ---
  const exportedSubtotal = money(order.orderSubtotal ?? order.subTotal);
  const itemsSubtotal = round2(items.reduce((sum, i) => sum + i.price * i.quantity, 0));
  const droppedFromThisOrder = rawItems.length > items.length;
  const subtotal = droppedFromThisOrder || !exportedSubtotal ? itemsSubtotal : round2(exportedSubtotal);
  const tax = round2(money(order.tax));
  const tip = round2(money(order.tip ?? order.driverTip));
  const savings = round2(money(order.savings));
  const exportedTotal = money(order.orderTotal);
  const total = droppedFromThisOrder || !exportedTotal
    ? round2(subtotal + tax + tip)
    : round2(exportedTotal);

  seq += 1;
  const orderNumber = `20009900${String(100000 + seq)}`; // fake, sequential
  records.push({
    orderNumber,
    summary: {
      orderDate,
      orderTotal: total,
      subTotal: subtotal,
      itemCount: items.length,
      status,
      items: items.map((i) => ({ name: i.name, quantity: i.quantity })),
    },
    invoice: {
      schemaVersion: 3,
      orderDate,
      orderNumber,
      orderSubtotal: subtotal,
      tax,
      tip,
      orderTotal: total,
      savings,
      items: items.map((i) => ({ productName: i.name, quantity: i.quantity, price: i.price })),
    },
  });
}

if (records.length === 0) fail('no usable orders after sanitizing');

// Newest first by parseable date (unparseable dates sink to the end), cap.
const time = (r) => {
  const t = Date.parse(r.summary.orderDate);
  return Number.isFinite(t) ? t : -Infinity;
};
records.sort((a, b) => time(b) - time(a));
const kept = records.slice(0, maxOrders);

// A few summary-only records keep the "not measured yet" coverage story
// honest in captures (same ratio the synthetic seed uses).
kept.forEach((record, i) => {
  if ((i + 1) % 8 === 0) record.invoice = null;
});

fs.writeFileSync(OUT, JSON.stringify(kept, null, 2));

console.log(`sanitized ${kept.length} orders (of ${orders.length} exported) -> ${path.relative(process.cwd(), OUT)}`);
if (skipped.excludedItems) console.log(`  excluded ${skipped.excludedItems} item(s) matching ${exclude}`);
if (skipped.emptyOrders) console.log(`  dropped ${skipped.emptyOrders} order(s) with no usable items`);
console.log('\nKept fields: dates, status, item name/qty/price, subtotal/tax/tip/savings/total.');
console.log('Dropped by construction: names, addresses, payment methods, tracking, barcodes,');
console.log('product links, real order numbers, and any field not named in this script.\n');
console.log('REVIEW before recording — distinct items that will appear on screen:');
for (const [name, count] of [...distinctItems.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}x  ${name}`);
}
console.log('\nRe-run with --exclude "<regex>" to remove anything you do not want shown.');
