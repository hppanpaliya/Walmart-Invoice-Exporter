'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox } = require('./helpers/sandbox');

test('buildDomOrderSummary scrapes total, item count, and status from card text', () => {
  const sandbox = loadSandbox();
  const summary = sandbox.buildDomOrderSummary(
    {
      textContent:
        'July 01, 2026 order\nDelivered\n3 items\n$28.11 total\nView details',
    },
    '200010000000042',
    'July 01, 2026 order'
  );

  assert.equal(summary.source, 'dom');
  assert.equal(summary.orderNumber, '200010000000042');
  assert.equal(summary.orderDate, 'July 01, 2026');
  assert.equal(summary.orderTotal, '$28.11');
  assert.equal(summary.itemCount, 3);
  assert.equal(summary.status, 'Delivered');
  assert.equal(summary.items.length, 0);
});

test('buildDomOrderSummary takes the date from the title only, never the card body', () => {
  const sandbox = loadSandbox();
  const summary = sandbox.buildDomOrderSummary(
    // Dates in the card body (e.g. delivery estimates) are not order dates.
    { textContent: 'Delivery estimate Jul 15, 2026 Total: $9.42 In progress' },
    '111222333444555',
    'Order details'
  );
  assert.equal(summary.orderDate, '', 'body dates must not be mistaken for the order date');
  assert.equal(summary.orderTotal, '$9.42');
  assert.equal(summary.status, 'In progress');
});

test('buildDomOrderSummary degrades to blanks on empty cards', () => {
  const sandbox = loadSandbox();
  const summary = sandbox.buildDomOrderSummary({ textContent: '' }, '999', '');
  assert.equal(summary.orderDate, '');
  assert.equal(summary.orderTotal, '');
  assert.equal(summary.itemCount, '');
  assert.equal(summary.status, '');
});

test('isPayloadQualitySummary distinguishes payload from DOM summaries', () => {
  const sandbox = loadSandbox({ scripts: ['utils.js'] });
  assert.equal(sandbox.isPayloadQualitySummary({ source: 'payload' }), true);
  assert.equal(sandbox.isPayloadQualitySummary({ source: 'dom', items: [] }), false);
  // Legacy summaries without a source tag: payload quality is inferred.
  assert.equal(sandbox.isPayloadQualitySummary({ items: [{ name: 'Milk' }] }), true);
  assert.equal(sandbox.isPayloadQualitySummary({ subTotal: '$18.53' }), true);
  assert.equal(sandbox.isPayloadQualitySummary({ items: [] }), false);
  assert.equal(sandbox.isPayloadQualitySummary(null), false);
});
