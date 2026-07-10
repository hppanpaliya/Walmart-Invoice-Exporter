/**
 * Spend analytics dashboard.
 *
 * Pure aggregation logic lives in plain global functions (testable in the
 * node vm sandbox); rendering lives in the Sidepanel.dashboard IIFE below.
 * Everything is computed on-device from the local order database — the
 * dashboard never talks to walmart.com.
 */

/** Round a money value to cents (floating-point sums drift otherwise). */
function roundMoneyToCents(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/**
 * Aggregate spend statistics from order-database records.
 *
 * Money fields prefer the deep-export invoice values and fall back to the
 * purchase-history summary (e.g. total = invoice orderTotal, else summary
 * orderTotal). Savings / tax / refunds / donations only exist on invoices,
 * so those totals cover downloaded invoices only.
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
    const invoice = record?.invoice || null;
    const summary = record?.summary || null;
    if (invoice) invoiceCount += 1;

    // Prefer invoice values; fall back to the list-payload summary.
    const total = parseNumericValue(invoice?.orderTotal) || parseNumericValue(summary?.orderTotal);
    if (total) {
      totalSpend += total;
      totaledOrders += 1;
    }

    totalTips += parseNumericValue(invoice?.tip) || parseNumericValue(summary?.driverTip);
    totalSavings += parseNumericValue(invoice?.savings);
    totalTax += parseNumericValue(invoice?.tax);
    totalRefunds += parseNumericValue(invoice?.refund);
    totalDonations += parseNumericValue(invoice?.donations);

    // Month comes from the ISO orderDate prefix (YYYY-MM).
    const isoDate = String(record?.orderDate || summary?.orderDate || '');
    const month = /^\d{4}-\d{2}/.test(isoDate) ? isoDate.slice(0, 7) : '';
    if (month && total) {
      monthlyTotals.set(month, (monthlyTotals.get(month) || 0) + total);
    }

    // Item repurchase counts: invoice items carry productName, summary items
    // carry name. Count each item at most once per order.
    const rawItems = Array.isArray(invoice?.items)
      ? invoice.items.map((item) => ({ name: item?.productName, quantity: item?.quantity }))
      : Array.isArray(summary?.items)
        ? summary.items.map((item) => ({ name: item?.name, quantity: item?.quantity }))
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
      : '<li class="dashboard-muted">No repeat purchases yet.</li>';
    return `
      <div class="dashboard-section">
        <h3 class="dashboard-section-title">Most repurchased</h3>
        <ul class="dashboard-list">${rows}</ul>
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
    const invoiceNote = stats.invoiceCount < stats.orderCount
      ? `from ${stats.invoiceCount} downloaded invoices`
      : '';

    container.innerHTML = `
      <div class="stat-grid">
        ${statCardHtml('Orders', String(stats.orderCount))}
        ${statCardHtml('Total spend', formatMoney(stats.totalSpend))}
        ${statCardHtml('Avg order', formatMoney(stats.avgOrder))}
        ${statCardHtml('Tips', formatMoney(stats.totalTips))}
        ${statCardHtml('Savings', formatMoney(stats.totalSavings), invoiceNote)}
        ${statCardHtml('Tax', formatMoney(stats.totalTax), invoiceNote)}
        ${statCardHtml('Refunds', formatMoney(stats.totalRefunds), invoiceNote)}
        ${statCardHtml('Donations', formatMoney(stats.totalDonations), invoiceNote)}
      </div>
      ${monthlySectionHtml(stats.monthly)}
      ${topItemsSectionHtml(stats.topItems)}
    `;
  }

  Sidepanel.dashboard = {
    renderDashboard,
  };
})();
