'use strict';

// (F7 regression) unknown-total orders must be skipped, not exported as $0
const { test: __t } = require('node:test');
const __assert = require('node:assert/strict');
const { loadSandbox: __load } = require('./helpers/sandbox');
__t('accounting CSV skips orders with unknown totals instead of writing $0 rows', () => {
  const sandbox = __load({ scripts: ['utils.js'] });
  const { rows, skipped } = sandbox.buildAccountingCsvRows(
    [
      { orderNumber: '1', orderDate: '2026-06-14T00:00:00Z', orderTotal: '$10.00', items: [] },
      { orderNumber: '2', orderDate: '2026-06-15T00:00:00Z', orderTotal: '', items: [] },
    ],
    'quickbooks'
  );
  __assert.equal(rows.length, 1, 'unknown-total order must be skipped');
  __assert.equal(skipped, 1);
  __assert.equal(rows[0][2], -10);
});


const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, evalIn, toPlain } = require('./helpers/sandbox');

function loadUtils() {
  return loadSandbox({ scripts: ['utils.js'] });
}

const onlineOrder = {
  orderNumber: '200010000000042',
  orderDate: '2026-07-01T14:23:00.000-04:00',
  orderTotal: '$28.11',
  items: [
    { productName: 'Great Value Milk 1 Gallon' },
    { productName: 'Bananas, each' },
    { productName: '=HYPERLINK Product "Deal", 2-pack' },
  ],
};

test('CONSTANTS exposes the CSV presets used by the panel', () => {
  const sandbox = loadUtils();
  const presets = toPlain(evalIn(sandbox, 'CONSTANTS.CSV_PRESETS'));
  assert.deepEqual(presets, { GENERIC: 'generic', QUICKBOOKS: 'quickbooks', XERO: 'xero' });
});

test('QuickBooks preset produces the 3-column bank format with negative amounts', () => {
  const sandbox = loadUtils();
  const { header, rows } = sandbox.buildAccountingCsvRows([onlineOrder], 'quickbooks');

  assert.deepEqual(toPlain(header), ['Date', 'Description', 'Amount']);
  assert.equal(rows.length, 1);
  assert.deepEqual(toPlain(rows[0]), [
    '07/01/2026',
    'Walmart order #200010000000042 (3 items)',
    -28.11,
  ]);
});

test('Xero preset produces Date,Amount,Payee,Description,Reference rows', () => {
  const sandbox = loadUtils();
  const { header, rows } = sandbox.buildAccountingCsvRows([onlineOrder], 'xero');

  assert.deepEqual(toPlain(header), ['Date', 'Amount', 'Payee', 'Description', 'Reference']);
  const [date, amount, payee, description, reference] = toPlain(rows[0]);
  assert.equal(date, '07/01/2026');
  assert.equal(amount, -28.11);
  assert.equal(payee, 'Walmart');
  assert.equal(description, 'Great Value Milk 1 Gallon; Bananas, each; =HYPERLINK Product "Deal", 2-pack');
  assert.equal(reference, '200010000000042');
});

test('accounting rows accept a single order object (not just arrays)', () => {
  const sandbox = loadUtils();
  const { rows } = sandbox.buildAccountingCsvRows(onlineOrder, 'quickbooks');
  assert.equal(rows.length, 1);
});

test('formatAccountingDate renders MM/DD/YYYY and falls back to raw strings', () => {
  const sandbox = loadUtils();
  // Full ISO with timezone offset — leading date wins, no timezone shifting.
  assert.equal(sandbox.formatAccountingDate('2026-07-01T14:23:00.000-04:00'), '07/01/2026');
  // Date-only ISO.
  assert.equal(sandbox.formatAccountingDate('2026-07-09'), '07/09/2026');
  // Short form produced by the detail extraction.
  assert.equal(sandbox.formatAccountingDate('Jul 01, 2026'), '07/01/2026');
  // Unparseable values fall back to the raw string.
  assert.equal(sandbox.formatAccountingDate('not a date'), 'not a date');
  assert.equal(sandbox.formatAccountingDate(''), '');
});

test('Xero description truncates long item lists to ~120 chars', () => {
  const sandbox = loadUtils();
  const longName = 'Synthetic Product With A Deliberately Long Name For Truncation';
  const order = {
    orderNumber: '111222333444555',
    orderDate: '2026-06-15',
    orderTotal: '$99.99',
    items: [1, 2, 3, 4, 5].map((n) => ({ productName: `${longName} ${n}` })),
  };
  const { rows } = sandbox.buildAccountingCsvRows([order], 'xero');
  const description = rows[0][3];
  assert.ok(description.length <= 120, `description too long: ${description.length}`);
  assert.ok(description.endsWith('...'), 'over-long descriptions must be truncated');
});

test('Xero description falls back to the order title, then the order number', () => {
  const sandbox = loadUtils();
  const noItems = { orderNumber: '42', orderDate: '2026-06-15', orderTotal: '$1.00', items: [], title: 'June order' };
  assert.equal(sandbox.buildAccountingCsvRows([noItems], 'xero').rows[0][3], 'June order');

  const bare = { orderNumber: '42', orderDate: '2026-06-15', orderTotal: '$1.00' };
  assert.equal(sandbox.buildAccountingCsvRows([bare], 'xero').rows[0][3], 'Walmart order #42');
});

test('preset CSV content keeps BOM, CRLF, and RFC-4180 + formula escaping', () => {
  const sandbox = loadUtils();
  const evilOrder = {
    orderNumber: '999888777666555',
    orderDate: '2026-06-15',
    orderTotal: '$5.00',
    items: [{ productName: '=EVIL(), "quoted"' }],
  };
  const { header, rows } = sandbox.buildAccountingCsvRows([evilOrder], 'xero');
  const csv = sandbox.buildCsvContent(toPlain(header), toPlain(rows));

  assert.equal(csv.charCodeAt(0), 0xfeff, 'BOM required');
  assert.ok(csv.endsWith('\r\n'), 'CRLF line endings with trailing newline');
  // Formula-leading description gets the quote prefix and RFC-4180 quoting.
  assert.ok(csv.includes('"\'=EVIL(), ""quoted"""'), 'formula injection must be neutralized');
  // Negative amounts stay plain numbers.
  assert.ok(csv.includes(',-5,'), 'amount must be a negative number');
});

test('generic preset machinery is untouched', () => {
  const sandbox = loadUtils();
  assert.equal(typeof sandbox.convertOrdersToCsv, 'function');
  const headers = toPlain(evalIn(sandbox, 'ORDER_CSV_COLUMNS.map(([header]) => header)'));
  assert.equal(headers[0], 'Order Number');
  assert.ok(headers.includes('Order Total'));
  // The accounting writer is a separate path; the generic columns carry
  // the full order schema, not the 3/5-column bank shapes.
  assert.ok(headers.length > 10);
});
