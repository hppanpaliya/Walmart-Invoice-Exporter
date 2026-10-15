'use strict';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { loadSandbox } from './helpers/sandbox';
import { captureDownloads, blobBuffer } from './helpers/capture-downloads';

test('CSV neutralizes formulas hidden behind leading whitespace or control characters', () => {
  const s = loadSandbox({ scripts: ['utils.js'] });
  for (const value of [' =1+1', '\n=1+1', '\t@SUM(1)', '\u0000+1', '\u00a0-HYPERLINK(1)']) {
    const field = s.csvEscape(value);
    assert.ok(field.startsWith("'") || field.startsWith('"\''), 'unsafe string must be apostrophe-prefixed');
  }
  assert.equal(s.csvEscape(-1), '-1');
  assert.equal(s.csvEscape('normal text'), 'normal text');
});

test('all workbook formats reject active/local/credential URLs while retaining HTTPS product links', async () => {
  for (const writer of ['convertSingleOrderToXlsx', 'convertMultipleOrdersToXlsx', 'convertSingleOrderToXlsxLegacy', 'convertMultipleOrdersToXlsxLegacy']) {
    const s = loadSandbox({ scripts: ['utils.js'] });
    const downloads = captureDownloads(s);
    const badUrls = ['javascript:alert(1)', 'data:text/html,bad', 'file:///private/secret', 'https://secret:token@example.test/item'];
    const order = { orderNumber: '42', orderTotal: '$5', items: [...badUrls, 'https://www.walmart.com/ip/100'].map((productLink, i) => ({ productName: `Synthetic ${i}`, quantity: 1, price: '$1', productLink })) };
    await s[writer](writer.includes('Multiple') ? [order] : order, ExcelJS);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(blobBuffer(downloads[0].blob));
    const links = [];
    for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => {
      if (cell.hyperlink) links.push(cell.hyperlink);
      assert.equal(cell.type === ExcelJS.ValueType.Formula, false);
    }));
    assert.deepEqual(links.filter(link => !link.includes('barcode')), ['https://www.walmart.com/ip/100'], writer);
  }
});

test('barcode URLs obey the same URL safety rules as product hyperlinks', async () => {
  for (const writer of ['convertSingleOrderToXlsx', 'convertMultipleOrdersToXlsx', 'convertSingleOrderToXlsxLegacy', 'convertMultipleOrdersToXlsxLegacy']) {
    const s = loadSandbox({ scripts: ['utils.js'] });
    const downloads = captureDownloads(s);
    const order = { orderNumber: '42', orderTotal: '$1', barcodeImageUrl: 'javascript:alert(1)', items: [{ productName: 'Test', quantity: 1, price: '$1' }] };
    await s[writer](writer.includes('Multiple') ? [order] : order, ExcelJS);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(blobBuffer(downloads[0].blob));
    for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => {
      if (cell.hyperlink) assert.doesNotMatch(cell.hyperlink, /^javascript:/, writer);
    }));
    assert.doesNotMatch(s.buildReceiptArticle(order), /src="javascript:/);
  }
});
