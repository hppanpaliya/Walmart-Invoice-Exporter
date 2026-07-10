'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox } = require('./helpers/sandbox');

test('buildDomOrderSummary scrapes date, total, item count, and status from card text', () => {
  const sandbox = loadSandbox();
  const summary = sandbox.buildDomOrderSummary(
    {
      textContent:
        'July 01, 2026 order\nDelivered\n3 items\n$28.11 total\nView details',
    },
    '200010000000042'
  );

  assert.equal(summary.orderNumber, '200010000000042');
  assert.equal(summary.orderDate, 'July 01, 2026');
  assert.equal(summary.orderTotal, '$28.11');
  assert.equal(summary.itemCount, 3);
  assert.equal(summary.status, 'Delivered');
  assert.equal(summary.items.length, 0);
});

test('buildDomOrderSummary prefers the amount adjacent to "total"', () => {
  const sandbox = loadSandbox();
  const summary = sandbox.buildDomOrderSummary(
    { textContent: 'Jun 15, 2026 purchase $2.50 off coupon Total: $9.42 In progress' },
    '111222333444555'
  );
  assert.equal(summary.orderTotal, '$9.42');
  assert.equal(summary.status, 'In progress');
});

test('buildDomOrderSummary degrades to blanks on empty cards', () => {
  const sandbox = loadSandbox();
  const summary = sandbox.buildDomOrderSummary({ textContent: '' }, '999');
  assert.equal(summary.orderDate, '');
  assert.equal(summary.orderTotal, '');
  assert.equal(summary.itemCount, '');
  assert.equal(summary.status, '');
});
