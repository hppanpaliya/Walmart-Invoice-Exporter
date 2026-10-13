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
    ['Other Adjustments', 'Eco handling adjustment: $0.50'],
  ]) {
    assert.equal(singleRows.get(label), value, `single-order invoice includes ${label}`);
  }

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
});
