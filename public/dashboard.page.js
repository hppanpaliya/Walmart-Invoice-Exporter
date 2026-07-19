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
    // Provider scoping (2026-07-18): the stored active selection drives the
    // whole page. `provider` is a provider id or PROVIDER_ALL;
    // `providerScopes` holds one {id,label,currency,records} per queried
    // provider (a single entry except in the combined view); `currency` is
    // the display currency for single-provider mode (null when combined);
    // `multiProvider` mirrors whether the header selector is shown.
    provider: null,
    providerScopes: [],
    currency: 'USD',
    multiProvider: false,
    // Multi-account scoping (2026-07-19): the resolved account SELECTION VALUE
    // (a real 32-hex key, the CONSTANTS.ACCOUNTS.UNTAGGED sentinel, or null for
    // "all accounts") drives every data read below. It is shared with the side
    // panel through CONSTANTS.STORAGE_KEYS.CURRENT_ACCOUNT. `accountSummaries`
    // (MRU-first, from OrderDb.getAccountSummaries) plus the stored label and
    // ordinal maps feed the header switcher.
    account: null,
    accountSummaries: [],
    accountLabels: {},
    accountOrdinals: {},
  };

  /** True while the inline rename input is open — keep re-renders from stomping it. */
  let accountRenaming = false;

  /* Small promise wrappers over the callback-style chrome.storage.local API,
     so the account resolver can await reads/writes like the rest of refresh(). */
  function storageGet(keys) {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve({});
        return;
      }
      chrome.storage.local.get(keys, (result) => resolve(result || {}));
    });
  }
  function storageSet(items) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.set(items);
  }

  /** The provider-selection contract (sidepanel.providers.js), if loaded. */
  function providersApi() {
    return typeof Sidepanel !== 'undefined' && Sidepanel.providers ? Sidepanel.providers : null;
  }

  /* ------------------------------------------------------------------ *
   * Formatting helpers
   * ------------------------------------------------------------------ */

  /**
   * Defensive money formatter: accepts numbers or stored strings like
   * "$42.17" and renders them in the ACTIVE provider's currency via the
   * shared formatDashboardMoney (sidepanel.dashboard.js). USD output is
   * byte-identical to the historical "$X,XXX.XX" rendering.
   * @param {number|string} value
   * @returns {string}
   */
  function formatMoney(value) {
    return formatDashboardMoney(value, state.currency);
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
    // Canvas charts (core + view modules) bake CSS-token colors in at render
    // time — a theme flip must repaint them or they keep the old palette.
    // No-op before the first data render.
    if (state.signature !== null) renderAll();
  }

  // System-theme flips repaint too (only matters while no manual override).
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
  if (prefersDark.addEventListener) {
    prefersDark.addEventListener('change', () => {
      if (state.signature !== null) renderAll();
    });
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['theme'], (result) => {
      applyTheme(result && result.theme);
    });
  }

  /* ------------------------------------------------------------------ *
   * View registry + hash router (2026-07-19)
   *
   * The dashboard is a multi-view app: #/overview, #/items, #/trends,
   * #/orders, #/review. The Overview and Orders views are rendered by this
   * core file; the others live in their own dashboard.view-*.js modules
   * that call WIEDash.registerView(id, {render}) after this script loads.
   * Elements opt into views with a space-separated data-view attribute —
   * routing toggles .view-off on them, while the [hidden] attribute stays
   * the orthogonal data-state channel (setSectionVisibility). View modules
   * re-render only when active AND when data changed (dirty set), so
   * Chart.js canvases are never sized inside a display:none container.
   * ------------------------------------------------------------------ */

  const navIcon = (paths) =>
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

  /** Nav order + chrome for each view. Extendable via WIEDash.addNavView. */
  const NAV_VIEWS = [
    { id: 'overview', label: 'Overview', icon: navIcon('<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>') },
    { id: 'items', label: 'Items', icon: navIcon('<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>') },
    { id: 'trends', label: 'Trends', icon: navIcon('<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>') },
    { id: 'orders', label: 'Orders', icon: navIcon('<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M14 8H8"/><path d="M16 12H8"/><path d="M13 16H8"/>') },
    { id: 'review', label: 'Year in review', icon: navIcon('<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="M5 3v4"/><path d="M19 17v4"/><path d="M3 5h4"/><path d="M17 19h4"/>') },
  ];

  const viewImpls = new Map(); // view id -> {render(ctx)}
  const viewDirty = new Set(); // views whose data changed since their last render
  const overviewExtras = []; // render fns for #overviewExtras (budget, refunds, …)
  let lastViewCtx = null;
  let activeView = 'overview';

  function renderNav() {
    $('appNav').innerHTML = NAV_VIEWS.map((view) => `
      <button type="button" class="appnav-btn" data-nav="${view.id}" aria-current="${view.id === activeView ? 'page' : 'false'}" title="${escapeHtml(view.label)}">
        ${view.icon}<span class="appnav-label">${escapeHtml(view.label)}</span>
      </button>`).join('');
  }

  $('appNav').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-nav]');
    if (btn) location.hash = `#/${btn.dataset.nav}`;
  });

  function viewFromHash() {
    const match = /^#\/([a-z-]+)/.exec(location.hash || '');
    return match && NAV_VIEWS.some((view) => view.id === match[1]) ? match[1] : 'overview';
  }

  function applyViewVisibility() {
    document.querySelectorAll('#page [data-view]').forEach((el) => {
      const views = (el.getAttribute('data-view') || '').split(/\s+/);
      el.classList.toggle('view-off', !views.includes(activeView));
    });
  }

  function setActiveView(id) {
    activeView = id;
    document.body.dataset.view = id;
    $('appNav').querySelectorAll('[data-nav]').forEach((btn) => {
      btn.setAttribute('aria-current', btn.dataset.nav === id ? 'page' : 'false');
    });
    applyViewVisibility();
    renderRegisteredView(id);
  }

  /** Render one registered view, but only when active data is newer than its last render. */
  function renderRegisteredView(id) {
    const impl = viewImpls.get(id);
    if (!impl || !lastViewCtx || !viewDirty.has(id)) return;
    viewDirty.delete(id);
    try {
      impl.render(lastViewCtx);
    } catch (error) {
      console.error(`Dashboard view "${id}" failed to render:`, error);
    }
  }

  /**
   * The context handed to view modules and overview extras. `model` /
   * `scopedStats` are null outside single-provider normal mode (empty DB,
   * nothing measured, or combined multi-currency mode — see `combined`).
   */
  function buildViewCtx(extra) {
    return {
      now: new Date(),
      state,
      records: state.records,
      range: state.range,
      selectedMonth: state.selectedMonth,
      currency: state.currency,
      combined: false,
      model: null,
      scopedRecords: [],
      scopedStats: null,
      formatMoney,
      monthLabel,
      rangeLabel,
      scopeEchoLabel,
      recordsInRange,
      recordsInScope,
      escapeHtml,
      sendToPanel,
      revealRail,
      storageGet,
      storageSet,
      refresh,
      Chart: (typeof window !== 'undefined' && window.Chart) || null,
      ...extra,
    };
  }

  /** New data rendered: mark every view dirty, re-render the active one. */
  function notifyViews(extra) {
    lastViewCtx = buildViewCtx(extra || {});
    for (const id of viewImpls.keys()) viewDirty.add(id);
    renderRegisteredView(activeView);
  }

  /** Run the overview add-on renderers (budget/refunds) into #overviewExtras. */
  function renderOverviewExtras(ctx) {
    const slot = $('overviewExtras');
    overviewExtras.forEach((renderExtra) => {
      try {
        renderExtra(ctx, slot);
      } catch (error) {
        console.error('Dashboard overview extra failed to render:', error);
      }
    });
  }

  /** Public registration surface for the drop-in view modules. */
  window.WIEDash = {
    registerView(id, impl) {
      viewImpls.set(id, impl);
      if (lastViewCtx) {
        viewDirty.add(id);
        if (id === activeView) renderRegisteredView(id);
      }
    },
    registerOverviewExtra(renderExtra) {
      overviewExtras.push(renderExtra);
      if (lastViewCtx && lastViewCtx.model && !lastViewCtx.combined) {
        try {
          renderExtra(lastViewCtx, $('overviewExtras'));
        } catch (error) {
          console.error('Dashboard overview extra failed to render:', error);
        }
      }
    },
    addNavView(view) {
      NAV_VIEWS.push(view);
      renderNav();
    },
  };

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
    return `<tr class="order-row" data-onum="${escapeHtml(orderNumber)}" aria-expanded="false">
      <td><input type="checkbox" data-order="${escapeHtml(orderNumber)}" aria-label="Select order ending ${escapeHtml(last8)}"${checked}></td>
      <td class="date-cell">${escapeHtml(rowDateLabel(row, now))}</td>
      <td>${row.status ? `<span class="status-chip">${escapeHtml(row.status)}</span>` : ''}</td>
      <td class="items-cell">${escapeHtml(rowItemsLabel(row))}</td>
      <td class="onum mono">…${escapeHtml(orderNumber.slice(-8))}</td>
      <td class="num mono">${escapeHtml(total)}</td>
      <td class="data-cell">${dataChip}<span class="row-chevron" aria-hidden="true">›</span></td>
    </tr>`;
  }

  /** Re-render the table body from the current scope, search, and sort. */
  /** The month group label a table row belongs to (same as the panel list). */
  function rowMonthGroup(row) {
    return monthGroupLabel(row.normalizedDate);
  }

  /** Order numbers of the shown rows in one month group. */
  function monthGroupOrderNumbers(group) {
    return state.shownRows
      .filter((row) => rowMonthGroup(row) === group)
      .map((row) => String(row.orderNumber || ''));
  }

  /** One month header row: a select-all-in-month checkbox + the label. */
  function monthRowHtml(group) {
    return `<tr class="month-row"><td colspan="7"><label class="month-row-label">` +
      `<input type="checkbox" class="month-check" data-month="${escapeHtml(group)}" aria-label="Select all orders in ${escapeHtml(group)}">` +
      `<span>${escapeHtml(group)}</span></label></td></tr>`;
  }

  /** Reflect each month checkbox from its rows' live selection state. */
  function updateMonthRowStates() {
    $('orderRows').querySelectorAll('.month-check').forEach((box) => {
      const numbers = monthGroupOrderNumbers(box.dataset.month);
      const checkedCount = numbers.filter((n) => state.selected.has(n)).length;
      const s = groupSelectionState(numbers.length, checkedCount);
      box.checked = s.checked;
      box.indeterminate = s.indeterminate;
    });
  }

  function renderTable(now) {
    const query = state.search.trim().toLowerCase();
    const rows = sortRows(buildRows(now).filter((row) => matchesSearch(row, query)));
    state.shownRows = rows;

    // Month hierarchy (same as the panel list): under the date sort, group
    // rows beneath month header rows carrying a select-the-month checkbox.
    // The total sort stays flat — interleaved headers make no sense there.
    let html = '';
    if (rows.length && state.sortBy === 'date') {
      let lastGroup = null;
      rows.forEach((row) => {
        const group = rowMonthGroup(row);
        if (group !== lastGroup) {
          html += monthRowHtml(group);
          lastGroup = group;
        }
        html += rowHtml(row, now);
      });
    } else if (rows.length) {
      html = rows.map((row) => rowHtml(row, now)).join('');
    }

    const tbody = $('orderRows');
    tbody.innerHTML = rows.length
      ? html
      : `<tr class="table-empty"><td colspan="7">${query ? 'No orders match your search.' : 'No orders in this scope.'}</td></tr>`;

    $('tableCount').textContent = `${rows.length} shown`;
    updateSortHeaders();
    updateSelectionUi();
    updateMonthRowStates();
  }

  /* ------------------------------------------------------------------ *
   * Expandable per-order invoice details (inline detail rows)
   * ------------------------------------------------------------------ */

  /** Whether a record carries a measured (schema-current) invoice. */
  function recordIsMeasured(record) {
    const invoice = record && record.invoice;
    return Boolean(invoice) && Number(invoice.schemaVersion || 0) >= CONSTANTS.ORDER_SCHEMA_VERSION;
  }

  /** Invoice→summary money fallback, both fields optional. */
  function moneyOf(invoiceValue, summaryValue) {
    return parseNumericValue(invoiceValue) || parseNumericValue(summaryValue);
  }

  /** "Jul 12, 2025" for a 'YYYY-MM-DD' date, else ''. */
  function detailDateLabel(iso) {
    const short = formatRowDateShort(iso);
    return short ? `${short}, ${String(iso).slice(0, 4)}` : '';
  }

  /**
   * Best available detail items for a record: measured-or-not invoice items
   * (name/qty/price), else summary items (name/qty, no price). Every field
   * is optional in stored data, so everything is defensively stringified.
   */
  function detailItemsOf(record) {
    const invoice = record && record.invoice;
    if (invoice && Array.isArray(invoice.items) && invoice.items.length) {
      return invoice.items.map((item) => ({
        name: String((item && item.productName) || '').trim(),
        quantity: item && item.quantity !== null && item.quantity !== undefined && item.quantity !== ''
          ? String(item.quantity) : '',
        price: item && item.price !== null && item.price !== undefined && item.price !== ''
          ? formatMoney(item.price) : '',
      }));
    }
    const summary = record && record.summary;
    if (summary && Array.isArray(summary.items) && summary.items.length) {
      return summary.items.map((item) => ({
        name: String((item && item.name) || '').trim(),
        quantity: item && item.quantity !== null && item.quantity !== undefined && item.quantity !== ''
          ? String(item.quantity) : '',
        price: '',
      }));
    }
    return [];
  }

  /**
   * Money breakdown lines for one order, invoice fields first with summary
   * fallbacks (same pairing computeDashboardStats uses). Empty lines are
   * omitted; the total renders whenever any source has one.
   * @returns {Array<[string, number, string]>} [label, value, ''|'neg'|'total']
   */
  function detailMoneyLines(record) {
    const invoice = (record && record.invoice) || {};
    const summary = (record && record.summary) || {};
    const lines = [
      ['Subtotal', moneyOf(invoice.orderSubtotal, summary.subTotal), ''],
      ['Savings', -moneyOf(invoice.savings, summary.savings), 'neg'],
      ['Tax', moneyOf(invoice.tax, summary.tax), ''],
      ['Tip', moneyOf(invoice.tip, summary.driverTip), ''],
      ['Delivery fees', parseNumericValue(invoice.deliveryCharges), ''],
      ['Bag fee', parseNumericValue(invoice.bagFee), ''],
      ['Donations', moneyOf(invoice.donations, summary.donations), ''],
      ['Refund', -moneyOf(invoice.refund, summary.refund), 'neg'],
    ].filter(([, value]) => Math.abs(value) >= 0.005);
    const total = moneyOf(invoice.orderTotal, summary.orderTotal || (record && record.orderTotal));
    if (total) lines.push(['Total', total, 'total']);
    return lines;
  }

  /** Meta line parts (order date, delivered, type, payment) — present-only. */
  function detailMetaParts(record) {
    const invoice = (record && record.invoice) || {};
    const summary = (record && record.summary) || {};
    const parts = [];
    const orderDate = dashboardRecordDate(record);
    if (orderDate) parts.push(['Ordered', detailDateLabel(orderDate) || orderDate]);
    const deliveredRaw = String(summary.deliveredDate || invoice.deliveredDate || '').split(';')[0].trim();
    if (deliveredRaw) {
      const deliveredIso = normalizeDashboardDate(deliveredRaw);
      parts.push(['Delivered', (deliveredIso && detailDateLabel(deliveredIso)) || deliveredRaw]);
    }
    const orderType = invoice.isInStore ? 'In-store' : String(invoice.orderType || '').trim();
    if (orderType) parts.push(['Type', orderType]);
    const payment = String(invoice.paymentMethods || '').trim();
    if (payment) parts.push(['Payment', payment]);
    return parts;
  }

  /** The inner HTML of one expanded detail row. Every string is escaped. */
  function detailHtml(record) {
    const items = detailItemsOf(record);
    const itemsHtml = items.length
      ? `<table class="detail-items">
          <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th></tr></thead>
          <tbody>${items
            .map((item) => `<tr>
              <td class="detail-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name || '—')}</td>
              <td class="num mono">${escapeHtml(item.quantity || '—')}</td>
              <td class="num mono">${escapeHtml(item.price || '—')}</td>
            </tr>`)
            .join('')}</tbody>
        </table>`
      : '<div class="detail-muted">No item details stored for this order.</div>';

    const moneyHtml = detailMoneyLines(record)
      .map(([label, value, cls]) => {
        const display = value < 0 ? `−${formatMoney(Math.abs(value))}` : formatMoney(value);
        return `<div class="lrow${cls === 'total' ? ' lrow-total' : ''}"><span>${escapeHtml(label)}</span><span class="mono${cls === 'neg' ? ' neg' : ''}">${escapeHtml(display)}</span></div>`;
      })
      .join('');

    const metaHtml = detailMetaParts(record)
      .map(([label, value]) => `<span><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</span>`)
      .join('');

    const note = recordIsMeasured(record)
      ? ''
      : '<div class="detail-muted">Full invoice not fetched yet — select this order and use Fetch data.</div>';

    return `<div class="detail-wrap">
      ${metaHtml ? `<div class="detail-meta">${metaHtml}</div>` : ''}
      <div class="detail-cols">
        <div class="detail-items-col">${itemsHtml}</div>
        ${moneyHtml ? `<div class="detail-money">${moneyHtml}</div>` : ''}
      </div>
      ${note}
    </div>`;
  }

  /**
   * Toggle the inline detail row under one order row. Detail content is
   * built lazily on expand (and rebuilt on re-expand — the table re-renders
   * often, so open state intentionally does not persist across renders).
   */
  function toggleDetailRow(row) {
    const next = row.nextElementSibling;
    if (next && next.classList && next.classList.contains('detail-row')) {
      next.remove();
      row.classList.remove('expanded');
      row.setAttribute('aria-expanded', 'false');
      return;
    }
    const orderNumber = (row.dataset && row.dataset.onum) || '';
    const record = state.records.find(
      (candidate) => String((candidate && candidate.orderNumber) || '') === orderNumber
    );
    const detail = document.createElement('tr');
    detail.className = 'detail-row';
    const cell = document.createElement('td');
    cell.colSpan = 7;
    try {
      cell.innerHTML = record
        ? detailHtml(record)
        : '<div class="detail-muted">Order details unavailable.</div>';
    } catch (error) {
      console.warn('Dashboard page: could not build order details:', error);
      cell.innerHTML = '<div class="detail-muted">Order details unavailable.</div>';
    }
    detail.appendChild(cell);
    row.insertAdjacentElement('afterend', detail);
    row.classList.add('expanded');
    row.setAttribute('aria-expanded', 'true');
  }

  // Row click → expand/collapse (delegated — rows re-render often). Clicks
  // on interactive elements (row checkboxes, month-header labels, buttons)
  // keep their existing behavior and never toggle expansion.
  $('orderRows').addEventListener('click', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('input, label, button, a, select')) return;
    const row = target.closest('tr.order-row');
    if (!row) return;
    toggleDetailRow(row);
  });

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
    $('exportFetchBtn').disabled = count === 0;
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
    // A "Saved" card should never read as a loss: some orders can net out
    // negative (fees/adjustments exceeding line savings), but the total-savings
    // figure is only meaningful as "money kept", so floor it at zero.
    $('statSaved').textContent = formatMoney(Math.max(0, Number(stats.totalSavings) || 0));
  }

  /** Live Chart.js instance for the by-month chart (null while the CSS fallback renders). */
  let chartJsInstance = null;

  /** Destroy the current Chart.js instance, if any (safe to call always). */
  function destroyChartJs() {
    if (chartJsInstance) {
      try { chartJsInstance.destroy(); } catch (_) { /* already torn down */ }
      chartJsInstance = null;
    }
  }

  /** Resolve a CSS custom property off :root, with a hard fallback. */
  function cssVar(name, fallback) {
    try {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value || fallback;
    } catch (_) {
      return fallback;
    }
  }

  /**
   * Drive Chart.js hover + tooltip state from the accessible month hotspots
   * (canvas charts have no per-bar DOM, so hover/focus is forwarded).
   * @param {number|null} index - active month index, or null to clear
   */
  function setChartActiveIndex(index) {
    const instance = chartJsInstance;
    if (!instance) return;
    try {
      const active = index === null ? [] : [{ datasetIndex: 0, index }];
      instance.setActiveElements(active);
      if (instance.tooltip && typeof instance.tooltip.setActiveElements === 'function') {
        instance.tooltip.setActiveElements(active, { x: 0, y: 0 });
      }
      instance.update();
    } catch (_) { /* hover affordance only — never fatal */ }
  }

  /**
   * Chart.js (v4, vendored as window.Chart) rendering of the by-month spend
   * chart: bar per month, tooltip with formatted total + order count, click
   * selects/deselects the month — the same contract as the CSS bars.
   *
   * The canvas draws the visuals; on top of it sits one invisible-but-real
   * `.cbar` hotspot button per month (the same class/data/aria contract as
   * the CSS bars), because a canvas alone is a black box to keyboards,
   * screen readers, and anything else that expects clickable month bars.
   * The hotspots forward hover/focus into Chart.js so its tooltip follows.
   */
  function renderChartJs(chart, months, spansYears) {
    destroyChartJs();
    chart.classList.add('chart-canvas');
    chart.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', chart.getAttribute('aria-label') || 'Monthly spend');
    chart.appendChild(canvas);

    const accent = cssVar('--accent', '#3b82f6');
    const barColor = cssVar('--bar', '#c7d7f2');
    const borderColor = cssVar('--border', '#e5e7eb');
    const mutedColor = cssVar('--text-muted', '#6b7280');
    // No month selected → every bar in accent; month selected → that bar in
    // accent, the rest in the quiet bar token (mirrors .cbar.selected).
    const anySelected = Boolean(state.selectedMonth);
    const colors = months.map((entry) =>
      !anySelected || entry.month === state.selectedMonth ? accent : barColor
    );

    chartJsInstance = new window.Chart(canvas, {
      type: 'bar',
      data: {
        labels: months.map((entry) => barLabel(entry.month, spansYears)),
        datasets: [{
          data: months.map((entry) => entry.total),
          backgroundColor: colors,
          hoverBackgroundColor: colors,
          borderRadius: 4,
          maxBarThickness: 46,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        onClick: (_event, elements) => {
          if (!elements || !elements.length) return;
          const entry = months[elements[0].index];
          if (!entry) return;
          // Clicking the selected bar again deselects (back to the range).
          state.selectedMonth = state.selectedMonth === entry.month ? null : entry.month;
          renderAll();
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => {
                const entry = months[context.dataIndex] || { total: 0, orders: 0 };
                return `${formatMoney(entry.total)} · ${entry.orders} order${entry.orders === 1 ? '' : 's'}`;
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: mutedColor } },
          y: {
            beginAtZero: true,
            grid: { color: borderColor },
            ticks: { color: mutedColor, callback: (value) => formatMoney(value) },
          },
        },
      },
    });

    // Accessible month hotspots over the canvas (see doc comment above).
    const overlay = document.createElement('div');
    overlay.className = 'chart-hotspots';
    months.forEach((entry, index) => {
      const selected = entry.month === state.selectedMonth;
      const hotspot = document.createElement('button');
      hotspot.type = 'button';
      hotspot.className = `cbar${selected ? ' selected' : ''}`;
      hotspot.dataset.month = entry.month;
      hotspot.setAttribute('aria-pressed', String(selected));
      hotspot.setAttribute(
        'aria-label',
        `${monthLabel(entry.month)}: ${formatMoney(entry.total)}, ${entry.orders} order${entry.orders === 1 ? '' : 's'}`
      );
      hotspot.style.left = `${(index / months.length) * 100}%`;
      hotspot.style.width = `${100 / months.length}%`;
      hotspot.addEventListener('click', () => {
        // Clicking the selected bar again deselects (back to the range).
        state.selectedMonth = state.selectedMonth === entry.month ? null : entry.month;
        renderAll();
      });
      hotspot.addEventListener('mouseenter', () => setChartActiveIndex(index));
      hotspot.addEventListener('focus', () => setChartActiveIndex(index));
      hotspot.addEventListener('mouseleave', () => setChartActiveIndex(null));
      hotspot.addEventListener('blur', () => setChartActiveIndex(null));
      overlay.appendChild(hotspot);
    });
    chart.appendChild(overlay);
  }

  /** Render the by-month bar chart for the current RANGE (months stay visible while month-scoped). */
  function renderChart(model) {
    const months = model.chartMonths;
    const chart = $('chart');
    $('chartCard').hidden = months.length === 0;
    if (!months.length) {
      destroyChartJs();
      chart.classList.remove('chart-canvas');
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

    // Prefer the vendored Chart.js when its module has loaded; any failure
    // falls straight through to the CSS bars so the chart always renders.
    if (typeof window !== 'undefined' && typeof window.Chart === 'function') {
      try {
        renderChartJs(chart, months, spansYears);
        return;
      } catch (error) {
        console.warn('Dashboard page: Chart.js render failed, using fallback bars:', error);
        destroyChartJs();
      }
    }

    // Fallback path: the original CSS-bar chart, unchanged.
    destroyChartJs();
    chart.classList.remove('chart-canvas');
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
   * "More insights" card — created from JS after the chart card
   * (dashboard.html stays untouched; MV3 CSP forbids inline scripts there)
   * ------------------------------------------------------------------ */

  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /** Create (once) and return the JS-inserted "More insights" card. */
  function ensureMoreInsightsCard() {
    let card = $('moreInsightsCard');
    if (card) return card;
    card = document.createElement('section');
    card.className = 'card more-insights';
    card.id = 'moreInsightsCard';
    card.hidden = true;
    // JS-inserted after router boot: tag + sync its view membership, or it
    // would be visible on every view (applyViewVisibility ran already).
    card.setAttribute('data-view', 'overview');
    card.classList.toggle('view-off', activeView !== 'overview');
    card.innerHTML =
      '<h2>More insights · <span class="scope-echo"></span></h2>' +
      '<div class="mi-grid" id="moreInsightsGrid"></div>';
    const chartCard = $('chartCard');
    const ordersCard = $('ordersCard');
    if (chartCard && chartCard.insertAdjacentElement) {
      chartCard.insertAdjacentElement('afterend', card);
    } else if (ordersCard && ordersCard.parentNode) {
      ordersCard.parentNode.insertBefore(card, ordersCard);
    } else {
      ($('page') || document.body).appendChild(card);
    }
    return card;
  }

  /**
   * Extra analytics over the SCOPED records (measured invoices only — the
   * same rule every other stat follows), with invoice→summary money fallback.
   */
  function computeMoreInsights(scopedRecords, scopedStats) {
    const measured = (Array.isArray(scopedRecords) ? scopedRecords : []).filter(recordIsMeasured);

    let biggest = null;
    const dayCounts = [0, 0, 0, 0, 0, 0, 0];
    let itemSum = 0;
    let itemOrders = 0;

    measured.forEach((record) => {
      const invoice = record.invoice || {};
      const summary = record.summary || {};
      const total = moneyOf(invoice.orderTotal, summary.orderTotal || record.orderTotal);
      const date = dashboardRecordDate(record);
      if (total && (!biggest || total > biggest.total)) biggest = { total, date };
      if (date) {
        const day = new Date(`${date}T00:00:00`).getDay();
        if (day >= 0 && day <= 6) dayCounts[day] += 1;
      }
      let count = null;
      if (summary.itemCount !== '' && summary.itemCount !== null && summary.itemCount !== undefined) {
        count = parseNumericValue(summary.itemCount);
      } else if (Array.isArray(invoice.items)) {
        count = invoice.items.length;
      } else if (Array.isArray(summary.items)) {
        count = summary.items.length;
      }
      if (count !== null && count > 0) {
        itemSum += count;
        itemOrders += 1;
      }
    });

    const totalSpend = Number(scopedStats.totalSpend) || 0;
    const totalSavings = Math.max(0, Number(scopedStats.totalSavings) || 0);
    const maxDay = Math.max.apply(null, dayCounts);
    const topItems = Array.isArray(scopedStats.topItems) ? scopedStats.topItems : [];

    return {
      measuredCount: measured.length,
      biggest,
      savingsRate: totalSpend > 0 ? (totalSavings / totalSpend) * 100 : null,
      totalSavings,
      avgItems: itemOrders > 0 ? itemSum / itemOrders : null,
      avgItemOrders: itemOrders,
      busiestDay: maxDay > 0 ? { name: DAY_NAMES[dayCounts.indexOf(maxDay)] || '', orders: maxDay } : null,
      topItem: topItems.length ? topItems[0] : null,
    };
  }

  /** Render (or hide) the "More insights" tiles for the current scope. */
  function renderMoreInsights(scopedRecords, scopedStats, now) {
    const card = ensureMoreInsightsCard();
    let insights;
    try {
      insights = computeMoreInsights(scopedRecords, scopedStats);
    } catch (error) {
      console.warn('Dashboard page: more-insights computation failed:', error);
      card.hidden = true;
      return;
    }
    if (!insights.measuredCount) {
      card.hidden = true;
      return;
    }

    const tiles = [];
    if (insights.biggest) {
      tiles.push({
        label: 'Biggest order',
        value: formatMoney(insights.biggest.total),
        sub: detailDateLabel(insights.biggest.date) || 'date unknown',
      });
    }
    if (insights.savingsRate !== null) {
      const rate = insights.savingsRate;
      tiles.push({
        label: 'Savings rate',
        value: `${rate >= 10 ? Math.round(rate) : rate.toFixed(1)}%`,
        sub: `${formatMoney(insights.totalSavings)} saved`,
      });
    }
    if (insights.avgItems !== null) {
      tiles.push({
        label: 'Avg items / order',
        value: insights.avgItems >= 10 ? String(Math.round(insights.avgItems)) : insights.avgItems.toFixed(1),
        sub: `across ${insights.avgItemOrders} measured order${insights.avgItemOrders === 1 ? '' : 's'}`,
      });
    }
    if (insights.busiestDay) {
      tiles.push({
        label: 'Busiest day',
        value: insights.busiestDay.name,
        sub: `${insights.busiestDay.orders} order${insights.busiestDay.orders === 1 ? '' : 's'} placed`,
      });
    }
    if (insights.topItem) {
      tiles.push({
        label: 'Most bought',
        value: String(insights.topItem.name || ''),
        sub: `×${insights.topItem.quantity} · ${formatMoney(insights.topItem.spend)} total`,
      });
    }

    if (!tiles.length) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const echoEl = card.querySelector('.scope-echo');
    if (echoEl) echoEl.textContent = scopeEchoLabel(now);
    $('moreInsightsGrid').innerHTML = tiles
      .map((tile) => `<div class="mi-tile">
        <div class="mi-label">${escapeHtml(tile.label)}</div>
        <div class="mi-value" title="${escapeHtml(tile.value)}">${escapeHtml(tile.value)}</div>
        <div class="mi-sub">${escapeHtml(tile.sub)}</div>
      </div>`)
      .join('');
  }

  /* ------------------------------------------------------------------ *
   * Top-level render
   * ------------------------------------------------------------------ */

  /** Show/hide the main sections for the page modes (incl. combined). */
  function setSectionVisibility({ empty, stats, chart, insights, coverage, orders, combined }) {
    $('emptyRegion').hidden = !empty;
    $('statsSection').hidden = !stats;
    $('chartCard').hidden = !chart;
    $('insightsSection').hidden = !insights;
    // The JS-inserted "More insights" card follows the insight sections'
    // visibility; renderMoreInsights re-hides it when nothing is measured.
    const moreInsights = $('moreInsightsCard');
    if (moreInsights) moreInsights.hidden = !insights;
    $('coverageRegion').hidden = !coverage;
    $('ordersCard').hidden = !orders;
    $('combinedSection').hidden = !combined;
    // Overview extras (budget/refunds) follow the stat strip, except in
    // combined mode where mixed-currency budgets would be meaningless.
    $('overviewExtras').hidden = !stats || Boolean(combined);
    $('scopeSelect').hidden = empty && !orders;
    // Combined mode: mixed-currency averages/savings would be meaningless,
    // so those tiles hide and the stat strip re-flows (CSS .combined-scoped).
    document.body.classList.toggle('combined-scoped', Boolean(combined));
    ['statAvgMonth', 'statAvgOrder', 'statSaved'].forEach((id) => {
      const card = $(id).closest('.card');
      if (card) card.hidden = Boolean(combined);
    });
  }

  /**
   * The active provider's label for the page title — but only once several
   * providers are selectable. With just Walmart.com enabled this is '' so
   * the default page title stays exactly as it always was.
   */
  function providerEcho() {
    if (!state.multiProvider) return '';
    return state.providerScopes.length === 1 ? state.providerScopes[0].label || '' : '';
  }

  /** Render the whole page from state.records / state.providerScopes. */
  function renderAll() {
    const api = providersApi();
    if (api && state.provider === api.PROVIDER_ALL) {
      renderCombined();
      return;
    }

    const now = new Date();
    const records = state.records;

    document.body.classList.toggle('month-scoped', Boolean(state.selectedMonth));

    // Mode (a): nothing stored at all.
    if (!records.length) {
      setSectionVisibility({ empty: true, stats: false, chart: false, insights: false, coverage: false, orders: false });
      $('scopeTitle').textContent = `Your spending${providerEcho() ? ` · ${providerEcho()}` : ''}`;
      $('emptyRegion').innerHTML = `
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
        </svg>
        <h3>No spending data yet</h3>
        <p>Use the panel on the right to load your orders, then download them once —
           the dashboard builds itself from your full invoices.</p>`;
      notifyViews({});
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
      $('scopeTitle').textContent = `Your spending · ${providerEcho() ? `${providerEcho()} · ` : ''}${rangeLabel(state.range, now)}`;
      $('emptyRegion').innerHTML = `
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
        </svg>
        <h3>Almost there</h3>
        <p>You have ${allStats.orderCount} order${allStats.orderCount === 1 ? '' : 's'} stored. Use the panel on the right to load your orders,
           then download them once — the dashboard builds itself from your full invoices.</p>`;
      document.querySelectorAll('.scope-echo').forEach((el) => { el.textContent = rangeLabel(state.range, now); });
      renderTable(now);
      notifyViews({ now });
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
    $('scopeTitle').textContent = `Your spending · ${providerEcho() ? `${providerEcho()} · ` : ''}${echo}`;
    $('backChip').textContent = `‹ Back to ${rangeLabel(state.range, now)}`;
    document.querySelectorAll('.scope-echo').forEach((el) => { el.textContent = echo; });

    renderStats(model, scopedStats, now);
    renderChart(model);
    renderMoreInsights(scopedRecords, scopedStats, now);
    renderLedger(scopedStats, now);
    renderPriceWatch(scopedRecords);
    renderMostBought(scopedStats);
    renderCoverage(scopedRecords, scopedStats);
    renderTable(now);
    notifyViews({ now, model, scopedRecords, scopedStats });
    renderOverviewExtras(lastViewCtx);
  }

  /**
   * Combined "All providers" view. Providers can bill in different
   * currencies, so this NEVER sums or converts across currencies: the hero
   * shows one total per currency and the breakdown card groups per-provider
   * spend under per-currency subtotals (computeProviderDashboard). The
   * single-provider sections (chart, insights, coverage, orders table) stay
   * hidden — they are currency-scoped by design.
   */
  function renderCombined() {
    const now = new Date();
    const scopes = state.providerScopes;

    // Month scoping belongs to the single-provider chart; drop it here.
    state.selectedMonth = null;
    document.body.classList.remove('month-scoped');

    const totalStored = scopes.reduce((sum, scope) => sum + scope.records.length, 0);
    if (!totalStored) {
      setSectionVisibility({ empty: true, stats: false, chart: false, insights: false, coverage: false, orders: false, combined: false });
      $('scopeTitle').textContent = 'Your spending · All sites';
      $('emptyRegion').innerHTML = `
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
        </svg>
        <h3>No spending data yet</h3>
        <p>None of your enabled Walmart sites has stored orders. Use the panel on the right to load orders,
           then download them once — the dashboard builds itself from your full invoices.</p>`;
      notifyViews({ now, combined: true });
      return;
    }

    // Default scope: this year unless nothing measured this year anywhere.
    if (!state.range) {
      const thisYear = computeProviderDashboard(scopes, 'thisYear', now);
      state.range = thisYear.invoiceCount > 0 ? 'thisYear' : 'all';
      $('scopeSelect').value = state.range;
    }

    const combined = computeProviderDashboard(scopes, state.range, now);
    setSectionVisibility({ empty: false, stats: true, chart: false, insights: false, coverage: false, orders: false, combined: true });

    const echo = rangeLabel(state.range, now);
    $('scopeTitle').textContent = `Your spending · All providers · ${echo}`;
    document.querySelectorAll('.scope-echo').forEach((el) => { el.textContent = echo; });

    // Hero: one clearly-labeled total PER CURRENCY — never one fake sum.
    const totals = combined.currencyTotals;
    $('statTotal').textContent = totals.length
      ? totals.map((group) => formatDashboardMoney(group.totalSpend, group.currency)).join('  +  ')
      : formatDashboardMoney(0, null);
    const deltaEl = $('statDelta');
    deltaEl.textContent = '';
    deltaEl.hidden = true;
    const invoicesLabel = `${combined.invoiceCount} downloaded invoice${combined.invoiceCount === 1 ? '' : 's'}`;
    $('statTotalNote').textContent = combined.mixedCurrency
      ? `All providers — one total per currency, never converted, from ${invoicesLabel}`
      : `All providers, from ${invoicesLabel}`;
    $('statOrders').textContent = String(combined.invoiceCount);

    renderProviderBreakdown(combined);
    notifyViews({ now, combined: true });
  }

  /** The per-currency, per-provider breakdown card of the combined view. */
  function renderProviderBreakdown(combined) {
    const groups = combined.currencyTotals;
    $('providerBreakdown').innerHTML = groups.length
      ? groups
          .map((group) => {
            const max = group.providers.reduce((m, p) => Math.max(m, p.totalSpend), 0);
            const rows = group.providers
              .map((provider) => {
                const percent = max > 0 && provider.totalSpend > 0
                  ? Math.max(2, Math.round((provider.totalSpend / max) * 100))
                  : 0;
                const invoices = `${provider.invoiceCount} invoice${provider.invoiceCount === 1 ? '' : 's'}`;
                return `<div class="pbar-row">
                  <span class="pbar-label">${escapeHtml(provider.label)}</span>
                  <div class="pbar"><div class="pbar-fill" style="width:${percent}%"></div></div>
                  <span class="mono pbar-amount">${escapeHtml(formatDashboardMoney(provider.totalSpend, group.currency))}</span>
                  <span class="pbar-meta">${escapeHtml(invoices)}</span>
                </div>`;
              })
              .join('');
            return `<div class="currency-group">
              <div class="cg-head">
                <span class="cg-code">${escapeHtml(group.currency)}</span>
                <span class="mono">${escapeHtml(formatDashboardMoney(group.totalSpend, group.currency))}</span>
              </div>
              ${rows}
            </div>`;
          })
          .join('')
      : '<div class="breakdown-empty">No measured spend in this range yet.</div>';
  }

  /* ------------------------------------------------------------------ *
   * Account selection (shared with the side panel via CURRENT_ACCOUNT)
   * ------------------------------------------------------------------ */

  /** Whether two ordinal maps hold the same keys → values (avoids needless writes). */
  function ordinalsChanged(next, prev) {
    const prevMap = prev || {};
    const nextKeys = Object.keys(next);
    if (nextKeys.length !== Object.keys(prevMap).length) return true;
    return nextKeys.some((key) => next[key] !== prevMap[key]);
  }

  /**
   * Re-read the account summaries and the shared CURRENT_ACCOUNT / label /
   * ordinal storage keys, assign stable "Account N" ordinals to any new
   * account (persisting ONLY when they actually changed), and resolve which
   * account this page should show (persisting CURRENT_ACCOUNT only when the
   * resolved value differs). Leaves the resolution + maps in state for the
   * data reads (state.account) and the switcher to consume. Safe to re-run.
   */
  async function resolveAccountState() {
    const KEYS = CONSTANTS.STORAGE_KEYS;
    let summaries = [];
    try {
      summaries = await OrderDb.getAccountSummaries();
    } catch (error) {
      console.warn('Dashboard page: account summaries unavailable:', error);
      summaries = [];
    }
    const stored = await storageGet([KEYS.CURRENT_ACCOUNT, KEYS.ACCOUNT_LABELS, KEYS.ACCOUNT_ORDINALS]);
    const labels = (stored && stored[KEYS.ACCOUNT_LABELS]) || {};
    const existingOrdinals = (stored && stored[KEYS.ACCOUNT_ORDINALS]) || {};
    const storedCurrent = (stored && stored[KEYS.CURRENT_ACCOUNT]) || null;

    const selectionValues = summaries.map((summary) => accountSelectionValue(summary.accountKey));
    const ordinals = assignAccountOrdinals(selectionValues, existingOrdinals);
    if (ordinalsChanged(ordinals, existingOrdinals)) {
      storageSet({ [KEYS.ACCOUNT_ORDINALS]: ordinals });
    }

    // Single real account (even alongside untagged legacy data) → no account
    // UI anywhere and an UNFILTERED view (accountUiVisible, utils.js).
    const selected = accountUiVisible(summaries) ? resolveSelectedAccount(summaries, storedCurrent) : null;
    if (selected !== storedCurrent) {
      storageSet({ [KEYS.CURRENT_ACCOUNT]: selected });
    }

    state.accountSummaries = summaries;
    state.accountLabels = labels;
    state.accountOrdinals = ordinals;
    state.account = selected;
  }

  /**
   * Render the header account switcher from the resolved account state. Shown
   * only with ≥2 buckets to switch between; each option's text is the account's
   * display name plus a quiet " · N orders" count. Skipped while a rename is in
   * progress so it never blows away the open input.
   */
  function renderAccountSwitcher() {
    const wrap = $('accountSwitcher');
    if (!wrap) return;
    const summaries = state.accountSummaries || [];
    if (!accountUiVisible(summaries)) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    if (accountRenaming) return;

    const options = buildAccountOptions(summaries, {
      labels: state.accountLabels,
      ordinals: state.accountOrdinals,
      selected: state.account,
    });
    $('accountSelect').innerHTML = options
      .map((option) => {
        const meta = `${option.orderCount} order${option.orderCount === 1 ? '' : 's'}`;
        return `<option value="${escapeHtml(option.value)}"${option.selected ? ' selected' : ''}>${escapeHtml(`${option.name} · ${meta}`)}</option>`;
      })
      .join('');
    $('accountSelect').value = state.account || '';
    // Rename only ever targets a concrete selection.
    $('accountRenameBtn').disabled = !state.account;
  }

  /** Swap the select for an inline text input pre-filled with the current name. */
  function beginRename() {
    if (!state.account) return;
    accountRenaming = true;
    const input = $('accountRenameInput');
    input.value = accountDisplayName(state.account, { labels: state.accountLabels, ordinals: state.accountOrdinals });
    $('accountSelect').hidden = true;
    $('accountRenameBtn').hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  }

  /**
   * Close the inline rename. When saving, a trimmed non-empty name is stored as
   * the account's custom label; an empty name deletes the label so it falls back
   * to "Account N". Writing ACCOUNT_LABELS keeps the side panel in sync.
   */
  function endRename(save) {
    if (!accountRenaming) return;
    const input = $('accountRenameInput');
    if (save && state.account) {
      const name = input.value.trim();
      const labels = { ...(state.accountLabels || {}) };
      if (name) {
        labels[state.account] = name;
      } else {
        delete labels[state.account];
      }
      state.accountLabels = labels;
      storageSet({ [CONSTANTS.STORAGE_KEYS.ACCOUNT_LABELS]: labels });
    }
    accountRenaming = false;
    input.hidden = true;
    $('accountSelect').hidden = false;
    $('accountRenameBtn').hidden = false;
    renderAccountSwitcher();
  }

  $('accountSelect').addEventListener('change', () => {
    const value = $('accountSelect').value;
    if (value === state.account) return;
    state.account = value;
    state.selectedMonth = null;
    storageSet({ [CONSTANTS.STORAGE_KEYS.CURRENT_ACCOUNT]: value });
    refresh(true);
  });
  $('accountRenameBtn').addEventListener('click', beginRename);
  $('accountRenameInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      endRename(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      endRename(false);
    }
  });
  $('accountRenameInput').addEventListener('blur', () => endRename(true));

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
   * Re-read the active provider selection, re-query the order database for
   * its scope (one provider, or every enabled provider for PROVIDER_ALL),
   * and re-render when anything changed.
   * @param {boolean} [force] - render even when the signature is unchanged
   */
  async function refresh(force = false) {
    // Resolve the shared account selection before any data read so every scope
    // below is filtered to state.account, then reflect it in the switcher.
    await resolveAccountState();
    renderAccountSwitcher();

    const api = providersApi();
    let provider = 'WALMART_US';
    let scopes = [];
    if (api) {
      try {
        provider = await api.getActive();
        const ids = await api.scopeIds(provider);
        const enabled = await api.enabledAdapters();
        const metaById = new Map(enabled.map((entry) => [entry.id, entry]));
        for (const id of ids) {
          let records = [];
          try {
            records = await OrderDb.getAllOrders(id, state.account);
          } catch (error) {
            console.warn('Dashboard page: order database unavailable:', error);
          }
          const meta = metaById.get(id);
          scopes.push({
            id,
            label: (meta && meta.label) || api.labelFor(id),
            currency: (meta && meta.currency) || api.currencyFor(id) || 'USD',
            records,
          });
        }
      } catch (error) {
        console.warn('Dashboard page: provider contract unavailable:', error);
        scopes = [];
      }
    }
    if (!scopes.length) {
      // Provider contract missing or failed — Walmart-only fallback, exactly
      // the page's historical behavior.
      provider = 'WALMART_US';
      let records = [];
      try {
        records = await OrderDb.getAllOrders(provider, state.account);
      } catch (error) {
        console.warn('Dashboard page: order database unavailable:', error);
      }
      scopes = [{ id: provider, label: 'Walmart.com', currency: 'USD', records }];
    }

    const combined = Boolean(api) && provider === api.PROVIDER_ALL;
    const signature =
      `${provider}|${state.account}||` + scopes.map((scope) => `${scope.id}::${signatureOf(scope.records)}`).join('##');
    if (!force && signature === state.signature) return;
    state.signature = signature;
    state.provider = provider;
    state.providerScopes = scopes;
    state.currency = combined ? null : (scopes[0] && scopes[0].currency) || 'USD';
    state.records = combined ? [] : (scopes[0] && scopes[0].records) || [];
    syncProviderSelect();
    // Drop selections for orders that no longer exist in this scope.
    const known = new Set(state.records.map((record) => String(record.orderNumber || '')));
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
      // Provider live sync: another surface (the panel, its embedded copy,
      // or a second dashboard tab) switched the stored active provider —
      // refresh() re-reads it, and the changed provider id changes the
      // signature, so the page re-renders for the new selection.
      if (changes.active_provider) refresh();
      // Provider opt-ins/outs change what is enabled/selectable.
      if (changes.settings) {
        populateProviderSelect().then(() => refresh(true));
      }
      // Account live sync: the side panel (or a second dashboard tab) switched
      // the active account or renamed one. A real selection change re-reads and
      // re-renders the whole page; a label/ordinal-only change just re-resolves
      // the maps and repaints the switcher. Guarded against self-triggered loops
      // — we only act when the incoming value actually differs from state.
      const AK = CONSTANTS.STORAGE_KEYS;
      const currentChange = changes[AK.CURRENT_ACCOUNT];
      if (currentChange && (currentChange.newValue || null) !== state.account) {
        refresh(true);
      } else if (changes[AK.ACCOUNT_LABELS] || changes[AK.ACCOUNT_ORDINALS]) {
        resolveAccountState().then(() => renderAccountSwitcher());
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Provider selection
   * ------------------------------------------------------------------ */

  /**
   * Fill the header provider selector from Sidepanel.providers.selectable().
   * Hidden while only one provider is enabled — the Walmart.com-only default
   * page looks exactly as it always has.
   */
  async function populateProviderSelect() {
    const select = $('providerSelect');
    const api = providersApi();
    if (!api) {
      select.hidden = true;
      state.multiProvider = false;
      return;
    }
    let options = [];
    try {
      options = await api.selectable();
    } catch (error) {
      console.warn('Dashboard page: provider options unavailable:', error);
    }
    if (!options.length) {
      select.hidden = true;
      state.multiProvider = false;
      return;
    }
    select.innerHTML = options
      .map((option) => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`)
      .join('');
    state.multiProvider = options.length > 1;
    select.hidden = !state.multiProvider;
    try {
      select.value = await api.getActive();
    } catch (error) {
      /* keep the first option selected */
    }
  }

  /** Reflect the active provider in the selector (no-op if not an option). */
  function syncProviderSelect() {
    const select = $('providerSelect');
    if (!select || !state.provider) return;
    if (select.value !== state.provider) select.value = state.provider;
  }

  $('providerSelect').addEventListener('change', async () => {
    const value = $('providerSelect').value;
    state.selectedMonth = null;
    const api = providersApi();
    if (api) {
      try {
        await api.setActive(value);
      } catch (error) {
        console.warn('Dashboard page: could not persist provider selection:', error);
      }
    }
    refresh(true);
  });

  // Provider-switch render entry point (contract for panel-core):
  // Sidepanel.dashboard.render() re-reads the stored active provider and
  // re-renders the whole page. The callable shim is defined in
  // sidepanel.dashboard.js; this page registers the real implementation.
  if (typeof Sidepanel !== 'undefined' && Sidepanel.dashboard) {
    Sidepanel.dashboard._renderImpl = () => refresh(true);
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

  // Row + month-header checkbox changes (delegated — rows re-render often).
  $('orderRows').addEventListener('change', (event) => {
    const checkbox = event.target;
    if (!checkbox || checkbox.type !== 'checkbox') return;

    // Month header: select/clear every shown order in that month.
    if (checkbox.classList.contains('month-check')) {
      const numbers = monthGroupOrderNumbers(checkbox.dataset.month);
      if (checkbox.checked) numbers.forEach((n) => state.selected.add(n));
      else numbers.forEach((n) => state.selected.delete(n));
      numbers.forEach((n) => {
        const rowBox = $('orderRows').querySelector(`input[data-order="${CSS.escape(n)}"]`);
        if (rowBox) rowBox.checked = checkbox.checked;
      });
      checkbox.indeterminate = false;
      updateSelectionUi();
      return;
    }

    if (!checkbox.dataset.order) return;
    if (checkbox.checked) {
      state.selected.add(checkbox.dataset.order);
    } else {
      state.selected.delete(checkbox.dataset.order);
    }
    updateSelectionUi();
    updateMonthRowStates();
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

  // "Fetch data": save the selected orders' full invoice details into the
  // library without downloading a file (mirrors the panel's "Save details to
  // library"). Useful straight from the dashboard when rows show "summary only".
  $('exportFetchBtn').addEventListener('click', () => {
    const orderNumbers = selectedShownOrderNumbers();
    if (!orderNumbers.length) return;
    sendToPanel('SAVE_TO_LIBRARY', { orderNumbers });
    revealRail();
  });

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

  // The Chart.js vendor module may load after first paint — when it
  // announces itself, re-render once so the chart upgrades from the CSS
  // bars to the canvas. Guarded on signature: before the first refresh
  // completes there is nothing to re-render (refresh will use window.Chart
  // itself once it runs).
  window.addEventListener('wie-chart-ready', () => {
    if (state.signature !== null) renderAll();
  }, { once: true });

  // Router boot: nav chrome + the view named in the URL hash (or Overview),
  // then keep following hash changes (back/forward work across views).
  renderNav();
  setActiveView(viewFromHash());
  window.addEventListener('hashchange', () => setActiveView(viewFromHash()));

  // First paint: provider options first, then the initial render.
  populateProviderSelect().then(() => refresh(true));

  // Opened via the extension's right-click "Options" (manifest points there
  // with ?view=settings): hand the deep link to the embedded panel via ITS
  // OWN URL — the panel opens Settings as the last step of its init
  // (sidepanel.js), which can't race. A bridge message here could land
  // before/between the panel's own view initialisation and get lost.
  try {
    if (new URLSearchParams(location.search).get('view') === 'settings') {
      frame.src = 'sidepanel.html?view=settings';
      revealRail();
    }
  } catch (_) {}
})();
