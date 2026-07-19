'use strict';

/**
 * Legacy Excel writer (design spec P0c, §5.3): pre-6.18 single-sheet
 * layout, recovered verbatim from git history (`git show f6a282d^:utils.js`)
 * as new, additive `convert*Legacy` functions. Not wired into the side
 * panel yet — that happens in a later phase. These tests only prove the
 * recovered functions produce the old shape; tests/golden.test.js
 * separately pins that the CURRENT (non-legacy, default) writers are
 * untouched by this addition.
 *
 * See the file-level comment in tests/golden.test.js for why XLSX cells
 * are read back via ExcelJS rather than hashed, and why array-form
 * `worksheet.addRow([...])` output (only used by the shared, unmodified
 * addOrderSummary()) isn't asserted through this vm-sandboxed harness.
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { loadSandbox } from './helpers/sandbox';
import { captureDownloads, blobBuffer } from './helpers/capture-downloads';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const detailPayload = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'order-detail.json'), 'utf8'));

const LEGACY_MULTI_ORDER_HEADERS = [
  'Order Number', 'Order Date', 'Address Recipient', 'Shipping Address', 'Delivery Instructions',
  'Payment Method', 'Payment Messages', 'Subtotal (Before Savings)', 'Savings', 'Subtotal',
  'Product Name', 'Quantity', 'Price', 'Delivery Charges', 'Bag Fee',
  'Tax', 'Tip', 'Order Total', 'Delivery Status', 'Product Link',
  'Seller(s)', 'Fulfillment', 'Delivered Date', 'Tracking Numbers', 'Payment Split',
  'Refund', 'Donations', 'Receipt Barcode', 'Order Type',
];

function loadExtractedOrder() {
  const sandbox = loadSandbox({ nextData: detailPayload });
  return { sandbox, order: sandbox.scrapeOrderData() };
}

/** Second, sparse hand-built order — same shape used in tests/golden.test.js. */
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

test('legacy: convertMultipleOrdersToXlsxLegacy is a SINGLE "Walmart Orders" sheet with the 29 legacy headers', async () => {
  const { sandbox, order: orderA } = loadExtractedOrder();
  const orderB = secondOrder();
  const downloads = captureDownloads(sandbox);

  // Through the mode-dispatching entry point, like the panel will call it.
  await sandbox.convertToXlsxLegacy([orderA, orderB], ExcelJS, { mode: 'multiple', filename: 'legacy.xlsx' });
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, 'legacy.xlsx');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(blobBuffer(downloads[0].blob));

  assert.deepEqual(workbook.worksheets.map((w) => w.name), ['Walmart Orders'], 'exactly one sheet, not Orders+Items');

  const sheet = workbook.getWorksheet('Walmart Orders');
  assert.equal(LEGACY_MULTI_ORDER_HEADERS.length, 29, 'sanity: this test itself expects 29 legacy columns');
  assert.deepEqual(sheet.getRow(1).values.slice(1), LEGACY_MULTI_ORDER_HEADERS);

  // One row per ITEM (not per order) — order fields repeat on every row,
  // which is the defining pre-6.18 shape this toggle restores.
  assert.equal(sheet.rowCount, 5, 'header + 3 items from order A + 1 item from order B');

  assert.deepEqual(sheet.getRow(2).values.slice(1), [
    '200010000000042', 'Jul 01, 2026', 'Test Customer', 'Test Customer, 123 Main St, Springfield IL 62704',
    'Leave at door', 'VISA - ending in 1234 | Amount: $20.00 || GIFTCARD - Gift Card | Amount: $6.84',
    'Charged Jul 2', 20.53, 2, 18.53,
    'Great Value Milk 1 Gallon', 2, 7.96, 0, 0.25,
    1.14, 4, 28.11, 'Delivered',
    { text: 'Great Value Milk 1 Gallon', hyperlink: 'https://www.walmart.com/ip/10450114' },
    'Walmart.com; Acme Marketplace LLC', 'DELIVERY, SHIPPING', 'Jul 02, 2026',
    '1Z999AA10123456784; 1Z999AA10123456785', 'VISA ending in 1234: $20.00; GIFTCARD Gift Card: $6.84',
    3.98, 1, { text: 'Barcode', hyperlink: 'https://receipts-query.edge.walmart.com/barcode?data=sanitized' }, 'GLASS',
  ]);

  // Order-level fields (address, payment, subtotal...) repeat unchanged on
  // the order's other item rows — the exact "double-counts if summed" shape
  // release 6.18 replaced.
  const row3 = sheet.getRow(3).values.slice(1);
  assert.equal(row3[0], '200010000000042');
  assert.equal(row3[9], 18.53, 'Subtotal repeats on every item row of the order');
  assert.equal(row3[10], 'Bananas, each');

  // Order B's item row populates too (proves the writer isn't order-A-only).
  const row5 = sheet.getRow(5).values.slice(1);
  assert.equal(row5[0], '77501234567890123456');
  assert.equal(row5[10], 'AA Batteries 8-pack');
  assert.equal(row5[11], 1);
  assert.equal(row5[12], 9.42);
  assert.equal(row5[18], 'Purchased in store');
  assert.equal(row5[28], 'In-store');
  // Legacy quirk, recovered as-is: an item with no productLink still gets a
  // {text, hyperlink:''} object (old code has no productLink-present guard),
  // and ExcelJS itself renders an empty-hyperlink object as a literal JSON
  // string rather than a real hyperlink cell — not something this writer's
  // own logic controls, so it is intentionally not pinned here.
});

test('legacy: convertMultipleOrdersToXlsxLegacy does not change the default Orders+Items writer', async () => {
  const { sandbox, order: orderA } = loadExtractedOrder();
  const downloads = captureDownloads(sandbox);

  await sandbox.convertMultipleOrdersToXlsx([orderA], ExcelJS, 'default.xlsx', {});
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(blobBuffer(downloads[0].blob));

  assert.deepEqual(workbook.worksheets.map((w) => w.name), ['Orders', 'Items'], 'default export is unaffected by the new legacy functions');
});

test('legacy: convertToXlsxLegacy (single mode) reuses the current Order Invoice sheet and items', async () => {
  const { sandbox, order: orderA } = loadExtractedOrder();
  const downloads = captureDownloads(sandbox);

  await sandbox.convertToXlsxLegacy(orderA, ExcelJS, { mode: 'single' });
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, 'Order_200010000000042.xlsx');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(blobBuffer(downloads[0].blob));

  assert.deepEqual(workbook.worksheets.map((w) => w.name), ['Order Invoice']);
  const sheet = workbook.worksheets[0];
  assert.deepEqual(sheet.getRow(1).values.slice(1), [
    'Product Name', 'Quantity', 'Price', 'Delivery Status', 'Product Link',
  ]);
  assert.deepEqual(sheet.getRow(2).values.slice(1), [
    'Great Value Milk 1 Gallon', 2, 7.96, 'Delivered',
    { text: 'Great Value Milk 1 Gallon', hyperlink: 'https://www.walmart.com/ip/10450114' },
  ]);
  assert.deepEqual(sheet.getRow(4).values.slice(1), [
    '=HYPERLINK Product "Deal", 2-pack', 1, 11.12, 'Canceled',
    { text: '=HYPERLINK Product "Deal", 2-pack', hyperlink: 'https://www.walmart.com/ip/998877' },
  ]);
});

test('legacy: configureMultipleOrdersColumnsLegacy appends an optional Thumbnail column', () => {
  const { sandbox } = loadExtractedOrder();

  // configureMultipleOrdersColumnsLegacy only needs a settable .columns
  // property, so a plain object stands in for the ExcelJS worksheet here —
  // this pins the column-count contract so a future edit can't silently
  // drop the optional column.
  const withThumbnails = {};
  sandbox.configureMultipleOrdersColumnsLegacy(withThumbnails, { includeThumbnails: true });
  assert.equal(withThumbnails.columns.length, 30, '29 legacy columns + optional Thumbnail column');
  assert.equal(withThumbnails.columns[29].header, 'Thumbnail');

  const withoutThumbnails = {};
  sandbox.configureMultipleOrdersColumnsLegacy(withoutThumbnails, { includeThumbnails: false });
  assert.equal(withoutThumbnails.columns.length, 29, 'Thumbnail column omitted by default');
});
