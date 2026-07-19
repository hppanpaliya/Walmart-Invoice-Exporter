'use strict';

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadSandbox, evalIn, toPlain } from './helpers/sandbox';

function loadUtils() {
  return loadSandbox({ scripts: ['utils.js'] });
}

test('parseNumericValue strips currency formatting', () => {
  const sandbox = loadUtils();
  assert.equal(sandbox.parseNumericValue('$1,234.56'), 1234.56);
  assert.equal(sandbox.parseNumericValue('-$3.98'), -3.98);
  assert.equal(sandbox.parseNumericValue(''), 0);
  assert.equal(sandbox.parseNumericValue(12.5), 12.5);
});

test('csvEscape quotes per RFC 4180 and neutralizes formula injection', () => {
  const sandbox = loadUtils();
  assert.equal(sandbox.csvEscape('plain'), 'plain');
  assert.equal(sandbox.csvEscape('a,b'), '"a,b"');
  assert.equal(sandbox.csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(sandbox.csvEscape('line\nbreak'), '"line\nbreak"');
  // Formula-leading strings get a quote prefix…
  assert.equal(sandbox.csvEscape('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(sandbox.csvEscape('+2 Pack'), "'+2 Pack");
  assert.equal(sandbox.csvEscape('@handle'), "'@handle");
  // …but numbers (incl. negatives) never do.
  assert.equal(sandbox.csvEscape(-3.98), '-3.98');
});

test('buildCsvContent emits BOM, CRLF line endings, and a trailing newline', () => {
  const sandbox = loadUtils();
  const csv = sandbox.buildCsvContent(['A', 'B'], [['1', '2× Milk']]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(csv.slice(1), 'A,B\r\n1,2× Milk\r\n');
});

test('describeActiveFilters reports filters but ignores tracking params', () => {
  const sandbox = loadUtils();
  const filters = toPlain(sandbox.describeActiveFilters(
    'https://www.walmart.com/orders?orderStatus=delivered&utm_medium=email&gclid=abc&athcpid=xyz&page=2'
  ));
  assert.deepEqual(filters, ['orderStatus: delivered']);
  assert.deepEqual(toPlain(sandbox.describeActiveFilters('https://www.walmart.com/orders')), []);
  assert.deepEqual(toPlain(sandbox.describeActiveFilters('not a url')), []);
});

test('formatPaymentMethodDetails renders per-card amounts', () => {
  const sandbox = loadUtils();
  const text = sandbox.formatPaymentMethodDetails({
    paymentMethodDetails: [
      { brand: 'VISA', ending: 'ending in 1234', amount: '$20.00' },
      { brand: 'GIFTCARD', ending: '', amount: '$6.84' },
    ],
  });
  assert.equal(text, 'VISA - ending in 1234 | Amount: $20.00 || GIFTCARD | Amount: $6.84');
});

test('escapeHtml neutralizes markup', () => {
  const sandbox = loadUtils();
  assert.equal(
    sandbox.escapeHtml('<img src=x onerror=alert(1)> & "quotes"'),
    '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;'
  );
});

test('buildReceiptArticle escapes attacker-controlled product names', () => {
  const sandbox = loadUtils();
  const html = sandbox.buildReceiptArticle({
    orderNumber: '123',
    orderDate: 'Jul 01, 2026',
    orderTotal: '$5.00',
    barcodeImageUrl: 'https://receipts-query.edge.walmart.com/barcode?data="onload="x',
    items: [
      { productName: '<script>alert(1)</script>', quantity: '1', price: '$5.00', deliveryStatus: 'Delivered' },
    ],
  });

  assert.ok(!html.includes('<script>alert(1)</script>'), 'product name must be escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped form should appear');
  assert.ok(!html.includes('data="onload='), 'barcode URL must be attribute-escaped');
  assert.ok(html.includes('Walmart Order #123'));
});

test('receipt totals rows skip empty values and keep the grand total', () => {
  const sandbox = loadUtils();
  const html = sandbox.buildReceiptArticle({
    orderNumber: '9',
    orderDate: '',
    orderSubtotal: '$1.00',
    refund: '',
    orderTotal: '$1.10',
    items: [],
  });
  assert.ok(html.includes('Subtotal'));
  assert.ok(!html.includes('Refund'));
  assert.ok(html.includes('Order total'));
});

test('order-level CSV columns produce accounting-friendly numbers', () => {
  const sandbox = loadUtils();
  const order = {
    orderNumber: '200010000000042',
    orderDate: 'Jul 01, 2026',
    items: [{}, {}],
    orderSubtotal: '$18.53',
    tax: '$1.14',
    tip: '$4.00',
    refund: '',
    donations: '$1.00',
    orderTotal: '$28.11',
    sellers: 'Walmart.com',
  };
  const columns = evalIn(sandbox, 'ORDER_CSV_COLUMNS');
  const byHeader = Object.fromEntries(columns.map(([header, getter]) => [header, getter(order)]));

  assert.equal(byHeader['Order Number'], '200010000000042');
  assert.equal(byHeader['Items'], 2);
  assert.equal(byHeader['Subtotal'], 18.53);
  assert.equal(byHeader['Tax'], 1.14);
  assert.equal(byHeader['Refund'], '', 'no refund should be blank, not 0');
  assert.equal(byHeader['Donations'], 1);
  assert.equal(byHeader['Order Total'], 28.11);
});

test('CONSTANTS exposes the export formats used by the panel', () => {
  const sandbox = loadUtils();
  const formats = toPlain(evalIn(sandbox, 'CONSTANTS.EXPORT_FORMATS'));
  assert.deepEqual(formats, { XLSX: 'xlsx', CSV: 'csv', JSON: 'json', RECEIPT: 'receipt', PDF: 'pdf' });
});
