'use strict';

// The optional line and order details (price each, was price, category, order
// status, lines never charged) in the Excel and CSV exports. Every one of them
// is blank when the saved invoice does not carry it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { loadSandbox } = require('./helpers/sandbox');
const { captureDownloads, blobBuffer, blobText } = require('./helpers/capture-downloads');

const detailed = {
  orderNumber: '200010000000042', orderDate: 'Jul 01, 2026', orderTotal: '$21.65', orderSubtotal: '$20.00', tax: '$1.65',
  orderStatus: 'Partly canceled', wasDelayed: true, storeName: 'Springfield Supercenter', returnWindow: 'Return eligible until Sun, Jan 10',
  items: [
    { productName: 'Peanut Butter, 16 oz', quantity: '2', price: '$7.96', unitPrice: '$3.98', wasPrice: '$4.48', discount: '$1.00 from savings',
      comparisonPrice: '24.9¢/oz', categoryPathId: '0:976759:976794', returnable: true, productLink: 'https://www.walmart.com/ip/91', deliveryStatus: 'Delivered' },
    { productName: 'Bananas', quantity: '1', price: '$1.24', fulfillment: 'Weight adjusted', priceNotes: 'Final weight: 2.3 lbs',
      categoryPathId: '0:999999999', returnable: false, productLink: 'N/A', deliveryStatus: 'Delivered' },
    { productName: 'Paper Towels', quantity: '1', price: '$5.00', productLink: 'N/A', deliveryStatus: 'Delivered' },
  ],
  unfulfilledItems: [{ productName: 'String Cheese, 12-Count', quantity: '2', reason: 'Unavailable', price: '$9.88', productLink: 'https://www.walmart.com/ip/92' }],
};
const plain = { orderNumber: '200010000000043', orderDate: 'Jul 02, 2026', orderTotal: '$5.00',
  items: [{ productName: 'Soap', quantity: '1', price: '$5.00', productLink: 'N/A', deliveryStatus: 'Delivered' }] };
const canceled = { orderNumber: '200010000000044', orderDate: 'Jul 03, 2026', orderTotal: '$0.00', items: [], noChargedItems: true };

test('Excel: optional details fill the appended columns and a Not Fulfilled sheet', async () => {
  const s = loadSandbox({ scripts: ['utils.js'] });
  const downloads = captureDownloads(s);
  await s.convertMultipleOrdersToXlsx([detailed, plain, canceled], ExcelJS, 'x.xlsx', {});
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(blobBuffer(downloads[0].blob));
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Orders', 'Items', 'Not Fulfilled']);

  const orders = workbook.getWorksheet('Orders');
  const tail = (row, count) => { const values = row.values.slice(1); while (values.length < row.worksheet.columnCount) values.push(''); return values.slice(-count).map((v) => (v === null || v === undefined ? '' : v)); };
  assert.deepEqual(orders.getRow(1).values.slice(-5), ['Order Status', 'Late Delivery', 'Store', 'Return Window', 'Items Not Fulfilled']);
  assert.deepEqual(tail(orders.getRow(2), 5), ['Partly canceled', 'Yes', 'Springfield Supercenter', 'Return eligible until Sun, Jan 10', 1]);
  assert.deepEqual(tail(orders.getRow(3), 5), ['', '', '', '', ''], 'an order without the details stays blank');
  assert.deepEqual(tail(orders.getRow(4), 5), ['Canceled', '', '', '', ''], 'a fully canceled order still gets its status');

  const items = workbook.getWorksheet('Items');
  assert.deepEqual(items.getRow(1).values.slice(-7), ['Price Each', 'Was Price', 'Savings', 'Price per Unit', 'Category', 'Note', 'Returnable']);
  assert.deepEqual(tail(items.getRow(2), 7), [3.98, 4.48, '$1.00 from savings', '24.9¢/oz', 'Food', '', 'Yes']);
  assert.deepEqual(tail(items.getRow(3), 7), ['', '', '', '', '', 'Weight adjusted; Final weight: 2.3 lbs', 'No'], 'an unknown department has no name');
  assert.deepEqual(tail(items.getRow(4), 7), ['', '', '', '', '', '', '']);
  assert.equal(items.getRow(2).getCell(5).value, 7.96, 'Price is still the line total');

  const missed = workbook.getWorksheet('Not Fulfilled');
  assert.deepEqual(missed.getRow(1).values.slice(1), ['Order Number', 'Order Date', 'Product Name', 'Qty', 'Reason', 'Price (Not Charged)', 'Product Link']);
  assert.deepEqual(missed.getRow(2).values.slice(1, 7), ['200010000000042', 'Jul 01, 2026', 'String Cheese, 12-Count', 2, 'Unavailable', 9.88]);
  assert.equal(missed.rowCount, 2);
});

test('Excel: no Not Fulfilled sheet when nothing went unfulfilled', async () => {
  const s = loadSandbox({ scripts: ['utils.js'] });
  const downloads = captureDownloads(s);
  await s.convertMultipleOrdersToXlsx([plain], ExcelJS, 'x.xlsx', {});
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(blobBuffer(downloads[0].blob));
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Orders', 'Items']);
});

test('CSV: optional details are appended and blank when absent', async () => {
  const s = loadSandbox({ scripts: ['utils.js'] });
  const downloads = captureDownloads(s);
  await s.convertOrdersToCsv([detailed, plain], {});
  const lines = (blob) => blobText(blob).slice(1).replace(/\r\n$/, '').split('\r\n');
  const orders = lines(downloads[0].blob);
  assert.ok(orders[0].endsWith(',Order Status,Late Delivery,Store,Return Window,Items Not Fulfilled'));
  assert.ok(orders[1].endsWith(',Partly canceled,Yes,Springfield Supercenter,"Return eligible until Sun, Jan 10",1'));
  assert.ok(orders[2].endsWith(',,,,,'));
  const items = lines(downloads[1].blob);
  assert.ok(items[0].endsWith(',Price Each,Was Price,Savings,Price per Unit,Category,Note,Returnable'));
  assert.ok(items[1].endsWith(',3.98,4.48,$1.00 from savings,24.9¢/oz,Food,,Yes'));
  assert.ok(items[2].endsWith(',,,,,,Weight adjusted; Final weight: 2.3 lbs,No'));
  assert.ok(items[3].endsWith(',,,,,,,'));
});

test('department and status helpers never guess', () => {
  const s = loadSandbox({ scripts: ['utils.js'] });
  assert.equal(s.walmartDepartmentName('0:976759:976794:7433209'), 'Food');
  assert.equal(s.walmartDepartmentName('1115193:1025739'), 'Household Essentials');
  assert.equal(s.walmartDepartmentName('0:6163033:2795380'), 'Services');
  for (const value of ['', null, undefined, '0', '0:424242', 'not-a-path', {}]) assert.equal(s.walmartDepartmentName(value), '');
  assert.equal(s.orderStatusLabel({ orderStatus: 'Delivered' }), 'Delivered');
  assert.equal(s.orderStatusLabel({ noChargedItems: true }), 'Canceled');
  assert.equal(s.orderStatusLabel({ items: [{ deliveryStatus: 'Delivered' }] }), '', 'no status is invented from line text');
  assert.equal(s.orderStatusLabel(null), '');
});
