/**
 * Shared dashboard computation module.
 *
 * Pure aggregation logic as plain global functions (testable in the node vm
 * sandbox), consumed by dashboard.page.js — the full-page spending dashboard
 * (dashboard.html). The old in-panel dashboard view is gone; this file no
 * longer renders anything. Everything is computed on-device from the local
 * order database — the dashboard never talks to walmart.com.
 */

// normalizeDashboardDate moved to utils.js (spec 2026-07-17 addendum) — the
// receipt-style order list (sidepanel.view.js) needs the same ISO/human/
// empty date normalization for its month grouping and date-range filter,
// so it now lives as a shared global alongside the other date/text
// utilities instead of being dashboard-only. utils.js loads before this
// file in every context (sidepanel.html, tests/helpers/sandbox.js), so the
// global is always defined by the time the functions below run.

/** Round a money value to cents (floating-point sums drift otherwise). */
function roundMoneyToCents(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/**
 * Aggregate spend statistics from order-database records.
 *
 * ONLY fully downloaded invoices are measured — mixing summary-level
 * collection data in would produce misleading half-measurements (owner
 * decision). `orderCount` reports everything stored so the UI can show
 * coverage; every money metric covers invoices exclusively.
 *
 * @param {Array} records - OrderDb records ({orderNumber, orderDate, summary, invoice, ...})
 * @returns {{
 *   orderCount: number,
 *   invoiceCount: number,
 *   totalSpend: number,
 *   avgOrder: number,
 *   totalTips: number,
 *   totalSavings: number,
 *   totalTax: number,
 *   totalRefunds: number,
 *   totalDonations: number,
 *   totalSubtotal: number,
 *   totalFees: number,
 *   monthly: Array<{month: string, total: number, orders: number}>,
 *   topItems: Array<{name: string, orders: number, quantity: number, spend: number}>
 * }}
 */
function computeDashboardStats(records) {
  const list = Array.isArray(records) ? records : [];

  let invoiceCount = 0;
  let totalSpend = 0;
  let totaledOrders = 0;
  let totalTips = 0;
  let totalSavings = 0;
  let totalTax = 0;
  let totalRefunds = 0;
  let totalDonations = 0;
  let totalSubtotal = 0;
  let totalFees = 0;
  const monthlyTotals = new Map();
  const itemsByKey = new Map();

  list.forEach((record) => {
    let invoice = record?.invoice || null;
    // Pre-v3 invoices may contain doubled items / $0.00 prices — measuring
    // them would corrupt every number. They count as not-downloaded.
    if (invoice && Number(invoice.schemaVersion || 0) < CONSTANTS.ORDER_SCHEMA_VERSION) invoice = null;
    if (!invoice) return; // summary-only orders are NOT measured
    invoiceCount += 1;

    // Prefer the downloaded invoice's grand total, but fall back to the
    // summary total captured at collection time. The fast (in-page fetch)
    // invoice path parses an order's SSR __NEXT_DATA__, which carries the
    // line items but NOT the price block (Walmart loads pricing client-side
    // after hydration) — so invoice.orderTotal is often empty even though the
    // order IS a full, measured invoice. The purchase-history summary always
    // has the order total, so use it rather than showing $0.
    // A fast (SSR-fetch) invoice often lacks its own price block, but the
    // purchase-history summary carries the same money fields — fall back to it
    // field-by-field so Total/Savings/Tax/Tips aren't stuck at $0.
    const summary = record.summary || {};
    const money = (invoiceValue, summaryValue) =>
      parseNumericValue(invoiceValue) || parseNumericValue(summaryValue || '');

    const total = money(invoice.orderTotal, summary.orderTotal || record.orderTotal);
    if (total) {
      totalSpend += total;
      totaledOrders += 1;
    }

    totalTips += money(invoice.tip, summary.driverTip);
    totalSavings += money(invoice.savings, summary.savings);
    totalTax += money(invoice.tax, summary.tax);
    totalRefunds += money(invoice.refund, summary.refund);
    totalDonations += money(invoice.donations, summary.donations);
    totalSubtotal += money(invoice.orderSubtotal, summary.subTotal);
    totalFees += parseNumericValue(invoice.deliveryCharges) + parseNumericValue(invoice.bagFee);

    // Month from any date format we may have stored (ISO or human).
    const normalized = dashboardRecordDate(record);
    const month = normalized.slice(0, 7);
    if (month && total) {
      const bucket = monthlyTotals.get(month) || { total: 0, orders: 0 };
      bucket.total += total;
      bucket.orders += 1;
      monthlyTotals.set(month, bucket);
    }

    // Item repurchase counts from invoice items. Count once per order.
    const rawItems = Array.isArray(invoice.items)
      ? invoice.items.map((item) => ({ name: item?.productName, quantity: item?.quantity, price: item?.price }))
      : [];

    const seenInOrder = new Set();
    rawItems.forEach(({ name, quantity, price }) => {
      const cleanName = String(name || '').trim();
      if (!cleanName) return;
      const key = cleanName.toLowerCase();

      let entry = itemsByKey.get(key);
      if (!entry) {
        entry = { name: cleanName, orders: 0, quantity: 0, spend: 0 };
        itemsByKey.set(key, entry);
      }
      const qty = quantity === null || quantity === undefined || quantity === ''
        ? 1
        : parseNumericValue(quantity);
      entry.quantity += qty;
      entry.spend += parseNumericValue(price);
      if (!seenInOrder.has(key)) {
        seenInOrder.add(key);
        entry.orders += 1;
      }
    });
  });

  const monthly = [...monthlyTotals.entries()]
    .map(([month, bucket]) => ({ month, total: roundMoneyToCents(bucket.total), orders: bucket.orders }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const topItems = [...itemsByKey.values()]
    .filter((entry) => entry.orders > 1)
    .sort((a, b) => b.orders - a.orders || b.quantity - a.quantity || a.name.localeCompare(b.name))
    .slice(0, 10)
    .map((entry) => ({ ...entry, spend: roundMoneyToCents(entry.spend) }));

  return {
    orderCount: list.length,
    invoiceCount,
    totalSpend: roundMoneyToCents(totalSpend),
    avgOrder: totaledOrders > 0 ? roundMoneyToCents(totalSpend / totaledOrders) : 0,
    totalTips: roundMoneyToCents(totalTips),
    totalSavings: roundMoneyToCents(totalSavings),
    totalTax: roundMoneyToCents(totalTax),
    totalRefunds: roundMoneyToCents(totalRefunds),
    totalDonations: roundMoneyToCents(totalDonations),
    totalSubtotal: roundMoneyToCents(totalSubtotal),
    totalFees: roundMoneyToCents(totalFees),
    monthly,
    topItems,
  };
}

/**
 * Resolve a record's best stored date (record → summary → invoice) to
 * 'YYYY-MM-DD', else fall back to the date embedded in Walmart's own list
 * title ("Jun 15, 2022 order") — old orders often have no date anywhere
 * else — else ''.
 */
function dashboardRecordDate(record) {
  const deliveredRaw = String(
    record?.summary?.deliveredDate || record?.invoice?.deliveredDate || ''
  ).split(';')[0].trim();
  return (
    normalizeDashboardDate(
      record?.orderDate || record?.summary?.orderDate || record?.invoice?.orderDate || ''
    ) ||
    normalizeDashboardDate(deliveredRaw) ||
    parseWalmartTitleDate(record?.title || record?.summary?.title || '')
  );
}

/**
 * Scope OrderDb records to a "Showing"-style range — the SAME range engine
 * the order list's filter uses (getRangeBounds/isDateInRange in utils.js),
 * so the dashboard scope and the list filter can never disagree. 'all' (or
 * falsy) passes everything through; bounded ranges exclude undated records.
 * @param {Array} records - OrderDb records
 * @param {string} rangeValue - LIST_RANGE_OPTIONS value ('all'|'last3'|'last6'|'thisYear'|'lastYear')
 * @param {Date} [now] - injectable for deterministic tests
 * @returns {Array} the records whose date falls inside the range
 */
function filterDashboardRecords(records, rangeValue, now = new Date()) {
  const list = Array.isArray(records) ? records : [];
  if (!rangeValue || rangeValue === 'all') return list;
  const bounds = getRangeBounds(rangeValue, now);
  return list.filter((record) => isDateInRange(dashboardRecordDate(record), bounds));
}

/**
 * Inclusive 'YYYY-MM-DD' bounds of the period immediately before a range —
 * what the headline's "vs last period" delta compares against. Calendar
 * years shift by a whole year; rolling ranges (last3/last6) shift back by
 * their own length. All-time (and anything unbounded) has no previous
 * period → null.
 * @param {string} rangeValue
 * @param {Date} [now]
 * @returns {{from: string, to: string}|null}
 */
function getPreviousRangeBounds(rangeValue, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const year = now.getFullYear();

  switch (rangeValue) {
    case 'thisYear':
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    case 'lastYear':
      return { from: `${year - 2}-01-01`, to: `${year - 2}-12-31` };
    case 'last3':
    case 'last6': {
      const monthsBack = rangeValue === 'last3' ? 3 : 6;
      const from = new Date(now);
      from.setMonth(from.getMonth() - monthsBack * 2);
      const to = new Date(now);
      to.setMonth(to.getMonth() - monthsBack);
      to.setDate(to.getDate() - 1);
      return { from: isoOf(from), to: isoOf(to) };
    }
    default:
      return null;
  }
}

/**
 * Build the full scoped dashboard model (v7.2 dashboard redesign): every
 * number computed from the records inside `rangeValue`, compared against
 * the previous period, with zero-filled chart months, price-watch movers,
 * and actionable coverage. Pure — rendering lives in the IIFE below.
 *
 * @param {Array} records - ALL OrderDb records (scoping happens here)
 * @param {string} rangeValue - dashboard scope ('all'|'last3'|'last6'|'thisYear'|'lastYear')
 * @param {Date} [now] - injectable for deterministic tests
 * @returns {{
 *   range: string,
 *   stats: Object,                 // computeDashboardStats over the scoped records
 *   prevTotalSpend: number|null,   // previous period's measured spend; null when no previous period exists
 *   deltaPercent: number|null,     // spend change vs previous period; null hides the delta (never lies)
 *   avgPerMonth: number,           // measured spend / months with measured spend
 *   chartMonths: Array<{month: string, total: number, orders: number}>, // contiguous, zero-filled, clamped at "now"
 *   priceWatch: Array<{name: string, firstPrice: number, latestPrice: number, percentChange: number}>,
 *   coverage: {stored: number, measured: number, missingOrderNumbers: string[]}
 * }}
 */
function computeDashboardModel(records, rangeValue, now = new Date()) {
  const list = Array.isArray(records) ? records : [];
  const range = rangeValue || 'all';
  const scoped = filterDashboardRecords(list, range, now);
  const stats = computeDashboardStats(scoped);

  // Previous-period comparison. The delta hides (null) rather than lying
  // when there is no previous period or it has no measured spend.
  const prevBounds = getPreviousRangeBounds(range, now);
  let prevTotalSpend = null;
  let deltaPercent = null;
  if (prevBounds) {
    const prevRecords = list.filter((record) => isDateInRange(dashboardRecordDate(record), prevBounds));
    prevTotalSpend = computeDashboardStats(prevRecords).totalSpend;
    if (prevTotalSpend > 0) {
      deltaPercent = Math.round(((stats.totalSpend - prevTotalSpend) / prevTotalSpend) * 100);
    }
  }

  // Contiguous zero-filled chart months: range start → range end, clamped
  // at the current month (a "this year" chart must not show empty future
  // months). All-time spans the measured data's min..max months.
  const pad = (n) => String(n).padStart(2, '0');
  const nowMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const bounds = getRangeBounds(range, now);
  const monthlyByMonth = new Map(stats.monthly.map((entry) => [entry.month, entry]));
  let fromMonth = bounds.from ? bounds.from.slice(0, 7) : (stats.monthly[0]?.month || '');
  let toMonth = bounds.to ? bounds.to.slice(0, 7) : (stats.monthly[stats.monthly.length - 1]?.month || '');
  if (toMonth > nowMonth) toMonth = nowMonth;
  const chartMonths = [];
  if (fromMonth && toMonth && fromMonth <= toMonth) {
    let [y, m] = fromMonth.split('-').map(Number);
    for (;;) {
      const key = `${y}-${pad(m)}`;
      const entry = monthlyByMonth.get(key);
      chartMonths.push({ month: key, total: entry ? entry.total : 0, orders: entry ? entry.orders : 0 });
      if (key === toMonth || chartMonths.length >= 600) break;
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  }

  // Price watch: repurchased items whose unit price moved between the
  // first and latest purchase inside the scope — "your personal inflation",
  // biggest movers first.
  const priceWatch = computePriceHistory(scoped)
    .map((entry) => {
      const firstPrice = entry.points[0].unitPrice;
      const latestPrice = entry.latestPrice;
      const percentChange = firstPrice > 0 ? Math.round(((latestPrice - firstPrice) / firstPrice) * 100) : 0;
      return { name: entry.name, firstPrice, latestPrice, percentChange };
    })
    .filter((entry) => entry.latestPrice !== entry.firstPrice)
    .sort((a, b) => Math.abs(b.percentChange) - Math.abs(a.percentChange) || a.name.localeCompare(b.name))
    .slice(0, 5);

  // Actionable coverage: exactly which stored orders in this range have no
  // measured (schema-current) invoice yet. Same validity rule as
  // computeDashboardStats — pre-v3 invoices count as not measured.
  const missingOrderNumbers = scoped
    .filter((record) => {
      const invoice = record?.invoice || null;
      if (!invoice) return true;
      return Number(invoice.schemaVersion || 0) < CONSTANTS.ORDER_SCHEMA_VERSION;
    })
    .map((record) => String(record?.orderNumber || ''))
    .filter(Boolean);

  const monthsWithData = stats.monthly.filter((entry) => entry.total > 0).length;
  const avgPerMonth = monthsWithData > 0 ? roundMoneyToCents(stats.totalSpend / monthsWithData) : 0;

  return {
    range,
    stats,
    prevTotalSpend,
    deltaPercent,
    avgPerMonth,
    chartMonths,
    priceWatch,
    coverage: {
      stored: scoped.length,
      measured: stats.invoiceCount,
      missingOrderNumbers,
    },
  };
}

/**
 * Currency-aware money formatter (provider work, 2026-07-18).
 *
 * USD keeps the historical "$1,234.56" rendering byte-for-byte — the
 * Walmart.com-only default view must not change. Every other currency
 * formats through Intl with an explicit currency prefix ("CA$1,234.56"
 * for CAD), so mixed-currency surfaces (the combined "All providers"
 * view) stay unambiguous without ever converting anything.
 *
 * @param {number|string} value - number or stored display string ("$42.17")
 * @param {string|null} [currency] - ISO-4217 code; null/omitted → USD
 * @returns {string}
 */
function formatDashboardMoney(value, currency) {
  const amount = Number(typeof value === 'number' ? value : parseNumericValue(value)) || 0;
  const code = String(currency || 'USD').toUpperCase();
  if (code === 'USD') {
    return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch (error) {
    // Unknown/invalid code: label with the code rather than faking a symbol.
    return `${code} ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

/**
 * Combined multi-provider dashboard model — the "All providers" view.
 *
 * Providers can bill in DIFFERENT currencies (Walmart.com USD, Walmart.ca
 * CAD), so spend is NEVER summed across currencies and never converted:
 * each currency gets its own subtotal group carrying a per-provider
 * breakdown. Counts (orders/invoices) are currency-free and do sum.
 * Range scoping applies per provider with the same engine the
 * single-provider dashboard uses (filterDashboardRecords).
 *
 * @param {Array<{id: string, label: string, currency: string, records: Array}>} providerScopes
 *        One entry per enabled provider: its OrderDb records plus identity
 *        from Sidepanel.providers.enabledAdapters().
 * @param {string} rangeValue - dashboard scope ('all'|'last3'|'last6'|'thisYear'|'lastYear')
 * @param {Date} [now] - injectable for deterministic tests
 * @returns {{
 *   range: string,
 *   providers: Array<{id, label, currency, stats: Object}>, // stats = computeDashboardStats over the range-scoped records
 *   currencyTotals: Array<{currency, totalSpend, invoiceCount, orderCount,
 *     providers: Array<{id, label, totalSpend, invoiceCount, orderCount}>}>,
 *   orderCount: number,
 *   invoiceCount: number,
 *   mixedCurrency: boolean
 * }}
 */
function computeProviderDashboard(providerScopes, rangeValue, now = new Date()) {
  const scopes = Array.isArray(providerScopes) ? providerScopes : [];
  const range = rangeValue || 'all';

  const providers = scopes.map((scope) => ({
    id: scope?.id || '',
    label: scope?.label || scope?.id || '',
    currency: scope?.currency || 'USD',
    stats: computeDashboardStats(filterDashboardRecords(scope?.records, range, now)),
  }));

  const groups = new Map();
  providers.forEach((provider) => {
    let group = groups.get(provider.currency);
    if (!group) {
      group = { currency: provider.currency, totalSpend: 0, invoiceCount: 0, orderCount: 0, providers: [] };
      groups.set(provider.currency, group);
    }
    group.totalSpend = roundMoneyToCents(group.totalSpend + provider.stats.totalSpend);
    group.invoiceCount += provider.stats.invoiceCount;
    group.orderCount += provider.stats.orderCount;
    // Providers with nothing measured yet stay visible (0-width bar) so the
    // combined view always accounts for every enabled provider.
    group.providers.push({
      id: provider.id,
      label: provider.label,
      totalSpend: provider.stats.totalSpend,
      invoiceCount: provider.stats.invoiceCount,
      orderCount: provider.stats.orderCount,
    });
  });

  const currencyTotals = [...groups.values()]
    .map((group) => ({
      ...group,
      providers: group.providers
        .slice()
        .sort((a, b) => b.totalSpend - a.totalSpend || a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => b.totalSpend - a.totalSpend || a.currency.localeCompare(b.currency));

  return {
    range,
    providers,
    currencyTotals,
    orderCount: providers.reduce((sum, provider) => sum + provider.stats.orderCount, 0),
    invoiceCount: providers.reduce((sum, provider) => sum + provider.stats.invoiceCount, 0),
    mixedCurrency: currencyTotals.length > 1,
  };
}

/**
 * Track per-item unit-price history across downloaded invoices.
 *
 * Only records with an invoice carry per-item prices, so history grows as
 * more invoices are downloaded. Items are keyed by usItemId when present,
 * else by normalized product name. An item qualifies when it was bought in
 * at least two orders with a computable unit price (line price / quantity,
 * quantity > 0, rounded to cents); stable-priced items are included too,
 * distinguished by the `changed` boolean.
 *
 * @param {Array} records - OrderDb records ({orderDate, summary, invoice, ...})
 * @returns {Array<{
 *   name: string,
 *   usItemId: string,
 *   points: Array<{date: string, unitPrice: number}>,
 *   minPrice: number,
 *   maxPrice: number,
 *   latestPrice: number,
 *   changed: boolean
 * }>}
 */
function computePriceHistory(records) {
  const list = Array.isArray(records) ? records : [];
  const byKey = new Map();

  list.forEach((record) => {
    const invoice = record?.invoice || null;
    if (!invoice || !Array.isArray(invoice.items)) return;
    if (Number(invoice.schemaVersion || 0) < CONSTANTS.ORDER_SCHEMA_VERSION) return;

    // Normalize to a sortable YYYY-MM-DD: DOM-collected orders store human
    // dates ('July 1, 2026'), which would otherwise sort alphabetically.
    const date = dashboardRecordDate(record);

    // One price point per item per order.
    const seenInOrder = new Set();
    invoice.items.forEach((item) => {
      const name = String(item?.productName || '').trim();
      const usItemId = String(item?.usItemId || '').trim();
      const key = usItemId || name.toLowerCase();
      if (!key || seenInOrder.has(key)) return;

      const quantity = parseNumericValue(item?.quantity);
      if (!(quantity > 0)) return;
      const unitPrice = roundMoneyToCents(parseNumericValue(item?.price) / quantity);
      if (!(unitPrice > 0)) return;

      seenInOrder.add(key);
      let entry = byKey.get(key);
      if (!entry) {
        entry = { name, usItemId, points: [] };
        byKey.set(key, entry);
      }
      if (!entry.name && name) entry.name = name;
      entry.points.push({ date, unitPrice });
    });
  });

  return [...byKey.values()]
    .filter((entry) => entry.points.length >= 2)
    .map((entry) => {
      const points = entry.points.slice().sort((a, b) => a.date.localeCompare(b.date));
      const prices = points.map((point) => point.unitPrice);
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      return {
        name: entry.name,
        usItemId: entry.usItemId,
        points,
        minPrice,
        maxPrice,
        latestPrice: points[points.length - 1].unitPrice,
        changed: minPrice !== maxPrice,
      };
    })
    .sort(
      (a, b) =>
        Number(b.changed) - Number(a.changed) ||
        (b.maxPrice - b.minPrice) - (a.maxPrice - a.minPrice) ||
        a.name.localeCompare(b.name)
    );
}

/*
 * Provider-switch render entry point (contract for panel-core).
 *
 * `Sidepanel.dashboard.render()` re-reads the stored active provider
 * (Sidepanel.providers.getActive()) and re-renders every dashboard surface
 * in the current document. The full-page dashboard (dashboard.page.js)
 * registers its renderer as `Sidepanel.dashboard._renderImpl` at load; in
 * documents with no dashboard UI the call is a safe no-op returning
 * undefined. Call it whenever the active provider selection changes.
 */
(() => {
  const root =
    typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis;
  const ns = root.Sidepanel || (root.Sidepanel = {});
  const dashboard = ns.dashboard || (ns.dashboard = {});
  dashboard.render = (options) =>
    typeof dashboard._renderImpl === 'function' ? dashboard._renderImpl(options) : undefined;
})();

