/**
 * Overview extras: the monthly budget tracker and refunds tracker cards
 * rendered into the Overview's #overviewExtras slot (dashboard.page.js
 * registers them via WIEDash.registerOverviewExtra).
 *
 * Two halves, same file:
 *   1. PURE computation exposed as a single `OverviewExtras` global (no DOM)
 *      so the node vm test sandbox can load it — same dual-environment
 *      export shape dashboard.itemstats.js uses. Depends on the shared
 *      globals from utils.js (parseNumericValue, CONSTANTS) and
 *      sidepanel.dashboard.js (dashboardRecordDate), which load before this
 *      file in every context (dashboard index.html, tests/helpers/sandbox.js).
 *   2. DOM rendering, guarded on the WIEDash registry existing so the file
 *      stays loadable in non-page contexts (a bare registry stub suffices).
 *
 * Everything is computed on-device. No fetch(), no telemetry — the only
 * persistence is one chrome.storage.local key (the budget number).
 */

/* ------------------------------------------------------------------ *
 * Pure helpers (OverviewExtras global)
 * ------------------------------------------------------------------ */
(() => {
  'use strict';

  /** Round a money value to cents (floating-point sums drift otherwise). */
  const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

  /**
   * Measured-invoice predicate — same rule as computeDashboardStats: only
   * schema-current invoices are trusted (pre-v3 invoices can contain
   * doubled items / $0.00 prices). CONSTANTS is read lazily so the module
   * stays loadable in a sandbox where the load order differs.
   * @param {Object} record - OrderDb record
   * @returns {boolean}
   */
  function isMeasured(record) {
    const invoice = record && record.invoice;
    if (!invoice) return false;
    const minVersion =
      (typeof CONSTANTS !== 'undefined' && CONSTANTS && CONSTANTS.ORDER_SCHEMA_VERSION) || 3;
    return Number(invoice.schemaVersion || 0) >= minVersion;
  }

  /**
   * Best available total for one record — the same moneyOf pairing the
   * Overview's detail rows use: a MEASURED invoice's total first, then the
   * purchase-history summary total (fast SSR-fetch invoices carry items but
   * no price block). Unlike computeDashboardStats, summary-only records DO
   * fall back to their summary total: a budget that ignored not-yet-fetched
   * orders would understate the month and let the user overspend. Pre-v3
   * invoice values stay untrusted — those records use the summary only.
   * @param {Object} record - OrderDb record
   * @returns {number} total in the record's own currency, 0 when unknown
   */
  function recordTotal(record) {
    const invoice = isMeasured(record) ? record.invoice : {};
    const summary = (record && record.summary) || {};
    return (
      parseNumericValue(invoice.orderTotal) ||
      parseNumericValue(summary.orderTotal || (record && record.orderTotal) || '')
    );
  }

  /**
   * Spend in `now`'s calendar month. Records are dated with the same
   * resolver every dashboard scope uses (dashboardRecordDate), so this can
   * never disagree with the Overview about which month an order is in.
   * `orderCount` counts the orders that contributed to `spent` — undated or
   * total-less records can't be budgeted against and are excluded.
   * @param {Array} records - OrderDb records
   * @param {Date} [now] - injectable for deterministic tests
   * @returns {{spent: number, orderCount: number}}
   */
  function monthSpend(records, now = new Date()) {
    const list = Array.isArray(records) ? records : [];
    const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let spent = 0;
    let orderCount = 0;
    list.forEach((record) => {
      // dashboardRecordDate returns '' for undated records → never matches.
      if (!dashboardRecordDate(record).startsWith(prefix)) return;
      const total = recordTotal(record);
      if (!total) return;
      spent += total;
      orderCount += 1;
    });
    return { spent: round2(spent), orderCount };
  }

  /**
   * Projected month-end spend from the pace so far: spend per elapsed day
   * extrapolated across the whole month. Day 1 is guarded (getDate() is
   * 1-based, but Math.max keeps a hostile/zeroed date from dividing by 0);
   * a day-1 projection is honest math but wildly noisy, which is why the
   * card labels it a projection.
   * @param {number} spent - month-to-date spend (monthSpend().spent)
   * @param {Date} [now] - injectable for deterministic tests
   * @returns {{perDay: number, projected: number, daysElapsed: number, daysInMonth: number}}
   */
  function budgetProjection(spent, now = new Date()) {
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const daysElapsed = Math.min(Math.max(1, now.getDate()), daysInMonth);
    const perDay = (Number(spent) || 0) / daysElapsed;
    return {
      perDay: round2(perDay),
      projected: round2(perDay * daysInMonth),
      daysElapsed,
      daysInMonth,
    };
  }

  /**
   * Refund rollup across records — the same invoice-first/summary-fallback
   * pairing as moneyOf (dashboard.page.js). Refund fields are stored "$12.34"
   * strings (or numbers post-normalization); missing/empty/zero → skipped.
   * `total`/`count` cover every refunded order; `orders` is capped at the
   * top 5 by refund size (order number as a deterministic tiebreak).
   * @param {Array} records - OrderDb records
   * @returns {{total: number, count: number,
   *   orders: Array<{orderNumber: string, date: string, refund: number}>}}
   */
  function refundSummary(records) {
    const list = Array.isArray(records) ? records : [];
    let total = 0;
    const orders = [];
    list.forEach((record) => {
      const invoice = (record && record.invoice) || {};
      const summary = (record && record.summary) || {};
      const refund =
        parseNumericValue(invoice.refund || '') || parseNumericValue(summary.refund || '');
      if (!(refund > 0)) return;
      total += refund;
      orders.push({
        orderNumber: String((record && record.orderNumber) || ''),
        date: dashboardRecordDate(record),
        refund: round2(refund),
      });
    });
    orders.sort((a, b) => b.refund - a.refund || a.orderNumber.localeCompare(b.orderNumber));
    return { total: round2(total), count: orders.length, orders: orders.slice(0, 5) };
  }

  const OverviewExtras = { monthSpend, budgetProjection, refundSummary };

  // Same dual-environment export shape dashboard.itemstats.js uses: browser
  // window, worker/self, or bare vm context all end up with the global.
  const root =
    typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : window;
  root.OverviewExtras = OverviewExtras;
})();

/* ------------------------------------------------------------------ *
 * DOM half — budget + refunds cards inside #overviewExtras
 * ------------------------------------------------------------------ */
(() => {
  'use strict';

  // Page-only half: without the view registry (vm sandbox loads a bare stub,
  // other contexts have nothing) there is no slot to render into.
  if (typeof WIEDash === 'undefined' || !WIEDash || typeof WIEDash.registerOverviewExtra !== 'function') {
    return;
  }

  /**
   * The stored budget: a bare number in the active provider's DISPLAY
   * currency (never converted — same "no conversion, ever" rule as the rest
   * of the dashboard). Cleared by storing null (ctx only exposes get/set,
   * not remove; the read below treats anything non-positive as unset).
   */
  const BUDGET_KEY = 'dashboardMonthlyBudget';

  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const RING_RADIUS = 30;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  /* Render is sync but storage is async: cache the stored budget in module
     state, kick off the read on the first render, re-render when it lands,
     and track chrome.storage.onChanged so edits from other surfaces (or a
     second dashboard tab) sync live. */
  let budget = null; // number > 0, or null when unset
  let budgetLoaded = false; // first storage read resolved (or a change event beat it)
  let budgetLoading = false;
  let editing = false; // inline editor open — re-renders must not stomp it
  let lastCtx = null;
  let lastSlot = null;

  /** Coerce a stored value to a usable budget: finite and positive, else null. */
  function normalizeBudget(value) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.round(num * 100) / 100 : null;
  }

  function ensureBudgetLoaded(ctx) {
    if (budgetLoaded || budgetLoading) return;
    budgetLoading = true;
    ctx.storageGet([BUDGET_KEY]).then((result) => {
      // A change event may have resolved the value while the read was in
      // flight — the event carries the newer truth, don't overwrite it.
      if (!budgetLoaded) {
        budget = normalizeBudget(result && result[BUDGET_KEY]);
        budgetLoaded = true;
      }
      if (lastCtx && lastSlot) renderBudgetCard(lastCtx, lastSlot);
    });
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes || !Object.prototype.hasOwnProperty.call(changes, BUDGET_KEY)) return;
      budget = normalizeBudget(changes[BUDGET_KEY].newValue);
      budgetLoaded = true;
      if (!editing && lastCtx && lastSlot) renderBudgetCard(lastCtx, lastSlot);
    });
  }

  /** "Jul 12, 2026" for a 'YYYY-MM-DD' date, else ''. */
  function refundDateLabel(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!match) return '';
    const name = MONTHS_SHORT[Number(match[2]) - 1] || match[2];
    return `${name} ${Number(match[3])}, ${match[1]}`;
  }

  /** "in CAD" style note — only when the display currency isn't the USD default. */
  function currencyNoteHtml(ctx) {
    const currency = String(ctx.currency || 'USD').toUpperCase();
    if (currency === 'USD') return '';
    return `<div class="sub">Budget in ${ctx.escapeHtml(currency)}</div>`;
  }

  /**
   * Find-or-create THIS module's own wrapper inside the slot. Repeated
   * renders reuse the same element and other extras' nodes are never
   * touched. The budget card always sorts before the refunds card.
   */
  function ownCard(slot, id) {
    let el = document.getElementById(id);
    if (!el || el.parentNode !== slot) {
      el = document.createElement('section');
      el.id = id;
      el.className = 'card';
      const refunds = id === 'extrasBudget' ? document.getElementById('extrasRefunds') : null;
      if (refunds && refunds.parentNode === slot) slot.insertBefore(el, refunds);
      else slot.appendChild(el);
    }
    return el;
  }

  /* ---------------- budget card ---------------- */

  /**
   * Swap the budget card to the inline number editor (CSP-safe DOM, no
   * prompt()). Enter saves, Escape cancels. While open, data re-renders
   * skip the card so refresh cycles can't stomp the user's typing.
   */
  function openBudgetEditor(ctx, slot) {
    editing = true;
    const card = ownCard(slot, 'extrasBudget');
    card.innerHTML = `<h2>Monthly budget</h2>
      <div class="ex-editor">
        <input type="number" min="0" step="0.01" inputmode="decimal" placeholder="e.g. 500"
          aria-label="Monthly budget amount">
        <button type="button" class="btn btn-primary" data-act="save">Save</button>
        <button type="button" class="btn btn-quiet" data-act="cancel">Cancel</button>
      </div>
      ${currencyNoteHtml(ctx)}`;

    const input = card.querySelector('input');
    if (budget !== null) input.value = String(budget);

    const close = () => {
      editing = false;
      renderBudgetCard(ctx, slot);
    };
    const save = () => {
      const value = normalizeBudget(parseFloat(input.value));
      if (value === null) {
        input.focus(); // invalid/empty: keep the editor open rather than storing garbage
        return;
      }
      budget = value;
      budgetLoaded = true;
      ctx.storageSet({ [BUDGET_KEY]: value });
      close();
    };

    card.querySelector('[data-act="save"]').addEventListener('click', save);
    card.querySelector('[data-act="cancel"]').addEventListener('click', close);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        save();
      } else if (event.key === 'Escape') {
        close();
      }
    });
    input.focus();
  }

  function renderBudgetCard(ctx, slot) {
    if (editing) return; // never stomp an open editor
    const card = ownCard(slot, 'extrasBudget');
    const esc = ctx.escapeHtml;
    const monthKey = `${ctx.now.getFullYear()}-${String(ctx.now.getMonth() + 1).padStart(2, '0')}`;
    const monthName = ctx.monthLabel(monthKey);

    if (!budgetLoaded) {
      // First render races the storage read — hold a quiet shell instead of
      // flashing "set a budget" at users who already set one.
      card.innerHTML = `<h2>Monthly budget</h2><div class="sub">${esc(monthName)}</div>`;
      return;
    }

    if (budget === null) {
      card.innerHTML = `<h2>Monthly budget</h2>
        <div class="sub">Track ${esc(monthName)} spending against a monthly target.</div>
        <div class="ex-actions">
          <button type="button" class="btn" data-act="set">Set a monthly budget</button>
        </div>`;
      card.querySelector('[data-act="set"]').addEventListener('click', () => openBudgetEditor(ctx, slot));
      return;
    }

    // The month scopes itself from ctx.now on every render, so a new month
    // resets the tracker with no stored state to expire.
    const { spent, orderCount } = OverviewExtras.monthSpend(ctx.records, ctx.now);
    const projection = OverviewExtras.budgetProjection(spent, ctx.now);
    const percent = (spent / budget) * 100;
    const percentShown = Math.round(percent);
    const ringClass = percent > 100 ? ' ex-ring-over' : percent > 85 ? ' ex-ring-warn' : '';
    const fillOffset = RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, percent / 100)));
    const remaining = Math.round((budget - spent) * 100) / 100;
    const remainingHtml = remaining >= 0
      ? `<div class="ex-line-sub">${esc(ctx.formatMoney(remaining))} left this month</div>`
      : `<div class="ex-line-over">${esc(ctx.formatMoney(-remaining))} over budget</div>`;

    card.innerHTML = `<h2>Monthly budget</h2>
      <div class="sub">${esc(monthName)} · ${orderCount} order${orderCount === 1 ? '' : 's'} so far</div>
      <div class="ex-budget-body">
        <svg class="ex-ring${ringClass}" width="72" height="72" viewBox="0 0 72 72" role="img"
          aria-label="${percentShown}% of the monthly budget used">
          <g transform="rotate(-90 36 36)">
            <circle class="ex-ring-track" cx="36" cy="36" r="${RING_RADIUS}" fill="none" stroke-width="8"/>
            <circle class="ex-ring-fill" cx="36" cy="36" r="${RING_RADIUS}" fill="none" stroke-width="8"
              stroke-linecap="round" stroke-dasharray="${RING_CIRCUMFERENCE.toFixed(3)}"
              stroke-dashoffset="${fillOffset.toFixed(3)}"/>
          </g>
          <text x="36" y="37" text-anchor="middle" dominant-baseline="middle"
            class="ex-ring-label">${percentShown}%</text>
        </svg>
        <div class="ex-budget-info">
          <div class="ex-line-main"><span class="mono">${esc(ctx.formatMoney(spent))}</span>
            <span class="ex-line-of">of ${esc(ctx.formatMoney(budget))}</span></div>
          <div class="ex-line-sub">On pace for ${esc(ctx.formatMoney(projection.projected))} by month end (projection)</div>
          ${remainingHtml}
          <div class="ex-actions">
            <button type="button" class="btn btn-quiet" data-act="edit">Edit</button>
            <button type="button" class="btn btn-quiet" data-act="remove">Remove</button>
          </div>
        </div>
      </div>
      ${currencyNoteHtml(ctx)}`;

    card.querySelector('[data-act="edit"]').addEventListener('click', () => openBudgetEditor(ctx, slot));
    card.querySelector('[data-act="remove"]').addEventListener('click', () => {
      budget = null;
      ctx.storageSet({ [BUDGET_KEY]: null }); // null = cleared (ctx has no remove)
      renderBudgetCard(ctx, slot);
    });
  }

  /* ---------------- refunds card ---------------- */

  function renderRefundsCard(ctx, slot) {
    // Scope refunds like everything else on the Overview (model != null in
    // the modes where extras render — records is the defensive fallback).
    const source = ctx.model ? ctx.scopedRecords : ctx.records;
    const summary = OverviewExtras.refundSummary(source);
    const existing = document.getElementById('extrasRefunds');
    if (!summary.count) {
      // Nothing refunded in scope: no card at all (a $0.00 refunds card
      // would just be noise for most users).
      if (existing && existing.parentNode === slot) existing.remove();
      return;
    }

    const card = ownCard(slot, 'extrasRefunds');
    const esc = ctx.escapeHtml;
    const rows = summary.orders
      .map((order) => `<li class="ex-refund-row">
          <span class="ex-refund-onum mono">…${esc(order.orderNumber.slice(-8))}</span>
          <span class="ex-refund-date">${esc(refundDateLabel(order.date))}</span>
          <span class="ex-refund-amt mono">${esc(ctx.formatMoney(order.refund))}</span>
        </li>`)
      .join('');

    card.innerHTML = `<h2>Refunds</h2>
      <div class="ex-refund-total mono">${esc(ctx.formatMoney(summary.total))}</div>
      <div class="sub">${summary.count} refunded order${summary.count === 1 ? '' : 's'} · ${esc(ctx.scopeEchoLabel(ctx.now))}</div>
      <ul class="ex-refund-list">${rows}</ul>`;
  }

  /* ---------------- registration ---------------- */

  WIEDash.registerOverviewExtra((ctx, slotEl) => {
    if (!slotEl) return;
    lastCtx = ctx;
    lastSlot = slotEl;
    ensureBudgetLoaded(ctx);
    renderBudgetCard(ctx, slotEl);
    renderRefundsCard(ctx, slotEl);
  });
})();
