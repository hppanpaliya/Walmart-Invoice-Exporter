/**
 * Items view (#/items) — every distinct item ever bought, with per-item
 * price history and a personal-inflation headline. Registers with the
 * WIEDash view registry (dashboard.page.js); all math lives in
 * dashboard.itemstats.js so the numbers here are the tested ones.
 *
 * Scope: intentionally ALL measured records (ctx.records), NOT the header
 * range — price history and the 12-vs-12-month inflation comparison need
 * the full timeline. The cards say so in their sub-lines.
 */
(() => {
  'use strict';
  if (typeof WIEDash === 'undefined' || typeof ItemStats === 'undefined') return;

  /** Sticky UI state — survives re-renders (render() rebuilds innerHTML). */
  const viewState = {
    search: '',
    sort: 'spent', // 'spent' | 'bought' | 'change' | 'name' | 'last'
    expanded: new Set(), // item keys whose detail row is open
  };

  /** Live Chart.js instances created by this view — destroyed before every rebuild. */
  let charts = [];

  function destroyCharts() {
    charts.forEach((chart) => {
      try { chart.destroy(); } catch (_) { /* already torn down */ }
    });
    charts = [];
  }

  /**
   * Per-render unique key for each index entry. Name-based so open detail
   * rows survive data refreshes, with a #n suffix disambiguating the rare
   * case of two distinct entries (different usItemIds) sharing a name.
   */
  let keyByEntry = new Map();

  function assignEntryKeys(index) {
    keyByEntry = new Map();
    const seen = new Map();
    index.forEach((entry) => {
      const base = entry.name.toLowerCase();
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      keyByEntry.set(entry, n === 0 ? base : `${base}#${n}`);
    });
  }

  function entryKey(entry) {
    return keyByEntry.get(entry) || entry.name.toLowerCase();
  }

  /** Inline sparkline of an item's priced unit-price sequence (SVG — no canvas needed). */
  function sparklineSvg(prices) {
    if (!Array.isArray(prices) || prices.length < 2) return '';
    const width = 90;
    const height = 24;
    const pad = 2;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = max - min || 1;
    const points = prices
      .map((price, index) => {
        const x = pad + (index / (prices.length - 1)) * (width - pad * 2);
        const y = height - pad - ((price - min) / span) * (height - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    return `<svg class="items-spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Price history sparkline">` +
      `<polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  /** Bigger SVG polyline fallback for the expanded detail (when Chart.js is unavailable). */
  function detailSvg(prices) {
    if (!Array.isArray(prices) || prices.length < 2) return '';
    const width = 560;
    const height = 120;
    const pad = 6;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = max - min || 1;
    const points = prices
      .map((price, index) => {
        const x = pad + (index / (prices.length - 1)) * (width - pad * 2);
        const y = height - pad - ((price - min) / span) * (height - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
    return `<svg class="items-detail-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Unit price over time">` +
      `<polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  /** "Jul 12 '25" from 'YYYY-MM-DD', else '—'. */
  function shortDate(iso) {
    if (!iso) return '—';
    const short = formatRowDateShort(iso);
    return short ? `${short} '${String(iso).slice(2, 4)}` : '—';
  }

  /** Signed colored percent span (+12% / −8%), or a muted dash when unknown. */
  function changeHtml(percent) {
    if (percent === null || percent === undefined) return '<span class="items-dim">—</span>';
    if (percent === 0) return '<span class="items-dim">0%</span>';
    const up = percent > 0;
    return `<span class="${up ? 'items-up' : 'items-down'}">${up ? '+' : '−'}${Math.abs(percent)}%</span>`;
  }

  /** One riser/faller list row (all interpolations escaped by the caller's ctx). */
  function moverLi(ctx, item) {
    return `<li>
      <span class="pname" title="${ctx.escapeHtml(item.name)}">${ctx.escapeHtml(item.name)}</span>
      <span class="mono items-dim">${ctx.escapeHtml(ctx.formatMoney(item.thenAvg))} → ${ctx.escapeHtml(ctx.formatMoney(item.nowAvg))}</span>
      ${changeHtml(item.percent)}
    </li>`;
  }

  /** The "Your personal inflation" hero card HTML. */
  function heroHtml(ctx, inflation) {
    if (!inflation) {
      return `<section class="card" id="itemsInflationCard">
        <h2>Your personal inflation</h2>
        <div class="sub">All time — inflation compares the last 12 months vs the 12 before.</div>
        <p class="items-quiet">Not enough overlapping purchases yet — this needs at least 3 items
        bought in both of the last two 12-month windows. Keep fetching invoices and it will appear.</p>
      </section>`;
    }
    const up = inflation.ratePercent > 0;
    const sign = up ? '+' : inflation.ratePercent < 0 ? '−' : '';
    const cls = up ? 'items-rate-up' : inflation.ratePercent < 0 ? 'items-rate-down' : '';
    const risers = inflation.topRisers.map((item) => moverLi(ctx, item)).join('');
    const fallers = inflation.topFallers.map((item) => moverLi(ctx, item)).join('');
    return `<section class="card" id="itemsInflationCard">
      <h2>Your personal inflation</h2>
      <div class="sub">All time — inflation compares the last 12 months vs the 12 before.</div>
      <div class="items-rate mono ${cls}">${sign}${Math.abs(inflation.ratePercent).toFixed(1)}%</div>
      <p class="items-method">Spend-weighted price change across the ${inflation.itemCount} items you bought
      in both of the last two 12-month windows — computed from your own invoices, on your device.</p>
      <div class="items-movers">
        <div>
          <h3>Top risers</h3>
          <ul class="plist">${risers || '<li class="muted">Nothing got pricier.</li>'}</ul>
        </div>
        <div>
          <h3>Top fallers</h3>
          <ul class="plist">${fallers || '<li class="muted">Nothing got cheaper.</li>'}</ul>
        </div>
      </div>
    </section>`;
  }

  /** Filter + sort the index for the table, per the sticky UI state. */
  function shownEntries(index) {
    const query = viewState.search.trim().toLowerCase();
    const entries = query
      ? index.filter((entry) => entry.name.toLowerCase().includes(query))
      : index.slice();
    const changeOf = (entry) => (entry.percentChange === null ? 0 : entry.percentChange);
    switch (viewState.sort) {
      case 'bought':
        entries.sort((a, b) => b.timesBought - a.timesBought || b.totalSpent - a.totalSpent || a.name.localeCompare(b.name));
        break;
      case 'change':
        entries.sort((a, b) => Math.abs(changeOf(b)) - Math.abs(changeOf(a)) || a.name.localeCompare(b.name));
        break;
      case 'name':
        entries.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'last':
        entries.sort((a, b) => b.lastPrice - a.lastPrice || a.name.localeCompare(b.name));
        break;
      default: // 'spent' — buildItemIndex's native order
        entries.sort((a, b) => b.totalSpent - a.totalSpent || a.name.localeCompare(b.name));
    }
    return entries;
  }

  /** One item table row. */
  function itemRowHtml(ctx, entry) {
    const prices = entry.purchases.filter((p) => p.unitPrice > 0).map((p) => p.unitPrice);
    return `<tr class="item-row" data-key="${ctx.escapeHtml(entryKey(entry))}" aria-expanded="${viewState.expanded.has(entryKey(entry))}">
      <td class="items-cell" title="${ctx.escapeHtml(entry.name)}">${ctx.escapeHtml(entry.name)}</td>
      <td class="num mono">${entry.timesBought}×</td>
      <td class="num mono">${ctx.escapeHtml(ctx.formatMoney(entry.totalSpent))}</td>
      <td class="num mono">${entry.avgPrice > 0 ? ctx.escapeHtml(ctx.formatMoney(entry.avgPrice)) : '—'}</td>
      <td class="num mono">${entry.lastPrice > 0 ? ctx.escapeHtml(ctx.formatMoney(entry.lastPrice)) : '—'}</td>
      <td class="num">${changeHtml(entry.percentChange)}</td>
      <td class="items-spark-cell">${sparklineSvg(prices)}</td>
    </tr>`;
  }

  /** The expanded detail's inner HTML (purchase-history table + chart mount). */
  function detailInnerHtml(ctx, entry) {
    const rows = entry.purchases
      .map((purchase) => `<tr>
        <td>${ctx.escapeHtml(shortDate(purchase.date))}</td>
        <td class="mono items-dim">…${ctx.escapeHtml(purchase.orderNumber.slice(-8))}</td>
        <td class="num mono">${ctx.escapeHtml(String(purchase.quantity))}</td>
        <td class="num mono">${purchase.unitPrice > 0 ? ctx.escapeHtml(ctx.formatMoney(purchase.unitPrice)) : '—'}</td>
      </tr>`)
      .join('');
    return `<div class="items-detail">
      <div class="items-detail-history">
        <table class="items-history">
          <thead><tr><th>Date</th><th>Order #</th><th class="num">Qty</th><th class="num">Unit price</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="items-detail-chart"></div>
    </div>`;
  }

  /**
   * Fill one detail row's chart mount: Chart.js line when available (no
   * animation under prefers-reduced-motion), else the SVG polyline fallback.
   */
  function mountDetailChart(ctx, mount, entry) {
    const priced = entry.purchases.filter((p) => p.unitPrice > 0);
    if (priced.length < 2) {
      mount.innerHTML = '<div class="items-quiet">Not enough priced purchases to chart yet.</div>';
      return;
    }
    if (typeof ctx.Chart === 'function') {
      try {
        const canvas = document.createElement('canvas');
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `Unit price history for ${entry.name}`);
        mount.appendChild(canvas);
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const styles = getComputedStyle(document.documentElement);
        const accent = styles.getPropertyValue('--accent').trim() || '#3b82f6';
        const border = styles.getPropertyValue('--border').trim() || '#e5e7eb';
        const muted = styles.getPropertyValue('--text-muted').trim() || '#6b7280';
        const chart = new ctx.Chart(canvas, {
          type: 'line',
          data: {
            labels: priced.map((p) => shortDate(p.date)),
            datasets: [{
              data: priced.map((p) => p.unitPrice),
              borderColor: accent,
              backgroundColor: accent,
              pointRadius: 3,
              tension: 0.2,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: reduce ? false : undefined,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: (item) => ctx.formatMoney(item.parsed.y) } },
            },
            scales: {
              x: { grid: { display: false }, ticks: { color: muted, maxTicksLimit: 8 } },
              y: { grid: { color: border }, ticks: { color: muted, callback: (v) => ctx.formatMoney(v) } },
            },
          },
        });
        charts.push(chart);
        return chart;
      } catch (error) {
        console.warn('Items view: Chart.js detail render failed, using SVG fallback:', error);
      }
    }
    mount.innerHTML = detailSvg(priced.map((p) => p.unitPrice));
    return null;
  }

  /** Insert the detail row after `row` for `entry` (and its chart). */
  function insertDetailRow(ctx, row, entry) {
    const detail = document.createElement('tr');
    detail.className = 'items-detail-row';
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.innerHTML = detailInnerHtml(ctx, entry);
    detail.appendChild(cell);
    row.insertAdjacentElement('afterend', detail);
    row.classList.add('expanded');
    row.setAttribute('aria-expanded', 'true');
    // Keep the instance on the row so collapsing can destroy just this chart.
    detail._wieChart = mountDetailChart(ctx, cell.querySelector('.items-detail-chart'), entry);
  }

  /** Re-render the table body from the sticky search/sort state. */
  function renderTableBody(ctx, root, index) {
    const tbody = root.querySelector('#itemsRows');
    const entries = shownEntries(index);
    const byKey = new Map(entries.map((entry) => [entryKey(entry), entry]));

    tbody.innerHTML = entries.length
      ? entries.map((entry) => itemRowHtml(ctx, entry)).join('')
      : `<tr class="table-empty"><td colspan="7">${viewState.search.trim() ? 'No items match your search.' : 'No items yet.'}</td></tr>`;

    // Restore open detail rows (their charts were destroyed with the old DOM).
    viewState.expanded.forEach((key) => {
      const entry = byKey.get(key);
      const row = entry && tbody.querySelector(`tr.item-row[data-key="${CSS.escape(key)}"]`);
      if (entry && row) insertDetailRow(ctx, row, entry);
    });

    const countEl = root.querySelector('#itemsShownCount');
    if (countEl) countEl.textContent = `${entries.length} shown`;
  }

  /**
   * Full view render. Called by the registry only while visible and only
   * when data changed — idempotent: rebuilds innerHTML, destroying any
   * Chart.js instances from the previous render first.
   */
  function render(ctx) {
    const root = document.getElementById('viewItems');
    if (!root) return;
    destroyCharts();

    if (ctx.combined) {
      root.innerHTML = `<section class="card empty-card">
        <h3>Item analytics need a single site</h3>
        <p>Pick a single site in the header to see item analytics (prices in one currency).</p>
      </section>`;
      return;
    }

    // Whole-history index: measured invoices only, across ALL records for
    // this provider+account (never range-scoped — see file doc comment).
    const index = ItemStats.buildItemIndex(ctx.records);
    assignEntryKeys(index);
    if (!ctx.model || !index.length) {
      root.innerHTML = `<section class="card empty-card">
        <h3>No detailed invoices yet</h3>
        <p>No detailed invoices yet — use Fetch data on the Orders view to pull item-level details.
        Item analytics appear as soon as the first full invoice is saved.</p>
      </section>`;
      return;
    }

    const inflation = ItemStats.computePersonalInflation(index, ctx.now);
    const measuredInvoices = new Set();
    index.forEach((entry) => entry.purchases.forEach((p) => measuredInvoices.add(p.orderNumber)));
    const invoiceCount = measuredInvoices.size;

    root.innerHTML = `${heroHtml(ctx, inflation)}
      <section class="card" id="itemsListCard">
        <h2>Every item you've bought</h2>
        <div class="sub">All time, from ${invoiceCount} measured invoice${invoiceCount === 1 ? '' : 's'} —
          this view always uses your full history, not the date range above.</div>
        <div class="items-toolbar">
          <label class="search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="search" id="itemsSearchInput" placeholder="Filter items — e.g. &quot;milk&quot;" aria-label="Filter items">
          </label>
          <select class="scope-select" id="itemsSortSelect" aria-label="Sort items by">
            <option value="spent">Total spent</option>
            <option value="bought">Times bought</option>
            <option value="change">Price change</option>
            <option value="name">A–Z</option>
            <option value="last">Last price</option>
          </select>
          <span class="items-count"><span id="itemsShownCount"></span> · ${index.length} distinct item${index.length === 1 ? '' : 's'} across ${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'}</span>
        </div>
        <div class="table-wrap">
          <table class="items-table">
            <thead><tr>
              <th>Item</th><th class="num">Bought</th><th class="num">Total spent</th>
              <th class="num">Avg price</th><th class="num">Last price</th>
              <th class="num">Change</th><th>History</th>
            </tr></thead>
            <tbody id="itemsRows"></tbody>
          </table>
        </div>
      </section>`;

    const searchInput = root.querySelector('#itemsSearchInput');
    searchInput.value = viewState.search;
    searchInput.addEventListener('input', () => {
      viewState.search = searchInput.value;
      destroyCharts();
      renderTableBody(ctx, root, index);
    });

    const sortSelect = root.querySelector('#itemsSortSelect');
    sortSelect.value = viewState.sort;
    sortSelect.addEventListener('change', () => {
      viewState.sort = sortSelect.value;
      destroyCharts();
      renderTableBody(ctx, root, index);
    });

    // Row click → expand/collapse the purchase-history detail (delegated —
    // the tbody re-renders often). Clicks on interactive elements pass through.
    root.querySelector('#itemsRows').addEventListener('click', (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      if (target.closest('input, label, button, a, select')) return;
      const row = target.closest('tr.item-row');
      if (!row) return;
      const key = row.dataset.key || '';
      if (viewState.expanded.has(key)) {
        viewState.expanded.delete(key);
        const next = row.nextElementSibling;
        if (next && next.classList.contains('items-detail-row')) {
          if (next._wieChart) {
            try { next._wieChart.destroy(); } catch (_) { /* already torn down */ }
            charts = charts.filter((chart) => chart !== next._wieChart);
          }
          next.remove();
        }
        row.classList.remove('expanded');
        row.setAttribute('aria-expanded', 'false');
        return;
      }
      viewState.expanded.add(key);
      const entry = index.find((candidate) => entryKey(candidate) === key);
      if (entry) insertDetailRow(ctx, row, entry);
    });

    renderTableBody(ctx, root, index);
  }

  WIEDash.registerView('items', { render });
})();
