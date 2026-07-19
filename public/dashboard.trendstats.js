/**
 * Trend statistics for the dashboard's Trends view (dashboard.view-trends.js).
 *
 * PURE computation only — no DOM, no chrome.*, no Chart.js. Exposed as the
 * global `TrendStats` namespace (same root-guard pattern as the
 * Sidepanel.dashboard shim in sidepanel.dashboard.js) so the view module and
 * the node vm test sandbox consume the exact same code. Loads after utils.js
 * and sidepanel.dashboard.js in every context (dashboard/index.html,
 * tests/helpers/sandbox.js) and reuses their shared globals: parseNumericValue
 * + CONSTANTS (utils.js), dashboardRecordDate + filterDashboardRecords +
 * roundMoneyToCents (sidepanel.dashboard.js). REUSES that parsing — money
 * strings like "$1,234.56", negatives, and missing fields all resolve through
 * the same parseNumericValue every other dashboard number uses.
 *
 * Measurement rule (owner decision, same as computeDashboardStats): ONLY
 * records with a schema-current downloaded invoice are measured — summary-only
 * orders never contribute, but every money field falls back invoice→summary
 * per field (fast SSR-fetched invoices carry items without the price block).
 */
(() => {
  'use strict';

  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /** Whether a record carries a measured (schema-current) invoice. */
  function isMeasured(record) {
    const invoice = record && record.invoice;
    return Boolean(invoice) && Number(invoice.schemaVersion || 0) >= CONSTANTS.ORDER_SCHEMA_VERSION;
  }

  /** Only the measured records of a list (see measurement rule above). */
  function measuredOf(records) {
    return (Array.isArray(records) ? records : []).filter(isMeasured);
  }

  /** Invoice→summary money fallback, both fields optional (moneyOf pairing). */
  function money(invoiceValue, summaryValue) {
    return parseNumericValue(invoiceValue) || parseNumericValue(summaryValue);
  }

  /** A measured record's best grand total (invoice→summary→record fallback). */
  function orderTotalOf(record) {
    const invoice = (record && record.invoice) || {};
    const summary = (record && record.summary) || {};
    return money(invoice.orderTotal, summary.orderTotal || (record && record.orderTotal));
  }

  /** 'YYYY-MM-DD' for a Date in LOCAL time (heatmap days are local days). */
  function isoOf(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /** The 'YYYY-MM' key after `month`, e.g. '2026-12' → '2027-01'. */
  function nextMonthKey(month) {
    let [year, monthNumber] = month.split('-').map(Number);
    monthNumber += 1;
    if (monthNumber > 12) { monthNumber = 1; year += 1; }
    return `${year}-${String(monthNumber).padStart(2, '0')}`;
  }

  /**
   * Contiguous month keys from the first to the last key present in
   * `monthMap`, so line/stacked charts never silently skip a gap month.
   * Capped at 600 months (same guard computeDashboardModel uses).
   */
  function contiguousMonths(monthMap) {
    const present = [...monthMap.keys()].sort();
    if (!present.length) return [];
    const months = [];
    let key = present[0];
    const last = present[present.length - 1];
    for (;;) {
      months.push(key);
      if (key === last || months.length >= 600) break;
      key = nextMonthKey(key);
    }
    return months;
  }

  /**
   * Cumulative spend per month inside a dashboard range.
   *
   * @param {Array} records - OrderDb records (range scoping happens here)
   * @param {string} rangeValue - 'all'|'last3'|'last6'|'thisYear'|'lastYear'
   * @param {Date} [now] - injectable for deterministic tests
   * @returns {Array<{month: string, total: number, cumulative: number}>}
   *          contiguous (gap months at total 0) from the first to the last
   *          measured month in the range; [] when nothing is measured.
   */
  function cumulativeByMonth(records, rangeValue, now = new Date()) {
    const measured = measuredOf(filterDashboardRecords(records, rangeValue || 'all', now));
    const totals = new Map();
    measured.forEach((record) => {
      const month = dashboardRecordDate(record).slice(0, 7);
      const total = orderTotalOf(record);
      if (!month || !total) return;
      totals.set(month, (totals.get(month) || 0) + total);
    });
    let running = 0;
    return contiguousMonths(totals).map((month) => {
      const total = roundMoneyToCents(totals.get(month) || 0);
      running = roundMoneyToCents(running + total);
      return { month, total, cumulative: running };
    });
  }

  /**
   * Year-over-year monthly spend from ALL records (never range-scoped — the
   * whole point is comparing calendar years side by side).
   *
   * @param {Array} records - OrderDb records
   * @param {Date} [now] - injectable for deterministic tests (unused for
   *        scoping; kept for the uniform (records, now) signature)
   * @returns {{years: Array<{year: number, monthly: number[], total: number}>}}
   *          ascending years, capped at the 3 MOST RECENT years that have
   *          measured spend; `monthly` is always 12 numbers (Jan..Dec).
   */
  function yearOverYear(records, now = new Date()) { // eslint-disable-line no-unused-vars
    const byYear = new Map();
    measuredOf(records).forEach((record) => {
      const date = dashboardRecordDate(record);
      const total = orderTotalOf(record);
      if (!date || !total) return;
      const year = Number(date.slice(0, 4));
      const monthIndex = Number(date.slice(5, 7)) - 1;
      if (!year || monthIndex < 0 || monthIndex > 11) return;
      let entry = byYear.get(year);
      if (!entry) {
        entry = { year, monthly: new Array(12).fill(0), total: 0 };
        byYear.set(year, entry);
      }
      entry.monthly[monthIndex] += total;
      entry.total += total;
    });
    const years = [...byYear.values()]
      .filter((entry) => entry.total > 0)
      .sort((a, b) => b.year - a.year) // most recent first…
      .slice(0, 3) // …cap at the 3 most recent years with data…
      .sort((a, b) => a.year - b.year) // …then back to chronological order
      .map((entry) => ({
        year: entry.year,
        monthly: entry.monthly.map(roundMoneyToCents),
        total: roundMoneyToCents(entry.total),
      }));
    return { years };
  }

  /**
   * Calendar-heatmap day buckets for the last 365 days (inclusive of today).
   * The view lays out the grid; this only buckets and totals.
   *
   * @param {Array} records - OrderDb records
   * @param {Date} [now] - injectable for deterministic tests
   * @returns {{days: Array<{date: string, total: number, count: number}>, maxTotal: number}}
   *          ascending by date, ONLY days with at least one measured order.
   */
  function calendarHeatmap(records, now = new Date()) {
    const end = isoOf(now);
    const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 364);
    const start = isoOf(startDate);
    const byDate = new Map();
    measuredOf(records).forEach((record) => {
      const date = dashboardRecordDate(record);
      if (!date || date < start || date > end) return;
      let entry = byDate.get(date);
      if (!entry) {
        entry = { date, total: 0, count: 0 };
        byDate.set(date, entry);
      }
      entry.total += orderTotalOf(record);
      entry.count += 1;
    });
    const days = [...byDate.values()]
      .map((entry) => ({ ...entry, total: roundMoneyToCents(entry.total) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const maxTotal = days.reduce((max, entry) => Math.max(max, entry.total), 0);
    return { days, maxTotal };
  }

  /**
   * How orders were fulfilled: delivery / pickup / in-store / … from the
   * stored fulfillment strings. Both summary.fulfillmentTypes and
   * invoice.fulfillmentTypes are COMMA-SEPARATED (split shipments carry
   * several types); in-store invoices carry isInStore/orderType instead.
   * Orders with no recognizable type bucket as "Other".
   *
   * A split order's total is divided EVENLY across its listed types so the
   * per-type totals still sum to the measured spend (attributing the full
   * total to every type would double-count); `count` counts the order once
   * per type it used, so counts may exceed the order count.
   *
   * @param {Array} records - OrderDb records (already scoped by the caller)
   * @returns {Array<{type: string, count: number, total: number}>} sorted by
   *          total desc, then count desc, then name.
   */
  function fulfillmentSplit(records) {
    const byKey = new Map(); // lowercased type -> {type, count, total}
    measuredOf(records).forEach((record) => {
      const invoice = record.invoice || {};
      const summary = record.summary || {};
      const raw = String(
        summary.fulfillmentTypes ||
        invoice.fulfillmentTypes ||
        (invoice.isInStore ? 'In-store' : invoice.orderType || '')
      );
      const types = raw.split(',').map((part) => part.trim()).filter(Boolean);
      if (!types.length) types.push('Other');
      const share = orderTotalOf(record) / types.length;
      types.forEach((type) => {
        const key = type.toLowerCase();
        let entry = byKey.get(key);
        if (!entry) {
          entry = { type, count: 0, total: 0 }; // display keeps first-seen casing
          byKey.set(key, entry);
        }
        entry.count += 1;
        entry.total += share;
      });
    });
    return [...byKey.values()]
      .map((entry) => ({ ...entry, total: roundMoneyToCents(entry.total) }))
      .sort((a, b) => b.total - a.total || b.count - a.count || a.type.localeCompare(b.type));
  }

  /** Fixed order-size buckets: [min, max) except the open-ended last one. */
  const SIZE_BUCKETS = [
    { label: '$0–25', min: 0, max: 25 },
    { label: '$25–50', min: 25, max: 50 },
    { label: '$50–100', min: 50, max: 100 },
    { label: '$100–200', min: 100, max: 200 },
    { label: '$200+', min: 200, max: Infinity },
  ];

  /**
   * Histogram of measured order totals across fixed buckets. Half-open
   * [min, max) intervals: exactly $25.00 lands in "$25–50". Orders without a
   * resolvable positive total are skipped (never guessed into a bucket).
   *
   * @param {Array} records - OrderDb records (already scoped by the caller)
   * @returns {Array<{label: string, count: number}>} always all 5 buckets, in order.
   */
  function orderSizeHistogram(records) {
    const counts = SIZE_BUCKETS.map(() => 0);
    measuredOf(records).forEach((record) => {
      const total = orderTotalOf(record);
      if (!(total > 0)) return;
      const index = SIZE_BUCKETS.findIndex((bucket) => total >= bucket.min && total < bucket.max);
      if (index >= 0) counts[index] += 1;
    });
    return SIZE_BUCKETS.map((bucket, index) => ({ label: bucket.label, count: counts[index] }));
  }

  /**
   * Orders and spend by day of week (dates resolve through the same
   * dashboardRecordDate every other stat uses; undated records are skipped).
   *
   * @param {Array} records - OrderDb records (already scoped by the caller)
   * @returns {Array<{day: string, count: number, total: number}>} always 7
   *          entries, Sun..Sat.
   */
  function dayOfWeekPattern(records) {
    const buckets = DAY_SHORT.map((day) => ({ day, count: 0, total: 0 }));
    measuredOf(records).forEach((record) => {
      const date = dashboardRecordDate(record);
      if (!date) return;
      // T00:00:00 keeps the parse in local time (a bare date parses as UTC
      // and can land on the previous local day).
      const dayIndex = new Date(`${date}T00:00:00`).getDay();
      if (dayIndex < 0 || dayIndex > 6 || Number.isNaN(dayIndex)) return;
      buckets[dayIndex].count += 1;
      buckets[dayIndex].total += orderTotalOf(record);
    });
    return buckets.map((bucket) => ({ ...bucket, total: roundMoneyToCents(bucket.total) }));
  }

  /**
   * Where each dollar went, per month: the same invoice→summary field pairs
   * detailMoneyLines/computeDashboardStats read (orderSubtotal/subTotal,
   * tax/tax, tip/driverTip, deliveryCharges+bagFee, savings/savings).
   * Savings are reported as a positive magnitude. Every month object always
   * carries all five keys — the view decides which all-zero series to omit.
   *
   * @param {Array} records - OrderDb records (range scoping happens here)
   * @param {string} rangeValue - 'all'|'last3'|'last6'|'thisYear'|'lastYear'
   * @param {Date} [now] - injectable for deterministic tests
   * @returns {Array<{month: string, subtotal: number, tax: number, tip: number,
   *          fees: number, savings: number}>} contiguous months (gaps zeroed).
   */
  function moneyComposition(records, rangeValue, now = new Date()) {
    const measured = measuredOf(filterDashboardRecords(records, rangeValue || 'all', now));
    const byMonth = new Map();
    measured.forEach((record) => {
      const month = dashboardRecordDate(record).slice(0, 7);
      if (!month) return;
      const invoice = record.invoice || {};
      const summary = record.summary || {};
      let entry = byMonth.get(month);
      if (!entry) {
        entry = { month, subtotal: 0, tax: 0, tip: 0, fees: 0, savings: 0 };
        byMonth.set(month, entry);
      }
      entry.subtotal += money(invoice.orderSubtotal, summary.subTotal);
      entry.tax += money(invoice.tax, summary.tax);
      entry.tip += money(invoice.tip, summary.driverTip);
      entry.fees += parseNumericValue(invoice.deliveryCharges) + parseNumericValue(invoice.bagFee);
      // Stored savings can be negative (adjustments exceeding discounts);
      // Math.abs would lie, so keep the sign and round like everything else.
      entry.savings += money(invoice.savings, summary.savings);
    });
    return contiguousMonths(byMonth).map((month) => {
      const entry = byMonth.get(month) || { month, subtotal: 0, tax: 0, tip: 0, fees: 0, savings: 0 };
      return {
        month,
        subtotal: roundMoneyToCents(entry.subtotal),
        tax: roundMoneyToCents(entry.tax),
        tip: roundMoneyToCents(entry.tip),
        fees: roundMoneyToCents(entry.fees),
        savings: roundMoneyToCents(entry.savings),
      };
    });
  }

  // Same root-guard export the Sidepanel namespace uses — window in pages,
  // self in workers, globalThis in the bare vm test context.
  const root =
    typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis;
  root.TrendStats = {
    cumulativeByMonth,
    yearOverYear,
    calendarHeatmap,
    fulfillmentSplit,
    orderSizeHistogram,
    dayOfWeekPattern,
    moneyComposition,
  };
})();
