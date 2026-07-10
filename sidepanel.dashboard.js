/**
 * Spend analytics dashboard.
 *
 * Pure aggregation logic lives in plain global functions (testable in the
 * node vm sandbox); rendering lives in the Sidepanel.dashboard IIFE below.
 * Everything is computed on-device from the local order database — the
 * dashboard never talks to walmart.com.
 */

/**
 * Normalize any stored order date (ISO '2026-06-14T…', human 'Jun 14, 2026',
 * or empty) to a sortable 'YYYY-MM-DD' string, else ''.
 */
function normalizeDashboardDate(rawDate) {
  const text = String(rawDate || '');
  if (/^\d{4}-\d{2}/.test(text)) return text.slice(0, 10);
  if (!text) return '';
  const parsed = new Date(text);
  if (isNaN(parsed.getTime())) return '';
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
}

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
 *   monthly: Array<{month: string, total: number}>,
 *   topItems: Array<{name: string, orders: number, quantity: number}>
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

    // Month from any date format we may have stored (ISO or human).
    const normalized = normalizeDashboardDate(
      record?.orderDate || record?.summary?.orderDate || invoice.orderDate || ''
    );
    const month = normalized.slice(0, 7);
    if (month && total) {
      monthlyTotals.set(month, (monthlyTotals.get(month) || 0) + total);
    }

    // Item repurchase counts from invoice items. Count once per order.
    const rawItems = Array.isArray(invoice.items)
      ? invoice.items.map((item) => ({ name: item?.productName, quantity: item?.quantity }))
      : [];

    const seenInOrder = new Set();
    rawItems.forEach(({ name, quantity }) => {
      const cleanName = String(name || '').trim();
      if (!cleanName) return;
      const key = cleanName.toLowerCase();

      let entry = itemsByKey.get(key);
      if (!entry) {
        entry = { name: cleanName, orders: 0, quantity: 0 };
        itemsByKey.set(key, entry);
      }
      const qty = quantity === null || quantity === undefined || quantity === ''
        ? 1
        : parseNumericValue(quantity);
      entry.quantity += qty;
      if (!seenInOrder.has(key)) {
        seenInOrder.add(key);
        entry.orders += 1;
      }
    });
  });

  const monthly = [...monthlyTotals.entries()]
    .map(([month, total]) => ({ month, total: roundMoneyToCents(total) }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const topItems = [...itemsByKey.values()]
    .filter((entry) => entry.orders > 1)
    .sort((a, b) => b.orders - a.orders || b.quantity - a.quantity || a.name.localeCompare(b.name))
    .slice(0, 10);

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
    monthly,
    topItems,
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

  /** Format a numeric money value for display, e.g. 12.5 → "$12.50". */
  function formatMoney(value) {
    return `$${(Number(value) || 0).toFixed(2)}`;
  }

  /** Render one stat card. `note` (optional) is a small muted sub-line. */
  function statCardHtml(label, value, note = '') {
    return `
      <div class="stat-card">
        <div class="stat-value">${escapeHtml(value)}</div>
        <div class="stat-label">${escapeHtml(label)}</div>
        ${note ? `<div class="stat-note">${escapeHtml(note)}</div>` : ''}
      </div>
    `;
  }

  /** Render the monthly-spend section as pure-CSS bar rows. */
  function monthlySectionHtml(monthly) {
    if (!monthly.length) return '';
    const maxTotal = monthly.reduce((max, entry) => Math.max(max, entry.total), 0);
    const rows = monthly
      .map((entry) => {
        const percent = maxTotal > 0 ? Math.max(2, Math.round((entry.total / maxTotal) * 100)) : 0;
        return `
          <div class="bar-row">
            <span class="bar-label">${escapeHtml(entry.month)}</span>
            <div class="bar-track"><div class="bar-fill" style="width: ${percent}%"></div></div>
            <span class="bar-amount">${escapeHtml(formatMoney(entry.total))}</span>
          </div>
        `;
      })
      .join('');
    return `
      <div class="dashboard-section">
        <h3 class="dashboard-section-title">Monthly spend</h3>
        ${rows}
      </div>
    `;
  }

  /** Render the "Most repurchased" section (items bought in more than one order). */
  function topItemsSectionHtml(topItems) {
    const rows = topItems.length
      ? topItems
          .map(
            (item) => `
              <li>
                <span class="dashboard-item-name">${escapeHtml(item.name)}</span>
                <span class="dashboard-muted">${escapeHtml(`${item.orders} orders · ${item.quantity} total`)}</span>
              </li>
            `
          )
          .join('')
      : '<li class="dashboard-muted">No repeat purchases across the measured invoices yet — download more orders to grow this.</li>';
    return `
      <div class="dashboard-section">
        <h3 class="dashboard-section-title">Most repurchased</h3>
        <ul class="dashboard-list">${rows}</ul>
      </div>
    `;
  }

  /** Cap on rendered price-history rows — the full list can get long. */
  const PRICE_HISTORY_MAX_ROWS = 15;

  /** Render the "Price history" section (repurchased items whose unit price moved). */
  function priceHistorySectionHtml(priceHistory) {
    const changedItems = priceHistory
      .filter((entry) => entry.changed)
      .slice(0, PRICE_HISTORY_MAX_ROWS);
    const rows = changedItems.length
      ? changedItems
          .map(
            (entry) => `
              <li>
                <span class="dashboard-item-name">${escapeHtml(entry.name)}</span>
                <span class="dashboard-muted">${escapeHtml(
                  `${formatMoney(entry.minPrice)} → ${formatMoney(entry.maxPrice)} (latest ${formatMoney(entry.latestPrice)})`
                )}</span>
              </li>
            `
          )
          .join('')
      : '<li class="dashboard-muted">No price changes across the measured invoices yet — an item must appear in two downloaded orders.</li>';
    return `
      <div class="dashboard-section">
        <h3 class="dashboard-section-title">Price history</h3>
        <ul class="dashboard-list">${rows}</ul>
        <div class="dashboard-hint">Price history grows as more invoices are downloaded — only downloaded invoices carry per-item prices.</div>
      </div>
    `;
  }

  /**
   * Render the dashboard into #dashboardContent from the local order
   * database. Read-only: never touches running collections or downloads.
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

    if (!records || records.length === 0) {
      container.innerHTML = '<div class="dashboard-empty">Collect orders to see analytics</div>';
      return;
    }

    const stats = computeDashboardStats(records);

    if (stats.invoiceCount === 0) {
      container.innerHTML = `
        <div class="dashboard-empty">
          The dashboard measures fully downloaded invoices only — no half measurements
          from summary data. You have ${stats.orderCount} orders stored; select them and
          run "Download Selected" to add them to the dashboard.
        </div>
      `;
      return;
    }

    const coverage = stats.invoiceCount < stats.orderCount
      ? `<div class="dashboard-coverage">Measuring ${stats.invoiceCount} fully downloaded invoices
          (of ${stats.orderCount} orders stored). Download the rest for complete numbers.</div>`
      : `<div class="dashboard-coverage">Measuring all ${stats.invoiceCount} stored orders (full invoices).</div>`;

    container.innerHTML = `
      ${coverage}
      <div class="stat-grid">
        ${statCardHtml('Invoices measured', String(stats.invoiceCount))}
        ${statCardHtml('Total spend', formatMoney(stats.totalSpend))}
        ${statCardHtml('Avg order', formatMoney(stats.avgOrder))}
        ${statCardHtml('Tips', formatMoney(stats.totalTips))}
        ${statCardHtml('Savings', formatMoney(stats.totalSavings))}
        ${statCardHtml('Tax', formatMoney(stats.totalTax))}
        ${statCardHtml('Refunds', formatMoney(stats.totalRefunds))}
        ${statCardHtml('Donations', formatMoney(stats.totalDonations))}
      </div>
      ${monthlySectionHtml(stats.monthly)}
      ${topItemsSectionHtml(stats.topItems)}
      ${priceHistorySectionHtml(computePriceHistory(records))}
      <div class="dashboard-section">
        <button id="dashboardResetButton" class="btn btn-clear">Reset dashboard data</button>
        <div class="dashboard-hint">Deletes every stored order and invoice from the local database.</div>
      </div>
    `;

    const resetButton = container.querySelector('#dashboardResetButton');
    if (resetButton) {
      resetButton.addEventListener('click', async () => {
        const confirmed = window.confirm(
          'Delete ALL stored orders and invoices from the local database? The dashboard starts over from zero.'
        );
        if (!confirmed) return;
        try {
          await OrderDb.clearAll();
        } catch (error) {
          console.error('Dashboard reset failed:', error);
        }
        renderDashboard();
        if (Sidepanel.view && Sidepanel.view.updateDbStats) {
          Sidepanel.view.updateDbStats();
        }
      });
    }
  }

  Sidepanel.dashboard = {
    renderDashboard,
  };
})();
