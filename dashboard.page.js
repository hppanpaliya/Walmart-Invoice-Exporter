/**
 * Full-page spending dashboard (dashboard.html).
 *
 * Renders real data from the local order database (OrderDb, IndexedDB) using
 * the shared pure aggregation functions in sidepanel.dashboard.js
 * (computeDashboardModel/computeDashboardStats/…) and the shared row-model
 * helpers in utils.js. The right-hand rail embeds the real side panel
 * (sidepanel.html) in an iframe; this page drives it exclusively through
 * postMessage bridge messages ({source:'wie-dashboard', type, …}).
 *
 * Everything is computed on-device. No fetch(), no telemetry — the page
 * never talks to anything beyond IndexedDB, chrome.storage, and its own
 * embedded panel frame.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /**
   * In-memory page state. Never persisted — a fresh open defaults to "this
   * year" (falling back to all-time when this year has nothing measured),
   * no month selected, empty search, date-descending sort.
   */
  const state = {
    records: [],
    signature: null,
    range: null,
    selectedMonth: null, // 'YYYY-MM' or null
    search: '',
    sortBy: 'date', // 'date' | 'total'
    sortDir: 'desc', // 'asc' | 'desc'
    selected: new Set(), // order numbers
    shownRows: [], // last-rendered table row models (post filter+sort)
  };

  /* ------------------------------------------------------------------ *
   * Formatting helpers
   * ------------------------------------------------------------------ */

  /**
   * Defensive money formatter: accepts numbers or stored strings like
   * "$42.17" and renders "$X,XXX.XX" with thousands grouping.
   * @param {number|string} value
   * @returns {string}
   */
  function formatMoney(value) {
    const amount = typeof value === 'number' ? value : parseNumericValue(value);
    return `$${(Number(amount) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  /** Short display label for a range value, e.g. "2026", "Last 3 months". */
  function rangeLabel(range, now) {
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

  /** "Jul 2026" for a 'YYYY-MM' month key. */
  function monthLabel(month) {
    const name = MONTHS_SHORT[Number(month.slice(5, 7)) - 1] || month;
    return `${name} ${month.slice(0, 4)}`;
  }

  /** Bar x-axis label: "Jul", or "Jul '25" when the chart spans years. */
  function barLabel(month, spansYears) {
    const name = MONTHS_SHORT[Number(month.slice(5, 7)) - 1] || month;
    return spansYears ? `${name} '${month.slice(2, 4)}` : name;
  }

  /** The label for whatever is currently scoped (month beats range). */
  function scopeEchoLabel(now) {
    return state.selectedMonth ? monthLabel(state.selectedMonth) : rangeLabel(state.range, now);
  }

  /* ------------------------------------------------------------------ *
   * Bridge to the embedded side panel
   * ------------------------------------------------------------------ */

  const frame = $('panelFrame');
  let frameReady = false;
  /** Messages queued until the iframe has loaded. */
  const pendingMessages = [];

  frame.addEventListener('load', () => {
    frameReady = true;
    while (pendingMessages.length) {
      frame.contentWindow.postMessage(pendingMessages.shift(), location.origin);
    }
  });

  /**
   * Send one bridge message to the embedded panel (agreed contract:
   * {source:'wie-dashboard', type, …payload}), queueing until iframe load.
   * @param {string} type
   * @param {Object} [payload]
   */
  function sendToPanel(type, payload = {}) {
    const message = { source: 'wie-dashboard', type, ...payload };
    if (frameReady && frame.contentWindow) {
      frame.contentWindow.postMessage(message, location.origin);
    } else {
      pendingMessages.push(message);
    }
  }

  /** Scroll the panel rail into view (so collection/export progress is visible). */
  function revealRail() {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('rail').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }

  /* ------------------------------------------------------------------ *
   * Theme — same storage key + data-theme mechanism as the panel
   * ------------------------------------------------------------------ */

  /** Stamp/remove data-theme on <html>; "system" defers to prefers-color-scheme. */
  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'dark' || theme === 'light') {
      root.setAttribute('data-theme', theme);
    } else {
      root.removeAttribute('data-theme');
    }
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['theme'], (result) => {
      applyTheme(result && result.theme);
    });
  }

  /* ------------------------------------------------------------------ *
   * Data scoping
   * ------------------------------------------------------------------ */

  /** Records inside the current range (month selection NOT applied). */
  function recordsInRange(now) {
    return filterDashboardRecords(state.records, state.range, now);
  }

  /** Records inside the current scope: the selected month if any, else the range. */
  function recordsInScope(now) {
    const ranged = recordsInRange(now);
    if (!state.selectedMonth) return ranged;
    const prefix = state.selectedMonth;
    return ranged.filter((record) => dashboardRecordDate(record).startsWith(prefix));
  }

  /**
   * Price-watch movers for a set of records — same shaping as
   * computeDashboardModel's priceWatch (biggest movers first, top 5).
   * @param {Array} records
   * @returns {Array<{name: string, latestPrice: number, percentChange: number}>}
   */
  function buildPriceWatch(records) {
    return computePriceHistory(records)
      .map((entry) => {
        const firstPrice = entry.points[0].unitPrice;
        const latestPrice = entry.latestPrice;
        const percentChange = firstPrice > 0 ? Math.round(((latestPrice - firstPrice) / firstPrice) * 100) : 0;
        return { name: entry.name, firstPrice, latestPrice, percentChange };
      })
      .filter((entry) => entry.latestPrice !== entry.firstPrice)
      .sort((a, b) => Math.abs(b.percentChange) - Math.abs(a.percentChange) || a.name.localeCompare(b.name))
      .slice(0, 5);
  }

  /** Order numbers in `records` without a measured (schema-current) invoice. */
  function missingOrderNumbersOf(records) {
    return records
      .filter((record) => {
        const invoice = record && record.invoice;
        if (!invoice) return true;
        return Number(invoice.schemaVersion || 0) < CONSTANTS.ORDER_SCHEMA_VERSION;
      })
      .map((record) => String((record && record.orderNumber) || ''))
      .filter(Boolean);
  }

  /* ------------------------------------------------------------------ *
   * Orders table
   * ------------------------------------------------------------------ */

  /** Row models for the current scope. */
  function buildRows(now) {
    return recordsInScope(now).map((record) =>
      buildOrderRowModel(String(record.orderNumber || ''), record, '')
    );
  }

  /** All searchable item names for a row (summary items, else invoice items). */
  function rowItemNames(row) {
    if (row.summaryItems && row.summaryItems.length) {
      return row.summaryItems.map((item) => String(item.name || '')).filter(Boolean);
    }
    if (row.invoice && Array.isArray(row.invoice.items)) {
      return row.invoice.items.map((item) => String((item && item.productName) || '')).filter(Boolean);
    }
    return [];
  }

  /** Case-insensitive match across item names and the order-number substring. */
  function matchesSearch(row, query) {
    if (!query) return true;
    if (String(row.orderNumber || '').toLowerCase().includes(query)) return true;
    return rowItemNames(row).some((name) => name.toLowerCase().includes(query));
  }

  /** Sort rows in place by the current sort column/direction. */
  function sortRows(rows) {
    const dir = state.sortDir === 'asc' ? 1 : -1;
    if (state.sortBy === 'total') {
      rows.sort((a, b) => (parseNumericValue(a.total) - parseNumericValue(b.total)) * dir);
      return rows;
    }
    // Date sort: undated rows always last, regardless of direction.
    rows.sort((a, b) => {
      if (!a.normalizedDate && !b.normalizedDate) return 0;
      if (!a.normalizedDate) return 1;
      if (!b.normalizedDate) return -1;
      return a.normalizedDate.localeCompare(b.normalizedDate) * dir;
    });
    return rows;
  }

  /** "Jul 12", plus a year mark ("Jul 12 '25") outside the current year. */
  function rowDateLabel(row, now) {
    const short = formatRowDateShort(row.normalizedDate);
    if (!short) return '—';
    const year = row.normalizedDate.slice(0, 4);
    return year === String(now.getFullYear()) ? short : `${short} '${year.slice(2)}`;
  }

  /** "14 items — Milk, Bananas, Eggs…" from the best available item data. */
  function rowItemsLabel(row) {
    const names = rowItemNames(row);
    const count = row.itemCount !== '' && row.itemCount !== null && row.itemCount !== undefined
      ? Number(row.itemCount)
      : names.length;
    if (!count && !names.length) return '—';
    const countLabel = `${count || names.length} item${(count || names.length) === 1 ? '' : 's'}`;
    return names.length ? `${countLabel} — ${names.slice(0, 6).join(', ')}` : countLabel;
  }

  /** One <tr> of the orders table. Every data-derived string is escaped. */
  function rowHtml(row, now) {
    const orderNumber = String(row.orderNumber || '');
    const last8 = orderNumber.replace(/[^0-9]/g, '').slice(-8) || orderNumber;
    const checked = state.selected.has(orderNumber) ? ' checked' : '';
    const total = row.total === '' || row.total === null || row.total === undefined
      ? '—'
      : formatMoney(row.total);
    const dataChip = row.hasInvoice
      ? '<span class="saved-chip">✓ full invoice</span>'
      : '<span class="pending-chip">summary only</span>';
    return `<tr>
      <td><input type="checkbox" data-order="${escapeHtml(orderNumber)}" aria-label="Select order ending ${escapeHtml(last8)}"${checked}></td>
      <td class="date-cell">${escapeHtml(rowDateLabel(row, now))}</td>
      <td>${row.status ? `<span class="status-chip">${escapeHtml(row.status)}</span>` : ''}</td>
      <td class="items-cell">${escapeHtml(rowItemsLabel(row))}</td>
      <td class="onum mono">…${escapeHtml(orderNumber.slice(-8))}</td>
      <td class="num mono">${escapeHtml(total)}</td>
      <td>${dataChip}</td>
    </tr>`;
  }

  /** Re-render the table body from the current scope, search, and sort. */
  function renderTable(now) {
    const query = state.search.trim().toLowerCase();
    const rows = sortRows(buildRows(now).filter((row) => matchesSearch(row, query)));
    state.shownRows = rows;

    const tbody = $('orderRows');
    tbody.innerHTML = rows.length
      ? rows.map((row) => rowHtml(row, now)).join('')
      : `<tr class="table-empty"><td colspan="7">${query ? 'No orders match your search.' : 'No orders in this scope.'}</td></tr>`;

    $('tableCount').textContent = `${rows.length} shown`;
    updateSortHeaders();
    updateSelectionUi();
  }

  /** Reflect sort state in the header arrows + aria-sort. */
  function updateSortHeaders() {
    const arrow = state.sortDir === 'desc' ? '▾' : '▴';
    $('sortDateArrow').textContent = state.sortBy === 'date' ? arrow : '';
    $('sortTotalArrow').textContent = state.sortBy === 'total' ? arrow : '';
    const sortValue = state.sortDir === 'desc' ? 'descending' : 'ascending';
    $('sortDateBtn').closest('th').setAttribute('aria-sort', state.sortBy === 'date' ? sortValue : 'none');
    $('sortTotalBtn').closest('th').setAttribute('aria-sort', state.sortBy === 'total' ? sortValue : 'none');
  }

  /** Order numbers that are both selected and currently shown. */
  function selectedShownOrderNumbers() {
    return state.shownRows
      .map((row) => String(row.orderNumber || ''))
      .filter((orderNumber) => state.selected.has(orderNumber));
  }

  /** Update the "N selected · of M shown" bar and the export buttons. */
  function updateSelectionUi() {
    const count = selectedShownOrderNumbers().length;
    $('selCount').textContent = `${count} selected`;
    $('exportSingleBtn').disabled = count === 0;
    $('exportMultipleBtn').disabled = count === 0;
  }

  /* ------------------------------------------------------------------ *
   * Sections above the table
   * ------------------------------------------------------------------ */

  /** Fill the stat strip + headline from the scoped stats. */
  function renderStats(model, scopedStats, now) {
    const monthScoped = Boolean(state.selectedMonth);
    const stats = scopedStats;

    $('statTotal').textContent = formatMoney(stats.totalSpend);

    const deltaEl = $('statDelta');
    if (!monthScoped && model.deltaPercent !== null) {
      const up = model.deltaPercent >= 0;
      deltaEl.textContent = `${up ? '↑' : '↓'} ${Math.abs(model.deltaPercent)}% ${deltaComparisonLabel(state.range)}`;
      deltaEl.classList.toggle('delta-down', !up);
      deltaEl.hidden = false;
    } else {
      deltaEl.textContent = '';
      deltaEl.hidden = true;
    }

    // "Jan – Jul 2026, from 61 downloaded invoices" / "Jul 2026, from 8 …"
    let span = '';
    if (monthScoped) {
      span = monthLabel(state.selectedMonth);
    } else if (model.chartMonths.length) {
      const first = model.chartMonths[0].month;
      const last = model.chartMonths[model.chartMonths.length - 1].month;
      span = first === last ? monthLabel(first) : `${monthLabel(first)} – ${monthLabel(last)}`;
    }
    const invoicesLabel = `${stats.invoiceCount} downloaded invoice${stats.invoiceCount === 1 ? '' : 's'}`;
    $('statTotalNote').textContent = span ? `${span}, from ${invoicesLabel}` : `From ${invoicesLabel}`;

    $('statOrders').textContent = String(stats.invoiceCount);

    if (monthScoped) {
      $('statAvgMonth').textContent = formatMoney(stats.totalSpend);
      $('statAvgMonthNote').textContent = 'this month';
    } else {
      $('statAvgMonth').textContent = formatMoney(model.avgPerMonth);
      const monthsWithData = model.stats.monthly.filter((entry) => entry.total > 0).length;
      $('statAvgMonthNote').textContent = `${monthsWithData} month${monthsWithData === 1 ? '' : 's'}`;
    }

    $('statAvgOrder').textContent = formatMoney(stats.avgOrder);
    $('statSaved').textContent = formatMoney(stats.totalSavings);
  }

  /** Render the by-month bar chart for the current RANGE (months stay visible while month-scoped). */
  function renderChart(model) {
    const months = model.chartMonths;
    const chart = $('chart');
    $('chartCard').hidden = months.length === 0;
    if (!months.length) {
      chart.innerHTML = '';
      return;
    }

    const maxTotal = months.reduce((max, entry) => Math.max(max, entry.total), 0);
    const spansYears = months[0].month.slice(0, 4) !== months[months.length - 1].month.slice(0, 4);
    // Crowded charts (all-time can span years) label only every nth bar;
    // the selected bar always keeps its label.
    const labelEvery = Math.max(1, Math.ceil(months.length / (spansYears ? 8 : 12)));
    const selectedIndex = months.findIndex((entry) => entry.month === state.selectedMonth);

    chart.setAttribute(
      'aria-label',
      `Monthly spend, ${monthLabel(months[0].month)} to ${monthLabel(months[months.length - 1].month)}`
    );

    chart.innerHTML = months
      .map((entry, index) => {
        const percent = maxTotal > 0 ? Math.round((entry.total / maxTotal) * 100) : 0;
        const height = entry.total > 0 ? Math.max(4, percent) : 0;
        const selected = entry.month === state.selectedMonth;
        const showLabel = selected ||
          (index % labelEvery === 0 && (selectedIndex < 0 || Math.abs(index - selectedIndex) >= labelEvery));
        const aria = `${monthLabel(entry.month)}: ${formatMoney(entry.total)}, ${entry.orders} order${entry.orders === 1 ? '' : 's'}`;
        return `<button type="button" class="cbar${selected ? ' selected' : ''}" data-month="${entry.month}"
            aria-pressed="${selected}" aria-label="${escapeHtml(aria)}">
          <span class="cbar-value">${escapeHtml(formatMoney(entry.total))}</span>
          <span class="cbar-fill" style="height:${height}%"></span>
          <span class="cbar-month">${showLabel ? escapeHtml(barLabel(entry.month, spansYears)) : ''}</span>
        </button>`;
      })
      .join('');

    chart.querySelectorAll('.cbar').forEach((bar) => {
      bar.addEventListener('click', () => {
        const month = bar.dataset.month;
        // Clicking the selected bar again deselects (back to the range).
        state.selectedMonth = state.selectedMonth === month ? null : month;
        renderAll();
      });
    });
  }

  /** The "Where it went" ledger + scoped export button label. */
  function renderLedger(scopedStats, now) {
    const rows = [
      ['Items', scopedStats.totalSubtotal, ''],
      ['Savings', -scopedStats.totalSavings, 'neg'],
      ['Tax', scopedStats.totalTax, ''],
      ['Tips', scopedStats.totalTips, ''],
      ['Fees', scopedStats.totalFees, ''],
      ['Donations', scopedStats.totalDonations, ''],
      ['Refunds', -scopedStats.totalRefunds, 'neg'],
    ]
      .filter(([, value]) => Math.abs(value) >= 0.005)
      .map(([label, value, cls]) => {
        const display = value < 0 ? `−${formatMoney(Math.abs(value))}` : formatMoney(value);
        return `<div class="lrow"><span>${escapeHtml(label)}</span><span class="mono${cls ? ` ${cls}` : ''}">${escapeHtml(display)}</span></div>`;
      });
    rows.push(
      `<div class="lrow lrow-total"><span>Total</span><span class="mono">${escapeHtml(formatMoney(scopedStats.totalSpend))}</span></div>`
    );
    $('ledger').innerHTML = rows.join('');

    const label = scopeEchoLabel(now);
    $('exportScopeLabel').textContent =
      !state.selectedMonth && state.range === 'all' ? 'Export all orders' : `Export ${label} orders`;
  }

  /** Price watch list for the current scope. */
  function renderPriceWatch(scopedRecords) {
    const movers = buildPriceWatch(scopedRecords);
    $('priceWatchList').innerHTML = movers.length
      ? movers
          .map((entry) => {
            const up = entry.percentChange >= 0;
            return `<li>
              <span class="pname">${escapeHtml(entry.name)}</span>
              <span class="mono">${escapeHtml(formatMoney(entry.latestPrice))}</span>
              <span class="${up ? 'up' : 'down'}">${up ? '↑' : '↓'} ${Math.abs(entry.percentChange)}%</span>
            </li>`;
          })
          .join('')
      : '<li class="muted">No repurchased item has moved in price in this range yet.</li>';
  }

  /** Most-bought list for the current scope. */
  function renderMostBought(scopedStats) {
    const items = scopedStats.topItems.slice(0, 5);
    $('mostBoughtList').innerHTML = items.length
      ? items
          .map(
            (item) => `<li>
              <span class="pname">${escapeHtml(item.name)}</span>
              <span class="pmeta">×${escapeHtml(String(item.quantity))}</span>
              <span class="mono">${escapeHtml(formatMoney(item.spend))}</span>
            </li>`
          )
          .join('')
      : '<li class="muted">No repeat purchases in this range yet — download more orders to grow this.</li>';
  }

  /** Coverage banner (missing invoices in scope) or the quiet all-measured line. */
  function renderCoverage(scopedRecords, scopedStats) {
    const region = $('coverageRegion');
    const missing = missingOrderNumbersOf(scopedRecords);
    if (missing.length > 0) {
      const n = missing.length;
      region.innerHTML = `<section class="coverage">
        <p><strong>${n} of ${scopedRecords.length} orders in this range ${n === 1 ? "isn't" : "aren't"} measured yet</strong>
          — download them once and every number above gets more accurate.</p>
        <button class="btn" id="selectMissingBtn" type="button">Select the missing ${n} below</button>
      </section>`;
      $('selectMissingBtn').addEventListener('click', () => {
        // Clear the search so every missing row is actually visible, then
        // check exactly those rows and bring the table into view.
        state.search = '';
        $('searchInput').value = '';
        state.selected = new Set(missing);
        renderTable(new Date());
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        $('ordersCard').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      });
    } else if (scopedRecords.length > 0) {
      const measured = scopedStats.invoiceCount;
      region.innerHTML = `<div class="coverage-ok">All ${measured} order${measured === 1 ? '' : 's'} in this range ${measured === 1 ? 'is' : 'are'} measured (full invoices).</div>`;
    } else {
      region.innerHTML = '';
    }
  }

  /* ------------------------------------------------------------------ *
   * Top-level render
   * ------------------------------------------------------------------ */

  /** Show/hide the main sections for the three page modes. */
  function setSectionVisibility({ empty, stats, chart, insights, coverage, orders }) {
    $('emptyRegion').hidden = !empty;
    $('statsSection').hidden = !stats;
    $('chartCard').hidden = !chart;
    $('insightsSection').hidden = !insights;
    $('coverageRegion').hidden = !coverage;
    $('ordersCard').hidden = !orders;
    $('scopeSelect').hidden = empty && !orders;
  }

  /** Render the whole page from state.records. */
  function renderAll() {
    const now = new Date();
    const records = state.records;

    document.body.classList.toggle('month-scoped', Boolean(state.selectedMonth));

    // Mode (a): nothing stored at all.
    if (!records.length) {
      setSectionVisibility({ empty: true, stats: false, chart: false, insights: false, coverage: false, orders: false });
      $('scopeTitle').textContent = 'Your spending';
      $('emptyRegion').innerHTML = `
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
        </svg>
        <h3>No spending data yet</h3>
        <p>Use the panel on the right to load your orders, then download them once —
           the dashboard builds itself from your full invoices.</p>`;
      return;
    }

    // Default scope: this year, unless this year has nothing measured
    // (same fallback the panel dashboard used).
    if (!state.range) {
      const thisYearModel = computeDashboardModel(records, 'thisYear', now);
      state.range = thisYearModel.stats.invoiceCount > 0 ? 'thisYear' : 'all';
      $('scopeSelect').value = state.range;
    }

    // Mode (b): orders stored but nothing measured anywhere — keep the
    // table (summary rows are selectable/exportable) and the rail.
    const allStats = computeDashboardStats(records);
    if (allStats.invoiceCount === 0) {
      setSectionVisibility({ empty: true, stats: false, chart: false, insights: false, coverage: false, orders: true });
      $('scopeTitle').textContent = `Your spending · ${rangeLabel(state.range, now)}`;
      $('emptyRegion').innerHTML = `
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
        </svg>
        <h3>Almost there</h3>
        <p>You have ${allStats.orderCount} order${allStats.orderCount === 1 ? '' : 's'} stored. Use the panel on the right to load your orders,
           then download them once — the dashboard builds itself from your full invoices.</p>`;
      document.querySelectorAll('.scope-echo').forEach((el) => { el.textContent = rangeLabel(state.range, now); });
      renderTable(now);
      return;
    }

    // Normal mode.
    setSectionVisibility({ empty: false, stats: true, chart: true, insights: true, coverage: true, orders: true });

    const model = computeDashboardModel(records, state.range, now);

    // A data refresh (or range fallback) can strand a month selection that
    // no longer exists in this range's chart — drop it rather than show an
    // empty month scope the user can't see a bar for.
    if (state.selectedMonth && !model.chartMonths.some((entry) => entry.month === state.selectedMonth)) {
      state.selectedMonth = null;
      document.body.classList.remove('month-scoped');
    }

    const scopedRecords = recordsInScope(now);
    const scopedStats = state.selectedMonth ? computeDashboardStats(scopedRecords) : model.stats;

    const echo = scopeEchoLabel(now);
    $('scopeTitle').textContent = `Your spending · ${echo}`;
    $('backChip').textContent = `‹ Back to ${rangeLabel(state.range, now)}`;
    document.querySelectorAll('.scope-echo').forEach((el) => { el.textContent = echo; });

    renderStats(model, scopedStats, now);
    renderChart(model);
    renderLedger(scopedStats, now);
    renderPriceWatch(scopedRecords);
    renderMostBought(scopedStats);
    renderCoverage(scopedRecords, scopedStats);
    renderTable(now);
  }

  /* ------------------------------------------------------------------ *
   * Data loading & live refresh
   * ------------------------------------------------------------------ */

  /**
   * Cheap change signature so refresh events that changed nothing don't
   * force a re-render (which would drop chart focus, etc.).
   */
  function signatureOf(records) {
    return records
      .map((record) => {
        const invoice = record && record.invoice;
        const measured = invoice && Number(invoice.schemaVersion || 0) >= CONSTANTS.ORDER_SCHEMA_VERSION ? 1 : 0;
        const summary = record && record.summary;
        return `${record.orderNumber}:${measured}:${invoice ? 1 : 0}:${summary ? 1 : 0}:${dashboardRecordDate(record)}:${summary ? summary.orderTotal || '' : ''}`;
      })
      .join('|');
  }

  /**
   * Re-query the order database and re-render when anything changed.
   * @param {boolean} [force] - render even when the signature is unchanged
   */
  async function refresh(force = false) {
    let records = [];
    try {
      records = await OrderDb.getAllOrders();
    } catch (error) {
      console.warn('Dashboard page: order database unavailable:', error);
    }
    const signature = signatureOf(records);
    if (!force && signature === state.signature) return;
    state.signature = signature;
    state.records = records;
    // Drop selections for orders that no longer exist.
    const known = new Set(records.map((record) => String(record.orderNumber || '')));
    state.selected = new Set([...state.selected].filter((orderNumber) => known.has(orderNumber)));
    renderAll();
  }

  let refreshTimer = null;
  /** Debounced refresh — coalesces bursts of runtime/progress chatter. */
  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, 1000);
  }

  // Live refresh, no timer polling: any extension runtime message (the
  // embedded panel's collection start/stop/progress chatter all routes
  // through chrome.runtime) schedules a debounced DB re-read…
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(() => {
      scheduleRefresh();
      return false;
    });
  }
  // …plus a refresh whenever the page regains focus…
  window.addEventListener('focus', () => refresh());
  // …plus any same-origin postMessage from the embedded panel (future
  // panel→dashboard notifications land here without a contract change).
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    const source = event.data && event.data.source;
    if (typeof source === 'string' && source.startsWith('wie-') && source !== 'wie-dashboard') {
      scheduleRefresh();
    }
  });

  // Theme + export-option live sync from the shared storage keys (the
  // panel and Settings write these; mirroring keeps both UIs honest).
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.theme) applyTheme(changes.theme.newValue);
      if (changes.exportFormat) $('pageExportFormat').value = changes.exportFormat.newValue || 'xlsx';
      if (changes.includeThumbnails) $('pageIncludeThumbnails').checked = Boolean(changes.includeThumbnails.newValue);
      if (changes[CONSTANTS.STORAGE_KEYS.LEGACY_EXCEL]) {
        $('pageLegacyExcel').checked = Boolean(changes[CONSTANTS.STORAGE_KEYS.LEGACY_EXCEL].newValue);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Static event wiring
   * ------------------------------------------------------------------ */

  $('checkNewOrdersBtn').addEventListener('click', () => {
    sendToPanel('START_COLLECTION');
    revealRail();
  });

  $('settingsBtn').addEventListener('click', () => {
    sendToPanel('OPEN_SETTINGS');
    revealRail();
  });

  $('openSettingsLink').addEventListener('click', () => {
    sendToPanel('OPEN_SETTINGS');
    revealRail();
  });

  $('scopeSelect').addEventListener('change', () => {
    state.range = $('scopeSelect').value;
    state.selectedMonth = null;
    renderAll();
  });

  $('backChip').addEventListener('click', () => {
    state.selectedMonth = null;
    renderAll();
  });

  $('searchInput').addEventListener('input', () => {
    state.search = $('searchInput').value;
    renderTable(new Date());
  });

  /** Toggle/switch the sort column, then re-render the table. */
  function setSort(column) {
    if (state.sortBy === column) {
      state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
    } else {
      state.sortBy = column;
      state.sortDir = 'desc';
    }
    renderTable(new Date());
  }
  $('sortDateBtn').addEventListener('click', () => setSort('date'));
  $('sortTotalBtn').addEventListener('click', () => setSort('total'));

  // Row-checkbox changes (delegated — rows re-render often).
  $('orderRows').addEventListener('change', (event) => {
    const checkbox = event.target;
    if (!checkbox || checkbox.type !== 'checkbox' || !checkbox.dataset.order) return;
    if (checkbox.checked) {
      state.selected.add(checkbox.dataset.order);
    } else {
      state.selected.delete(checkbox.dataset.order);
    }
    updateSelectionUi();
  });

  /** Send the selected+shown orders to the panel for export. */
  function exportSelection(mode) {
    const orderNumbers = selectedShownOrderNumbers();
    if (!orderNumbers.length) return;
    sendToPanel('EXPORT_ORDERS', { mode, orderNumbers });
    revealRail();
  }
  $('exportSingleBtn').addEventListener('click', () => exportSelection('single'));
  $('exportMultipleBtn').addEventListener('click', () => exportSelection('multiple'));

  // "Export <scope> orders": select every measured shown row, then export
  // them as one file via the embedded panel.
  $('exportScopeBtn').addEventListener('click', () => {
    const measured = state.shownRows
      .filter((row) => row.hasInvoice)
      .map((row) => String(row.orderNumber || ''));
    if (!measured.length) return;
    state.selected = new Set(measured);
    renderTable(new Date());
    sendToPanel('EXPORT_ORDERS', { mode: 'single', orderNumbers: measured });
    revealRail();
  });

  // Export-format controls: mirror the panel's stored defaults, and push
  // page-side changes into the panel over the bridge.
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(
      ['exportFormat', 'includeThumbnails', CONSTANTS.STORAGE_KEYS.LEGACY_EXCEL],
      (stored) => {
        if (stored && stored.exportFormat) $('pageExportFormat').value = stored.exportFormat;
        $('pageIncludeThumbnails').checked = Boolean(stored && stored.includeThumbnails);
        $('pageLegacyExcel').checked = Boolean(stored && stored[CONSTANTS.STORAGE_KEYS.LEGACY_EXCEL]);
      }
    );
  }
  $('pageExportFormat').addEventListener('change', () => {
    sendToPanel('SET_EXPORT_FORMAT', { format: $('pageExportFormat').value });
  });
  $('pageIncludeThumbnails').addEventListener('change', () => {
    sendToPanel('SET_EXPORT_OPTION', { option: 'thumbnails', value: $('pageIncludeThumbnails').checked });
  });
  $('pageLegacyExcel').addEventListener('change', () => {
    sendToPanel('SET_EXPORT_OPTION', { option: 'legacyExcel', value: $('pageLegacyExcel').checked });
  });

  // First paint.
  refresh(true);
})();
