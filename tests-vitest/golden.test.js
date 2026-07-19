'use strict';

/**
 * Golden-output safety net (design spec P0, "docs/superpowers/specs/
 * 2026-07-14-panel-redesign-and-storage-unification-design.md" §6).
 *
 * Pins the CURRENT output of all five export formats so an accidental
 * change to a default column, sheet name, or number format — while
 * reworking the panel/storage in later phases — fails loudly here first.
 *
 * Deliberately NOT hashing raw bytes: the .xlsx zip container embeds
 * non-deterministic bits (timestamps, etc.) even for byte-identical
 * content, so instead each workbook is re-read with ExcelJS into plain
 * sheet names / header rows / representative data cells, which IS
 * deterministic. CSV/JSON/HTML are asserted as exact strings (or the
 * exact header + representative rows), since those are already
 * deterministic string builders.
 *
 * Test-harness note: tests/helpers/sandbox.js runs utils.js/content.js in
 * a Node `vm` context (a separate realm). ExcelJS worksheet objects
 * created there are real (host-realm) objects, but plain array literals
 * *constructed by the sandboxed code* are vm-realm arrays — and ExcelJS's
 * `worksheet.addRow(someArray)` silently no-ops on a cross-realm array
 * (confirmed empirically; `Array.isArray` says true, `instanceof Array`
 * says false, and ExcelJS's internal check apparently relies on the
 * latter). This only affects the single-order sheet's *summary block*
 * below the items (addOrderSummary uses `addRow([label, value])`, a bare
 * array) — every other writer here uses object-form `addRow({...})`,
 * which is unaffected and asserted in full. In the real extension all
 * scripts share one window/realm, so this is purely a test-double
 * artifact, not a product bug — hence it is scoped out below rather than
 * "fixed" by touching the (out-of-scope, unmodified) converters.
 *
 * Same root cause shows up once more with plain objects: order A comes
 * from sandboxed extraction (scrapeOrderData()), so it carries the vm
 * realm's Object.prototype. assert.deepEqual (strict mode) treats that as
 * unequal to a same-shaped host-realm object, so the JSON test compares
 * through toPlain() (JSON.parse(JSON.stringify(...))) rather than the raw
 * sandboxed value.
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { loadSandbox, toPlain } from './helpers/sandbox';
import { captureDownloads, blobBuffer, blobText } from './helpers/capture-downloads';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const detailPayload = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'order-detail.json'), 'utf8'));

/**
 * Order #1: run the real extraction pipeline (utils.js + content.js)
 * against the order-detail fixture, exactly like tests/content.detail.test.js
 * does. This is a "full invoice" order with three items, one of which has
 * a formula-injection-shaped name (pins CSV/XLSX handling of that too.
 */
function loadExtractedOrder() {
  const sandbox = loadSandbox({ nextData: detailPayload });
  const order = sandbox.scrapeOrderData();
  return { sandbox, order };
}

/**
 * Order #2: a hand-built sparse order (mirrors the object shape
 * tests/utils.export.test.js builds by hand), deliberately missing several
 * money fields to pin blank-vs-zero behavior at export time.
 */
function secondOrder() {
  return {
    schemaVersion: 3,
    orderNumber: '77501234567890123456',
    orderDate: 'Jun 15, 2026',
    orderType: 'IN_STORE',
    isInStore: true,
    orderSubtotal: '$8.88',
    subtotalBeforeSavings: '',
    savings: '',
    orderTotal: '$9.42',
    deliveryCharges: '',
    bagFee: '',
    tax: '$0.54',
    tip: '',
    refund: '',
    donations: '',
    barcodeImageUrl: '',
    sellers: 'Walmart.com',
    fulfillmentTypes: 'IN_STORE',
    deliveredDate: '',
    trackingNumbers: '',
    paymentSplit: '',
    address: '',
    addressRecipient: '',
    addressLine: '',
    deliveryInstructions: '',
    paymentMethods: '',
    paymentMethodDetails: [],
    paymentMessages: '',
    items: [
      {
        productName: 'AA Batteries 8-pack',
        productLink: '',
        deliveryStatus: 'Purchased in store',
        quantity: '1',
        price: '$9.42',
        thumbnailUrl: '',
      },
    ],
  };
}

/** Split buildCsvContent() output into header + data lines, stripping the BOM. */
function csvLines(csvText) {
  assert.equal(csvText.charCodeAt(0), 0xfeff, 'CSV must start with a UTF-8 BOM');
  return csvText.slice(1).replace(/\r\n$/, '').split('\r\n');
}

test('golden: convertMultipleOrdersToXlsx produces the current Orders+Items workbook', async () => {
  const { sandbox, order: orderA } = loadExtractedOrder();
  const orderB = secondOrder();
  const downloads = captureDownloads(sandbox);

  await sandbox.convertMultipleOrdersToXlsx([orderA, orderB], ExcelJS, 'test.xlsx', {});
  assert.equal(downloads.length, 1);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(blobBuffer(downloads[0].blob));

  assert.deepEqual(workbook.worksheets.map((w) => w.name), ['Orders', 'Items']);

  const orders = workbook.getWorksheet('Orders');
  assert.deepEqual(orders.getRow(1).values.slice(1), [
    'Order Number', 'Order Date', 'Order Type', 'Data', 'Items',
    'Subtotal (Before Savings)', 'Savings', 'Subtotal', 'Delivery Charges', 'Bag Fee',
    'Tax', 'Tip', 'Refund', 'Donations', 'Order Total',
    'Payment Method', 'Payment Split', 'Payment Messages', 'Seller(s)', 'Fulfillment',
    'Delivered Date', 'Tracking Numbers', 'Ship To', 'Delivery Instructions', 'Receipt Barcode',
  ]);
  assert.equal(orders.rowCount, 3, 'header + one row per order');

  assert.deepEqual(orders.getRow(2).values.slice(1), [
    '200010000000042', 'Jul 01, 2026', 'GLASS', 'Full invoice', 3,
    20.53, 2, 18.53, 0, 0.25,
    1.14, 4, 3.98, 1, 28.11,
    'VISA - ending in 1234 | Amount: $20.00 || GIFTCARD - Gift Card | Amount: $6.84',
    'VISA ending in 1234: $20.00; GIFTCARD Gift Card: $6.84', 'Charged Jul 2',
    'Walmart.com; Acme Marketplace LLC', 'DELIVERY, SHIPPING', 'Jul 02, 2026',
    '1Z999AA10123456784; 1Z999AA10123456785', 'Test Customer, 123 Main St, Springfield IL 62704',
    'Leave at door', { text: 'Barcode', hyperlink: 'https://receipts-query.edge.walmart.com/barcode?data=sanitized' },
  ]);

  // Sparse order: missing money fields render BLANK, never a fake $0.00 —
  // but a genuine "$0.00" (not present here) would still show as 0.
  const sparseRow = orders.getRow(3).values.slice(1);
  assert.equal(sparseRow[0], '77501234567890123456');
  assert.equal(sparseRow[2], 'In-store', 'isInStore formats the raw type away');
  assert.equal(sparseRow[5], '', 'Subtotal (Before Savings) blank, not 0, when unknown');
  assert.equal(sparseRow[6], '', 'Savings blank, not 0, when unknown');
  assert.equal(sparseRow[7], 8.88, 'Subtotal is known and numeric');
  assert.equal(sparseRow[14], 9.42, 'Order Total is known and numeric');

  const items = workbook.getWorksheet('Items');
  assert.deepEqual(items.getRow(1).values.slice(1), [
    'Order Number', 'Order Date', 'Product Name', 'Qty', 'Price', 'Status', 'Order Type', 'Product Link',
  ]);
  assert.equal(items.rowCount, 5, 'header + 3 items from order A + 1 item from order B');

  assert.deepEqual(items.getRow(2).values.slice(1), [
    '200010000000042', 'Jul 01, 2026', 'Great Value Milk 1 Gallon', 2, 7.96, 'Delivered', 'GLASS',
    { text: 'Great Value Milk 1 Gallon', hyperlink: 'https://www.walmart.com/ip/10450114' },
  ]);
  // Formula-injection-shaped product name: XLSX keeps it as a literal string
  // (no CSV-style quote-prefixing — that guard is CSV-specific).
  assert.deepEqual(items.getRow(4).values.slice(1), [
    '200010000000042', 'Jul 01, 2026', '=HYPERLINK Product "Deal", 2-pack', 1, 11.12, 'Canceled', 'GLASS',
    { text: '=HYPERLINK Product "Deal", 2-pack', hyperlink: 'https://www.walmart.com/ip/998877' },
  ]);
  assert.deepEqual(items.getRow(5).values.slice(1), [
    '77501234567890123456', 'Jun 15, 2026', 'AA Batteries 8-pack', 1, 9.42, 'Purchased in store', 'In-store', '',
  ]);
});

test('golden: convertToXlsx (single mode) produces the current Order Invoice sheet', async () => {
  const { sandbox, order: orderA } = loadExtractedOrder();
  const downloads = captureDownloads(sandbox);

  await sandbox.convertToXlsx(orderA, ExcelJS, { mode: 'single' });
  assert.equal(downloads.length, 1);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(blobBuffer(downloads[0].blob));

  assert.deepEqual(workbook.worksheets.map((w) => w.name), ['Order Invoice']);
  const sheet = workbook.worksheets[0];

  assert.deepEqual(sheet.getRow(1).values.slice(1), [
    'Product Name', 'Quantity', 'Price', 'Delivery Status', 'Product Link',
  ]);
  // Item rows only — the summary block below them (Order Number/Total/etc.)
  // is not exercised here; see the file-level comment above.
  assert.deepEqual(sheet.getRow(2).values.slice(1), [
    'Great Value Milk 1 Gallon', 2, 7.96, 'Delivered',
    { text: 'Great Value Milk 1 Gallon', hyperlink: 'https://www.walmart.com/ip/10450114' },
  ]);
  assert.deepEqual(sheet.getRow(3).values.slice(1), [
    'Bananas, each', 6, 1.62, 'Delivered',
    { text: 'Bananas, each', hyperlink: 'https://www.walmart.com/ip/44390948' },
  ]);
  assert.deepEqual(sheet.getRow(4).values.slice(1), [
    '=HYPERLINK Product "Deal", 2-pack', 1, 11.12, 'Canceled',
    { text: '=HYPERLINK Product "Deal", 2-pack', hyperlink: 'https://www.walmart.com/ip/998877' },
  ]);
});

test('golden: convertOrdersToCsv produces the current accounting-friendly CSV pair', async () => {
  const { sandbox, order: orderA } = loadExtractedOrder();
  const orderB = secondOrder();
  const downloads = captureDownloads(sandbox);

  await sandbox.convertOrdersToCsv([orderA, orderB], {});
  assert.equal(downloads.length, 2, 'orders.csv then items.csv');
  assert.equal(downloads[0].filename, 'Walmart_Orders.csv');
  assert.equal(downloads[1].filename, 'Walmart_Order_Items.csv');

  const ordersLines = csvLines(blobText(downloads[0].blob));
  assert.equal(
    ordersLines[0],
    'Order Number,Order Date,Items,Address Recipient,Shipping Address,Delivery Instructions,'
      + 'Payment Method,Payment Messages,Payment Split,Subtotal (Before Savings),Savings,Subtotal,'
      + 'Delivery Charges,Bag Fee,Tax,Tip,Refund,Donations,Order Total,Seller(s),Fulfillment,'
      + 'Delivered Date,Tracking Numbers,Receipt Barcode URL,Order Type'
  );
  assert.equal(
    ordersLines[1],
    '200010000000042,"Jul 01, 2026",3,Test Customer,"Test Customer, 123 Main St, Springfield IL 62704",'
      + 'Leave at door,VISA - ending in 1234 | Amount: $20.00 || GIFTCARD - Gift Card | Amount: $6.84,'
      + 'Charged Jul 2,VISA ending in 1234: $20.00; GIFTCARD Gift Card: $6.84,20.53,2,18.53,0,0.25,1.14,4,'
      + '3.98,1,28.11,Walmart.com; Acme Marketplace LLC,"DELIVERY, SHIPPING","Jul 02, 2026",'
      + '1Z999AA10123456784; 1Z999AA10123456785,https://receipts-query.edge.walmart.com/barcode?data=sanitized,GLASS'
  );
  // Order-level money columns here have no blankWhenEmpty guard (unlike the
  // XLSX Orders sheet), so an unknown Subtotal/Savings/etc. reads as 0 — an
  // existing, pinned quirk (Refund/Donations DO stay blank, at the end).
  assert.equal(
    ordersLines[2],
    '77501234567890123456,"Jun 15, 2026",1,,,,,,,0,0,8.88,0,0,0.54,0,,,9.42,Walmart.com,IN_STORE,,,,In-store'
  );

  const itemLines = csvLines(blobText(downloads[1].blob));
  assert.equal(itemLines[0], 'Order Number,Order Date,Product Name,Quantity,Price,Delivery Status,Product Link');
  assert.equal(
    itemLines[1],
    '200010000000042,"Jul 01, 2026",Great Value Milk 1 Gallon,2,7.96,Delivered,https://www.walmart.com/ip/10450114'
  );
  // Formula-injection guard: a leading quote is prefixed, and the field then
  // needs CSV-quoting because it now contains a comma.
  assert.equal(
    itemLines[3],
    '200010000000042,"Jul 01, 2026","\'=HYPERLINK Product ""Deal"", 2-pack",1,11.12,Canceled,https://www.walmart.com/ip/998877'
  );
  assert.equal(
    itemLines[4],
    '77501234567890123456,"Jun 15, 2026",AA Batteries 8-pack,1,9.42,Purchased in store,'
  );
});

test('golden: convertOrdersToJson dumps the order array verbatim', () => {
  const { sandbox, order: orderA } = loadExtractedOrder();
  const orderB = secondOrder();
  const downloads = captureDownloads(sandbox);

  sandbox.convertOrdersToJson([orderA, orderB], 'x.json');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, 'x.json');

  const parsed = JSON.parse(blobText(downloads[0].blob));
  // toPlain() strips the vm-realm prototype orderA carries (it was built by
  // sandboxed code) so deepEqual compares structure, not realm identity —
  // see the file-level comment above.
  assert.deepEqual(parsed, toPlain([orderA, orderB]));
});

test('golden: convertOrdersToReceiptHtml renders one printable receipt per order', () => {
  const { sandbox, order: orderA } = loadExtractedOrder();
  const orderB = secondOrder();
  const downloads = captureDownloads(sandbox);

  sandbox.convertOrdersToReceiptHtml([orderA, orderB], 'x.html');
  assert.equal(downloads.length, 1);

  const html = blobText(downloads[0].blob);
  assert.ok(html.includes('<title>Walmart Receipts</title>'));
  assert.equal((html.match(/class="receipt"/g) || []).length, 2, 'one receipt article per order');

  assert.ok(html.includes('Walmart Order #200010000000042'));
  assert.ok(html.includes('<img class="barcode" src="https://receipts-query.edge.walmart.com/barcode?data=sanitized"'));
  // The formula-injection-shaped product name is HTML-escaped, not CSV-quoted.
  assert.ok(html.includes('=HYPERLINK Product &quot;Deal&quot;, 2-pack'));
  assert.ok(html.includes('<td class="amt">$7.96</td>'));
  assert.ok(html.includes('<tr class="grand"><td>Order total</td><td class="amt">$28.11</td></tr>'));

  assert.ok(html.includes('Walmart Order #77501234567890123456'));
  // No barcode URL on order B — no <img> for its receipt.
  assert.ok(!html.includes('barcode" src=""'));
  assert.ok(html.includes('<tr class="grand"><td>Order total</td><td class="amt">$9.42</td></tr>'));
  // Blank totals rows (Savings, Tip, Refund, Donations, ...) are omitted
  // entirely for order B, not shown as $0.00.
  assert.ok(!html.includes('<td>Savings</td><td class="amt"></td>'));
});
