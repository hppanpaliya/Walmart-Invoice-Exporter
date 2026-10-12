'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, toPlain } = require('./helpers/sandbox');

function load() {
  return loadSandbox({ scripts: ['utils.js', 'sidepanel.dashboard.js', 'dashboard.trendstats.js', 'dashboard.view-review.js', 'dashboard.view-extras.js'] });
}

test('explicit invoice zero amounts override stale summaries across analytics and order rows', () => {
  const s = load();
  const records = [{ orderNumber: '42', orderDate: '2026-05-31',
    summary: { orderTotal: '$99', subTotal: '$90', driverTip: '$9', tax: '$2', refund: '$4' },
    invoice: { schemaVersion: 3, orderTotal: '$0.00', orderSubtotal: 0, tip: '0', tax: '$0', refund: '$0',
      items: [{ productName: 'Synthetic item', quantity: 1, price: '$0.00' }] } }];
  const stats = s.computeDashboardStats(records);
  assert.equal(stats.totalSpend, 0);
  assert.equal(stats.totalTips, 0);
  assert.equal(stats.totalTax, 0);
  assert.equal(stats.totalRefunds, 0);
  assert.deepEqual(toPlain(stats.monthly), [{ month: '2026-05', total: 0, orders: 1 }]);
  assert.equal(s.buildOrderRowModel('42', records[0]).total, '$0.00');
  assert.equal(s.window.TrendStats.calendarHeatmap(records, new Date(2026, 5, 1)).days[0].total, 0);
  assert.equal(s.ReviewStats.computeYearReview(records, 2026).totalSpent, 0);
  assert.equal(s.OverviewExtras.monthSpend(records, new Date(2026, 4, 31)).spent, 0);
  assert.equal(s.OverviewExtras.refundSummary(records).total, 0);
});

test('zero-total orders count in the average; missing totals still use summary data', () => {
  const s = load();
  const base = { orderDate: '2026-05-01', invoice: { schemaVersion: 3, orderTotal: '$10' } };
  const records = [base, { ...base, invoice: { ...base.invoice, orderTotal: '$0.00' } },
    { ...base, summary: { orderTotal: '$20' }, invoice: { ...base.invoice, orderTotal: '' } }];
  assert.equal(s.computeDashboardStats(records).avgOrder, 10);
});

test('invalid stored dates fall through to a valid summary or invoice date', () => {
  const s = load();
  for (const invalid of ['2026-13-01', '2026-02-30', '2026-01-00', '2026-05', 'invalid']) {
    assert.equal(s.normalizeDashboardDate(invalid), '');
    const record = { orderDate: invalid, summary: { orderDate: '2026-02-28' } };
    assert.equal(s.dashboardRecordDate(record), '2026-02-28');
    assert.equal(s.buildOrderRowModel('42', record).normalizedDate, '2026-02-28');
  }
  assert.equal(s.normalizeDashboardDate('2024-02-29T18:00:00Z'), '2024-02-29');
  assert.equal(s.parseWalmartTitleDate('Feb 30, 2026 order'), '');
});

test('rolling ranges clamp month-end dates and previous periods meet without gaps', () => {
  const s = load();
  const now = new Date(2026, 4, 31, 12);
  assert.deepEqual(toPlain(s.getRangeBounds('last3', now)), { from: '2026-02-28', to: '2026-05-31' });
  assert.deepEqual(toPlain(s.getPreviousRangeBounds('last3', now)), { from: '2025-11-30', to: '2026-02-27' });
});
