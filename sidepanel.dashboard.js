/**
 * Spend analytics dashboard.
 *
 * Pure aggregation logic lives in plain global functions (testable in the
 * node vm sandbox); rendering lives in the Sidepanel.dashboard IIFE below.
 * Everything is computed on-device from the local order database — the
 * dashboard never talks to walmart.com.
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

    const total = parseNumericValue(invoice.orderTotal);
    if (total) {
      totalSpend += total;
      totaledOrders += 1;
    }

    totalTips += parseNumericValue(invoice.tip);
    totalSavings += parseNumericValue(invoice.savings);
    totalTax += parseNumericValue(invoice.tax);
    totalRefunds += parseNumericValue(invoice.refund);
    totalDonations += parseNumericValue(invoice.donations);
    totalSubtotal += parseNumericValue(invoice.orderSubtotal);
    totalFees += parseNumericValue(invoice.deliveryCharges) + parseNumericValue(invoice.bagFee);

    // Month from any date format we may have stored (ISO or human).
    const normalized = normalizeDashboardDate(
      record?.orderDate || record?.summary?.orderDate || invoice.orderDate || ''
    );
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

/** Resolve a record's best stored date (record → summary → invoice) to 'YYYY-MM-DD', else ''. */
function dashboardRecordDate(record) {
  return normalizeDashboardDate(
    record?.orderDate || record?.summary?.orderDate || record?.invoice?.orderDate || ''
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
    const date = normalizeDashboardDate(
      record?.orderDate || record?.summary?.orderDate || invoice.orderDate || ''
    );

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

(() => {
  const Sidepanel = window.Sidepanel || (window.Sidepanel = {});

  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /**
   * In-memory dashboard view state — NOT persisted (fresh panel opens
   * default to "this year", falling back to all-time when this year has
   * nothing measured). `selectedMonth` drives the bar chart's caption.
   */
  const dashState = {
    range: null,
    selectedMonth: null,
  };

  /** The dashboard's scope choices — same range engine as the list filter. */
  const SCOPE_OPTIONS = [
    { value: 'thisYear', label: 'This year' },
    { value: 'lastYear', label: 'Last year' },
    { value: 'last3', label: 'Last 3 months' },
    { value: 'last6', label: 'Last 6 months' },
    { value: 'all', label: 'All time' },
  ];

  /** Format a numeric money value for display, e.g. 12.5 → "$12.50". */
  function formatMoney(value) {
    return `$${(Number(value) || 0).toFixed(2)}`;
  }

  /** Headline money format with thousands grouping, e.g. 1847.2 → "$1,847.20". */
  function formatMoneyGrouped(value) {
    return `$${(Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  /** Short display label for the current scope, e.g. "2026", "Last 3 months", "all time". */
  function scopeLabel(range, now) {
    switch (range) {
      case 'thisYear': return String(now.getFullYear());
      case 'lastYear': return String(now.getFullYear() - 1);
      case 'last3': return 'Last 3 months';
      case 'last6': return 'Last 6 months';
      default: return 'All time';
    }
  }

  /** What the headline delta compares against, e.g. "vs last year". */
  function deltaComparisonLabel(range) {
    switch (range) {
      case 'thisYear': return 'vs last year';
      case 'lastYear': return 'vs the year before';
      case 'last3': return 'vs previous 3 months';
      case 'last6': return 'vs previous 6 months';
      default: return '';
    }
  }

  /** "Jul" / "Jul '25" (year added when the chart spans more than one year). */
  function barLabel(month, spansYears) {
    const name = MONTHS_SHORT[Number(month.slice(5, 7)) - 1] || month;
    return spansYears ? `${name} '${month.slice(2, 4)}` : name;
  }

  /** Inclusive first/last day of a 'YYYY-MM' month for the custom list range. */
  function monthBounds(month) {
    const year = Number(month.slice(0, 4));
    const monthNumber = Number(month.slice(5, 7));
    const lastDay = new Date(year, monthNumber, 0).getDate();
    return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
  }

  /**
   * Leave the dashboard for the main order list with a range (and
   * optionally an exact selection) applied — the tap-through that turns
   * every dashboard stat into a door into the export flow.
   */
  function goToList(filterSpec) {
    Sidepanel.view.applyListFilter(filterSpec);
    Sidepanel.view.switchView('main');
    // Tap-throughs only render when stored orders exist, so the main view
    // must be in its returning (not first-run) state, with the list built
    // from the DB even if it was never rendered this session — that render
    // is also what applies a still-pending exact selection.
    Sidepanel.view.updateMacroState(true);
    if (Sidepanel.actions) {
      Sidepanel.actions.displayOrdersFromDb();
      Sidepanel.actions.checkCurrentTab();
    }
  }

  /** The scope-picker row (label + select). */
  function scopeRowHtml(range) {
    const options = SCOPE_OPTIONS
      .map((option) => `<option value="${option.value}"${option.value === range ? ' selected' : ''}>${option.label}</option>`)
      .join('');
    return `
      <div class="dash-scope-row">
        <label for="dashScopeSelect">Range</label>
        <select id="dashScopeSelect">${options}</select>
      </div>
    `;
  }

  /** The headline card: total spent in scope, delta vs previous period, sub-line. */
  function headlineHtml(model, now) {
    const { stats, deltaPercent, avgPerMonth } = model;
    let deltaHtml = '';
    if (deltaPercent !== null) {
      const up = deltaPercent >= 0;
      deltaHtml = `
        <span class="dash-delta ${up ? 'dash-delta-up' : 'dash-delta-down'}">
          ${up ? '↗' : '↘'} ${Math.abs(deltaPercent)}% ${escapeHtml(deltaComparisonLabel(model.range))}
        </span>
      `;
    }
    const ordersLabel = `${stats.invoiceCount} order${stats.invoiceCount === 1 ? '' : 's'} measured`;
    const avgLabel = avgPerMonth > 0 ? ` · ${formatMoneyGrouped(avgPerMonth)} / month average` : '';
    return `
      <div class="dash-headline">
        <div class="dash-headline-label">Total spent · ${escapeHtml(scopeLabel(model.range, now))}</div>
        <div class="dash-headline-row">
          <span class="dash-headline-total mono">${formatMoneyGrouped(stats.totalSpend)}</span>
          ${deltaHtml}
        </div>
        <div class="dash-headline-sub">${escapeHtml(ordersLabel)}${avgLabel}</div>
      </div>
    `;
  }

  /** The tappable by-month bar chart plus the selected month's caption line. */
  function byMonthSectionHtml(model) {
    const months = model.chartMonths;
    if (!months.length) return '';
    const maxTotal = months.reduce((max, entry) => Math.max(max, entry.total), 0);
    const spansYears = months[0].month.slice(0, 4) !== months[months.length - 1].month.slice(0, 4);
    // Crowded charts (all-time can span years) label only every nth bar —
    // the selected bar always keeps its label.
    const labelEvery = Math.max(1, Math.ceil(months.length / (spansYears ? 6 : 12)));
    const selectedIndex = months.findIndex((entry) => entry.month === dashState.selectedMonth);

    const bars = months
      .map((entry, index) => {
        const percent = maxTotal > 0 ? Math.round((entry.total / maxTotal) * 100) : 0;
        const height = entry.total > 0 ? Math.max(4, percent) : 0;
        const selected = entry.month === dashState.selectedMonth;
        const monthName = MONTHS_SHORT[Number(entry.month.slice(5, 7)) - 1] || entry.month;
        // The selected bar always keeps its label; scheduled labels too
        // close to it yield (they'd overlap on crowded charts).
        const showLabel = selected ||
          (index % labelEvery === 0 && (selectedIndex < 0 || Math.abs(index - selectedIndex) >= labelEvery));
        return `
          <button type="button" class="dash-bar${selected ? ' selected' : ''}" data-month="${entry.month}"
            aria-pressed="${selected}"
            aria-label="${escapeHtml(`${monthName} ${entry.month.slice(0, 4)}: ${formatMoney(entry.total)}, ${entry.orders} order${entry.orders === 1 ? '' : 's'}`)}">
            <span class="dash-bar-track"><span class="dash-bar-fill" style="height: ${height}%"></span></span>
            <span class="dash-bar-label">${showLabel ? escapeHtml(barLabel(entry.month, spansYears)) : ''}</span>
          </button>
        `;
      })
      .join('');

    const selected = months.find((entry) => entry.month === dashState.selectedMonth);
    let caption = '';
    if (selected) {
      const monthName = MONTHS_SHORT[Number(selected.month.slice(5, 7)) - 1] || selected.month;
      const summary = selected.orders > 0
        ? `${monthName} · ${formatMoneyGrouped(selected.total)} · ${selected.orders} order${selected.orders === 1 ? '' : 's'}`
        : `${monthName} · nothing measured`;
      caption = `
        <div class="dash-bar-caption">
          <span>${escapeHtml(summary)}</span>
          <button type="button" class="btn-link" id="dashViewExportMonth" data-month="${selected.month}">View &amp; export</button>
        </div>
      `;
    }

    return `
      <div class="dashboard-section">
        <h3 class="dashboard-section-title">By month — tap a bar to see &amp; export those orders</h3>
        <div class="dash-bars" role="group" aria-label="Monthly spend">${bars}</div>
        ${caption}
      </div>
    `;
  }

  /** The "Where it went" ledger + scoped export button. */
  function ledgerSectionHtml(model, now) {
    const { stats } = model;
    const rows = [
      ['Items', stats.totalSubtotal, ''],
      ['Savings', -stats.totalSavings, 'negative'],
      ['Tax', stats.totalTax, ''],
      ['Tips', stats.totalTips, ''],
      ['Fees', stats.totalFees, ''],
      ['Donations', stats.totalDonations, ''],
      ['Refunds', -stats.totalRefunds, 'negative'],
    ]
      .filter(([, value]) => Math.abs(value) >= 0.005)
      .map(([label, value, cls]) => {
        const display = value < 0 ? `−${formatMoneyGrouped(Math.abs(value))}` : formatMoneyGrouped(value);
        return `<div class="dash-ledger-row${cls ? ` dash-ledger-${cls}` : ''}"><span>${escapeHtml(label)}</span><span class="mono">${escapeHtml(display)}</span></div>`;
      })
      .join('');
    if (!rows) return '';

    const label = scopeLabel(model.range, now);
    const buttonText = model.range === 'all' ? 'Export all orders' : `Export ${label} orders`;
    return `
      <div class="dashboard-section">
        <h3 class="dashboard-section-title">Where it went · ${escapeHtml(label)}</h3>
        <div class="dash-ledger">${rows}</div>
        <button type="button" class="btn btn-clear dash-export-btn" id="dashExportScope">${renderIcon('DOWNLOAD')}<span class="btn-text">${escapeHtml(buttonText)}</span></button>
      </div>
    `;
  }

  /** Price watch: repurchased items whose unit price moved inside the scope. */
  function priceWatchSectionHtml(model) {
    const rows = model.priceWatch.length
      ? model.priceWatch
          .map((entry) => {
            const up = entry.percentChange >= 0;
            return `
              <li>
                <span class="dashboard-item-name">${escapeHtml(entry.name)}</span>
                <span class="dash-watch-price mono">${escapeHtml(formatMoney(entry.latestPrice))}</span>
                <span class="dash-watch-delta ${up ? 'dash-watch-up' : 'dash-watch-down'}">${up ? '↑' : '↓'} ${Math.abs(entry.percentChange)}%</span>
              </li>
            `;
          })
          .join('')
      : '<li class="dashboard-muted">No repurchased item has moved in price in this range yet.</li>';
    return `
      <div class="dashboard-section">
        <h3 class="dashboard-section-title">Price watch — repurchased items that moved</h3>
        <ul class="dashboard-list dash-watch">${rows}</ul>
        <div class="dashboard-hint">vs. your first purchase in this range — your personal inflation, not a headline number.</div>
      </div>
    `;
  }

  /** Cap on rendered most-bought rows. */
  const MOST_BOUGHT_MAX_ROWS = 5;

  /** Most bought: repurchase count AND total spent (frequency and weight). */
  function mostBoughtSectionHtml(model, now) {
    const items = model.stats.topItems.slice(0, MOST_BOUGHT_MAX_ROWS);
    const rows = items.length
      ? items
          .map(
            (item) => `
              <li>
                <span class="dashboard-item-name">${escapeHtml(item.name)}</span>
                <span class="dashboard-muted">${escapeHtml(`×${item.quantity}`)}</span>
                <span class="dash-watch-price mono">${escapeHtml(formatMoneyGrouped(item.spend))}</span>
              </li>
            `
          )
          .join('')
      : '<li class="dashboard-muted">No repeat purchases in this range yet — download more orders to grow this.</li>';
    return `
      <div class="dashboard-section">
        <h3 class="dashboard-section-title">Most bought · ${escapeHtml(scopeLabel(model.range, now))}</h3>
        <ul class="dashboard-list dash-most-bought">${rows}</ul>
      </div>
    `;
  }

  /** Actionable coverage: which stored orders in range aren't measured yet. */
  function coverageSectionHtml(model) {
    const { stored, measured, missingOrderNumbers } = model.coverage;
    if (missingOrderNumbers.length > 0) {
      const n = missingOrderNumbers.length;
      return `
        <div class="dash-coverage-warn">
          <p>${n} of ${stored} orders in this range ${n === 1 ? "isn't" : "aren't"} measured yet — their totals are missing from these numbers.</p>
          <button type="button" class="btn dash-coverage-btn" id="dashSelectMissing">${renderIcon('DOWNLOAD')}<span class="btn-text">Select &amp; download the missing ${n}</span></button>
        </div>
      `;
    }
    if (stored === 0) return '';
    return `<div class="dashboard-coverage">All ${measured} order${measured === 1 ? '' : 's'} in this range ${measured === 1 ? 'is' : 'are'} measured (full invoices).</div>`;
  }

  /** Wire every interactive element rendered by renderDashboard. */
  function wireDashboardEvents(container, model) {
    const scopeSelect = container.querySelector('#dashScopeSelect');
    if (scopeSelect) {
      scopeSelect.addEventListener('change', () => {
        dashState.range = scopeSelect.value;
        dashState.selectedMonth = null;
        renderDashboard();
      });
    }

    container.querySelectorAll('.dash-bar').forEach((bar) => {
      bar.addEventListener('click', () => {
        dashState.selectedMonth = bar.dataset.month;
        renderDashboard();
      });
    });

    const viewExportMonth = container.querySelector('#dashViewExportMonth');
    if (viewExportMonth) {
      viewExportMonth.addEventListener('click', () => {
        const bounds = monthBounds(viewExportMonth.dataset.month);
        goToList({ filter: 'custom', customFrom: bounds.from, customTo: bounds.to });
      });
    }

    const exportScope = container.querySelector('#dashExportScope');
    if (exportScope) {
      exportScope.addEventListener('click', () => {
        goToList({ filter: model.range });
      });
    }

    const selectMissing = container.querySelector('#dashSelectMissing');
    if (selectMissing) {
      selectMissing.addEventListener('click', () => {
        goToList({ filter: model.range, selectOrders: model.coverage.missingOrderNumbers });
      });
    }
  }

  /**
   * Render the dashboard into #dashboardContent from the local order
   * database. Read-only against the data: never touches running
   * collections or downloads; its tap-throughs only pre-set the order
   * list's filter/selection.
   */
  async function renderDashboard() {
    const container = document.getElementById('dashboardContent');
    if (!container) return;

    let records = [];
    try {
      records = await OrderDb.getAllOrders();
    } catch (error) {
      console.warn('Dashboard: order database unavailable:', error);
    }

    const emptyStateHtml = (heading, body) => `
      <div class="dashboard-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
        </svg>
        <h3>${heading}</h3>
        <p>${body}</p>
      </div>
    `;

    if (!records || records.length === 0) {
      container.innerHTML = emptyStateHtml(
        'No spending data yet',
        'Collect your orders, then download them once — the dashboard builds itself from your full invoices.'
      );
      return;
    }

    const now = new Date();

    // Default scope: this year, unless this year has nothing measured.
    if (!dashState.range) {
      const thisYearModel = computeDashboardModel(records, 'thisYear', now);
      dashState.range = thisYearModel.stats.invoiceCount > 0 ? 'thisYear' : 'all';
    }

    const model = computeDashboardModel(records, dashState.range, now);

    // Nothing measured ANYWHERE — the original "almost there" empty state.
    const allStats = computeDashboardStats(records);
    if (allStats.invoiceCount === 0) {
      container.innerHTML = emptyStateHtml(
        'Almost there',
        `You have ${allStats.orderCount} orders stored. Select them and download once
         ("Single file" or "Multiple files") — the dashboard measures fully downloaded
         invoices only, so its numbers are never half-right.`
      );
      return;
    }

    // Default selected month: the latest month with measured orders.
    const validMonths = model.chartMonths.map((entry) => entry.month);
    if (!dashState.selectedMonth || !validMonths.includes(dashState.selectedMonth)) {
      const withData = model.chartMonths.filter((entry) => entry.orders > 0);
      dashState.selectedMonth = withData.length
        ? withData[withData.length - 1].month
        : (validMonths[validMonths.length - 1] || null);
    }

    if (model.stats.invoiceCount === 0) {
      // Orders may exist in this range but none are measured — keep the
      // scope picker usable and make the coverage banner do the fixing.
      container.innerHTML = `
        ${scopeRowHtml(model.range)}
        <div class="dashboard-empty">
          <h3>Nothing measured in ${escapeHtml(scopeLabel(model.range, now))}</h3>
          <p>${model.coverage.stored > 0
            ? 'Orders in this range are stored but not downloaded yet, so there are no measured numbers to show.'
            : 'No stored orders fall in this range.'}</p>
        </div>
        ${coverageSectionHtml(model)}
      `;
      wireDashboardEvents(container, model);
      return;
    }

    container.innerHTML = `
      ${scopeRowHtml(model.range)}
      ${headlineHtml(model, now)}
      ${byMonthSectionHtml(model)}
      ${ledgerSectionHtml(model, now)}
      ${priceWatchSectionHtml(model)}
      ${mostBoughtSectionHtml(model, now)}
      ${coverageSectionHtml(model)}
    `;
    wireDashboardEvents(container, model);
    // Data deletion is a single control in Settings' "Data on this device"
    // section (spec §4.4) — "Delete all saved data" (sidepanel.settings.js).
  }

  Sidepanel.dashboard = {
    renderDashboard,
  };
})();
