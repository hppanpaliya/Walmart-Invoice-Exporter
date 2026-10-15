'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { loadSandbox } = require('./helpers/sandbox');
const { captureDownloads, blobBuffer } = require('./helpers/capture-downloads');

const invoice = {
  orderNumber: '200010000000042',
  orderDate: 'Oct 06, 2026',
  orderSubtotal: '$20.00',
  subtotalBeforeSavings: '$24.00',
  savings: '-$4.00',
  promoCodeAmount: '-$2.00',
  deliveryCharges: '$5.00',
  threeHoursOrLessFee: '$2.95',
  returnedThreeHoursOrLessFee: '-$2.95',
  bagFee: '$0.40',
  tax: '$1.20',
  tip: '$3.00',
  refund: '-$1.00',
  donations: '$0.25',
  orderTotal: '$29.60',
  financialAdjustments: [{ label: 'Eco handling adjustment', amount: '$0.50' }],
  paymentMethodDetails: [],
  paymentSplit: 'Visa ending in 0000: $29.60',
  trackingNumbers: 'TRACKING-123',
  items: [],
};

test('single-order summary and bulk Excel export carry the same named and additional amounts', async () => {
  const sandbox = loadSandbox();
  const downloads = captureDownloads(sandbox);
  await sandbox.convertSingleOrderToXlsx(invoice, ExcelJS, 'single-adjustments.xlsx');
  const singleWorkbook = new ExcelJS.Workbook();
  await singleWorkbook.xlsx.load(blobBuffer(downloads[0].blob));
  const singleRows = new Map();
  singleWorkbook.getWorksheet('Order Invoice').eachRow((row) => {
    const values = row.values.slice(1);
    if (typeof values[0] === 'string') singleRows.set(values[0], values[1]);
  });
  for (const [label, value] of [
    ['Promo Code Amount', -2],
    ['3 Hours or Less Fee', 2.95],
    ['Returned 3 Hours or Less Fee', -2.95],
    ['Refund', -1],
    ['Donations', 0.25],
    ['Other Adjustments (Eco handling adjustment: $0.50)', 0.5],
  ]) {
    assert.equal(singleRows.get(label), value, `single-order invoice includes ${label}`);
  }
  assert.ok(!singleRows.has('Tracking Numbers'), 'single-order Excel omits tracking numbers');

  await sandbox.convertMultipleOrdersToXlsx([invoice], ExcelJS, 'financial-adjustments.xlsx');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(blobBuffer(downloads[1].blob));
  const orders = workbook.getWorksheet('Orders');
  const headers = orders.getRow(1).values.slice(1);
  const values = orders.getRow(2).values.slice(1);
  const cell = (header) => values[headers.indexOf(header)];

  assert.equal(cell('Promo Code Amount'), -2);
  assert.equal(cell('3 Hours or Less Fee'), 2.95);
  assert.equal(cell('Returned 3 Hours or Less Fee'), -2.95);
  assert.equal(cell('Refund'), -1);
  assert.equal(cell('Donations'), 0.25);
  assert.equal(cell('Delivery Charges'), 5);
  assert.equal(cell('Bag Fee'), 0.4);
  assert.equal(cell('Tax'), 1.2);
  assert.equal(cell('Tip'), 3);
  assert.equal(cell('Other Adjustments'), 'Eco handling adjustment: $0.50');
  assert.equal(cell('Other Adjustments Amount'), 0.5);
  assert.ok(!headers.includes('Tracking Numbers'), 'bulk Excel omits tracking-number column');
});

test('single and bulk exports omit redundant or zero adjustment rows and cells', async () => {
  const sandbox = loadSandbox();
  const downloads = captureDownloads(sandbox);
  const noExtras = {
    orderNumber: '200010000000043', orderTotal: '$12.00', items: [],
    financialAdjustments: [
      { label: 'Items (3)', amount: '$12.00' },
      { label: 'Subtotal (25 items)', amount: '$12.00' },
      { label: 'Free shipping, no order minimum', amount: '$0.00' },
      { label: 'Eco handling adjustment', amount: '$0.00' },
    ],
  };

  await sandbox.convertSingleOrderToXlsx(noExtras, ExcelJS, 'single-no-adjustments.xlsx');
  const single = new ExcelJS.Workbook();
  await single.xlsx.load(blobBuffer(downloads[0].blob));
  const labels = [];
  single.getWorksheet('Order Invoice').eachRow((row) => labels.push(row.getCell(1).value));
  assert.ok(!labels.some((label) => String(label || '').startsWith('Other Adjustments')));

  await sandbox.convertMultipleOrdersToXlsx([noExtras], ExcelJS, 'bulk-no-adjustments.xlsx');
  const bulk = new ExcelJS.Workbook();
  await bulk.xlsx.load(blobBuffer(downloads[1].blob));
  const orders = bulk.getWorksheet('Orders');
  const headers = orders.getRow(1).values.slice(1);
  const values = orders.getRow(2).values.slice(1);
  assert.equal(values[headers.indexOf('Other Adjustments')], '');
  assert.equal(values[headers.indexOf('Other Adjustments Amount')], '');
});

test('HTML and PDF receipts preserve all financial adjustments and explicit zero totals', () => {
  const s = loadSandbox({ scripts: ['pdflite.js', 'utils.js'] });
  const html = s.buildReceiptArticle(invoice);
  const pdf = Buffer.from(s.buildReceiptPdf(invoice)).toString('latin1');
  for (const label of ['Promo Code Amount', '3 Hours or Less Fee', 'Returned 3 Hours or Less Fee', 'Eco handling adjustment']) {
    assert.ok(html.includes(label), `HTML includes ${label}`);
    assert.ok(pdf.includes(label), `PDF includes ${label}`);
  }
  const zero = { orderNumber: '42', items: [], orderTotal: 0, tax: 0 };
  assert.match(s.buildReceiptArticle(zero), /Order total/);
  assert.match(Buffer.from(s.buildReceiptPdf(zero)).toString('latin1'), /Order total/);
});

test('legacy bulk Excel appends adjustment columns without shifting its original columns', async () => {
  const s = loadSandbox({ scripts: ['utils.js'] });
  const downloads = captureDownloads(s);
  await s.convertMultipleOrdersToXlsxLegacy([{ ...invoice, items: [{ productName: 'Test item', quantity: 1, price: '$20.00' }] }], ExcelJS);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(blobBuffer(downloads[0].blob));
  const sheet = workbook.worksheets[0];
  const headers = sheet.getRow(1).values;
  assert.equal(headers[18], 'Order Total');
  for (const [label, amount] of [['Promo Code Amount', -2], ['3 Hours or Less Fee', 2.95], ['Returned 3 Hours or Less Fee', -2.95], ['Other Adjustments Amount', 0.5]]) {
    assert.equal(sheet.getRow(2).getCell(headers.indexOf(label)).value, amount, label);
  }
});

test('single Excel formats every additional fee as currency', async () => {
  const s = loadSandbox({ scripts: ['utils.js'] });
  const downloads = captureDownloads(s);
  await s.convertSingleOrderToXlsx(invoice, ExcelJS);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(blobBuffer(downloads[0].blob));
  const expected = new Set(['Promo Code Amount', '3 Hours or Less Fee', 'Returned 3 Hours or Less Fee']);
  workbook.worksheets[0].eachRow(row => {
    if (expected.has(row.getCell(1).value)) {
      assert.equal(row.getCell(2).numFmt, '$#,##0.00');
      expected.delete(row.getCell(1).value);
    }
  });
  assert.equal(expected.size, 0);
});
