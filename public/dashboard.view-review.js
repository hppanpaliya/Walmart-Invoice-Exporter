/**
 * "Year in review" dashboard view (#/review) — a Spotify-Wrapped-style
 * annual summary computed 100% locally from the user's own invoices.
 *
 * Two parts:
 *  (a) ReviewStats — pure, DOM-free yearly aggregation (yearsAvailable /
 *      computeYearReview), exported as a global so the node vm test sandbox
 *      can unit-test it. Depends on the shared globals that load before this
 *      file in dashboard.html: parseNumericValue + CONSTANTS (utils.js) and
 *      dashboardRecordDate (sidepanel.dashboard.js).
 *  (b) The view module — registers with the WIEDash view registry
 *      (dashboard.page.js) and renders into #viewReview. Everything is
 *      computed on-device from the ctx records (already provider- and
 *      account-scoped); no fetch(), no telemetry, no OrderDb reads.
 */

/* ------------------------------------------------------------------ *
 * (a) ReviewStats — pure yearly aggregation (no DOM)
 * ------------------------------------------------------------------ */
(() => {
  'use strict';

  /** Day-of-week names in Date#getDay order (same list dashboard.page.js uses). */
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /** Round a money value to cents (floating-point sums drift otherwise). */
  function round(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  /**
   * Whether a record carries a measured (schema-current) invoice — the same
   * rule computeDashboardStats follows: pre-v3 invoices count as not
   * downloaded, so summary-only orders never pollute the money numbers.
   */
  function isMeasured(record) {
    const invoice = record && record.invoice;
    return Boolean(invoice) && Number(invoice.schemaVersion || 0) >= CONSTANTS.ORDER_SCHEMA_VERSION;
  }

  /** Invoice→summary money fallback (mirrors dashboard.page.js's moneyOf). */
  function moneyOf(invoiceValue, summaryValue) {
    return parseNumericValue(invoiceValue) || parseNumericValue(summaryValue || '');
  }

  /**
   * A record's grand total: the invoice's own total when it has one, else
   * the purchase-history summary's (fast SSR-fetched invoices often lack the
   * price block — same fallback computeDashboardStats uses).
   */
  function totalOf(record) {
    const invoice = (record && record.invoice) || {};
    const summary = (record && record.summary) || {};
    return moneyOf(invoice.orderTotal, summary.orderTotal || record.orderTotal);
  }

  /** UTC day serial of a 'YYYY-MM-DD' date — timezone-proof day arithmetic. */
  function dayNumber(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  }

  /** Measured records paired with their resolved ISO date (undated dropped). */
  function measuredDated(records) {
    return (Array.isArray(records) ? records : [])
      .filter(isMeasured)
      .map((record) => ({ record, date: dashboardRecordDate(record) }))
      .filter((entry) => Boolean(entry.date));
  }

  /**
   * Years (descending) that have at least one measured, dated invoice —
   * the year pill-selector's option list.
   * @param {Array} records - OrderDb records
   * @returns {number[]}
   */
  function yearsAvailable(records) {
    const years = new Set();
    measuredDated(records).forEach(({ date }) => {
      const year = Number(date.slice(0, 4));
      if (year) years.add(year);
    });
    return [...years].sort((a, b) => b - a);
  }

  /**
   * The full year-in-review model for one calendar year. Only MEASURED
   * invoices count (with the summary money fallback above); money strings
   * like "$1,234.56" parse resiliently via parseNumericValue.
   *
   * @param {Array} records - OrderDb records (provider+account scoped)
   * @param {number|string} year - calendar year, e.g. 2026
   * @returns {{
   *   year: number,
   *   totalSpent: number, orderCount: number, itemCount: number, distinctItems: number,
   *   totalSaved: number, savingsRate: number|null,
   *   biggestOrder: {orderNumber: string, date: string, total: number}|null,
   *   busiestMonth: {month: string, count: number, total: number}|null,
   *   busiestDay: {name: string, count: number}|null,
   *   mostBought: {name: string, count: number}|null,
   *   topItemsBySpend: Array<{name: string, total: number}>,
   *   longestGapDays: {days: number, from: string, to: string}|null,
   *   avgDaysBetweenOrders: number|null,
   *   firstOrder: {date: string}|null, lastOrder: {date: string}|null,
   *   deliverySplit: Array<{type: string, count: number}>,
   *   refundTotal: number, tipTotal: number,
   *   prevYearTotal: number|null,
   *   months: Array<{month: string, count: number, total: number}> // 12, zero-filled
   * }}
   */
  function computeYearReview(records, year) {
    const yearNum = Number(year);
    const prefix = `${yearNum}-`;
    const prevPrefix = `${yearNum - 1}-`;

    // Split measured+dated records into the review year and the prior year
    // (the latter only feeds the "vs YEAR-1" comparison).
    const inYear = [];
    let prevCount = 0;
    let prevTotal = 0;
    measuredDated(records).forEach((entry) => {
      if (entry.date.startsWith(prefix)) {
        inYear.push(entry);
      } else if (entry.date.startsWith(prevPrefix)) {
        prevCount += 1;
        prevTotal += totalOf(entry.record);
      }
    });

    let totalSpent = 0;
    let totalSaved = 0;
    let refundTotal = 0;
    let tipTotal = 0;
    let itemCount = 0;
    let biggestOrder = null;
    const itemsByKey = new Map(); // lowercased name -> {name, count, total}
    const monthBuckets = new Map(); // 'YYYY-MM' -> {count, total}
    const dayCounts = [0, 0, 0, 0, 0, 0, 0];
    const deliveryCounts = new Map(); // type label -> count

    inYear.forEach(({ record, date }) => {
      const invoice = record.invoice || {};
      const summary = record.summary || {};
      const total = totalOf(record);

      totalSpent += total;
      totalSaved += moneyOf(invoice.savings, summary.savings);
      refundTotal += moneyOf(invoice.refund, summary.refund);
      tipTotal += moneyOf(invoice.tip, summary.driverTip);

      // Biggest order; ties break to the EARLIER date so the result never
      // depends on record order.
      if (total && (!biggestOrder || total > biggestOrder.total ||
          (total === biggestOrder.total && date < biggestOrder.date))) {
        biggestOrder = { orderNumber: String(record.orderNumber || ''), date, total: round(total) };
      }

      const month = date.slice(0, 7);
      const bucket = monthBuckets.get(month) || { count: 0, total: 0 };
      bucket.count += 1;
      bucket.total += total;
      monthBuckets.set(month, bucket);

      const day = new Date(`${date}T00:00:00`).getDay();
      if (day >= 0 && day <= 6) dayCounts[day] += 1;

      const type = invoice.isInStore ? 'In-store' : (String(invoice.orderType || '').trim() || 'Other');
      deliveryCounts.set(type, (deliveryCounts.get(type) || 0) + 1);

      // Items: invoice line items (blank quantity counts as 1, exactly like
      // computeDashboardStats). Measured invoices without stored line items
      // fall back to the summary's item count for the year total only.
      const rawItems = Array.isArray(invoice.items) ? invoice.items : [];
      if (rawItems.length) {
        rawItems.forEach((item) => {
          const name = String((item && item.productName) || '').trim();
          const qty = item && item.quantity !== null && item.quantity !== undefined && item.quantity !== ''
            ? parseNumericValue(item.quantity)
            : 1;
          itemCount += qty;
          if (!name) return;
          const key = name.toLowerCase();
          let entry = itemsByKey.get(key);
          if (!entry) {
            entry = { name, count: 0, total: 0 };
            itemsByKey.set(key, entry);
          }
          entry.count += qty;
          entry.total += parseNumericValue(item && item.price);
        });
      } else {
        itemCount += parseNumericValue(summary.itemCount);
      }
    });

    // Order-date cadence: first/last order, longest gap, average spacing.
    const dates = inYear.map((entry) => entry.date).sort();
    const firstOrder = dates.length ? { date: dates[0] } : null;
    const lastOrder = dates.length ? { date: dates[dates.length - 1] } : null;
    let longestGapDays = null;
    for (let i = 1; i < dates.length; i += 1) {
      const days = dayNumber(dates[i]) - dayNumber(dates[i - 1]);
      if (days >= 1 && (!longestGapDays || days > longestGapDays.days)) {
        longestGapDays = { days, from: dates[i - 1], to: dates[i] };
      }
    }
    const avgDaysBetweenOrders = dates.length >= 2
      ? Math.round(((dayNumber(dates[dates.length - 1]) - dayNumber(dates[0])) / (dates.length - 1)) * 10) / 10
      : null;

    // Busiest month: most orders; ties break to the higher total, then the
    // earlier month — deterministic regardless of input order.
    let busiestRaw = null;
    [...monthBuckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([month, bucket]) => {
        if (!busiestRaw || bucket.count > busiestRaw.count ||
            (bucket.count === busiestRaw.count && bucket.total > busiestRaw.total)) {
          busiestRaw = { month, count: bucket.count, total: bucket.total };
        }
      });
    const busiestMonth = busiestRaw
      ? { month: busiestRaw.month, count: busiestRaw.count, total: round(busiestRaw.total) }
      : null;

    const maxDay = Math.max.apply(null, dayCounts);
    const busiestDay = maxDay > 0
      ? { name: DAY_NAMES[dayCounts.indexOf(maxDay)] || '', count: maxDay }
      : null;

    // Most-bought item by summed quantity; ties break alphabetically.
    let mostBought = null;
    itemsByKey.forEach((entry) => {
      if (!mostBought || entry.count > mostBought.count ||
          (entry.count === mostBought.count && entry.name.localeCompare(mostBought.name) < 0)) {
        mostBought = { name: entry.name, count: entry.count };
      }
    });

    const topItemsBySpend = [...itemsByKey.values()]
      .filter((entry) => entry.total > 0)
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
      .slice(0, 5)
      .map((entry) => ({ name: entry.name, total: round(entry.total) }));

    const deliverySplit = [...deliveryCounts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

    // 12 zero-filled month buckets — the "How your year moved" chart data.
    const pad = (n) => String(n).padStart(2, '0');
    const months = [];
    for (let m = 1; m <= 12; m += 1) {
      const key = `${yearNum}-${pad(m)}`;
      const bucket = monthBuckets.get(key) || { count: 0, total: 0 };
      months.push({ month: key, count: bucket.count, total: round(bucket.total) });
    }

    // "Saved" is only meaningful as money kept — floor at zero, same rule as
    // the Overview's Saved card. savingsRate = saved / (spent + saved).
    const spent = round(totalSpent);
    const saved = Math.max(0, round(totalSaved));
    const savingsBase = spent + saved;

    return {
      year: yearNum,
      totalSpent: spent,
      orderCount: inYear.length,
      itemCount,
      distinctItems: itemsByKey.size,
      totalSaved: saved,
      savingsRate: savingsBase > 0 ? saved / savingsBase : null,
      biggestOrder,
      busiestMonth,
      busiestDay,
      mostBought,
      topItemsBySpend,
      longestGapDays,
      avgDaysBetweenOrders,
      firstOrder,
      lastOrder,
      deliverySplit,
      refundTotal: round(refundTotal),
      tipTotal: round(tipTotal),
      prevYearTotal: prevCount > 0 ? round(prevTotal) : null,
      months,
    };
  }

  // Global export — same guard style as sidepanel.dashboard.js's namespace:
  // works in the page (window === globalThis), workers, and the test vm.
  const root = typeof globalThis !== 'undefined' ? globalThis
    : typeof window !== 'undefined' ? window : self;
  root.ReviewStats = { yearsAvailable, computeYearReview };
})();

/* ------------------------------------------------------------------ *
 * (b) View module — renders #viewReview via the WIEDash registry
 * ------------------------------------------------------------------ */
(() => {
  'use strict';
  if (typeof WIEDash === 'undefined' || typeof document === 'undefined') return;

  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let selectedYear = null; // the year pills' current selection
  let yearsKey = ''; // last-seen years list — selection resets when it changes
  let lastCtx = null; // last render ctx, so pill clicks can re-render
  let chartInstance = null; // live Chart.js instance for the months chart

  /** Destroy the current Chart.js instance, if any (safe to call always). */
  function destroyChart() {
    if (chartInstance) {
      try { chartInstance.destroy(); } catch (_) { /* already torn down */ }
      chartInstance = null;
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

  /** "Mar 3" for a 'YYYY-MM-DD' date (year is implied by the review). */
  function dayLabel(iso) {
    const month = MONTHS_SHORT[Number(String(iso).slice(5, 7)) - 1];
    return month ? `${month} ${Number(String(iso).slice(8, 10))}` : String(iso || '');
  }

  /** "3 orders" / "1 order". */
  function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
  }

  /** "12%" / "7.5%" for a 0..1 savings rate (same shaping as More insights). */
  function percentLabel(rate) {
    const pct = rate * 100;
    return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
  }

  /** One superlative tile (mi-tile look, review-sized). Everything escaped. */
  function tileHtml(tile) {
    return `<div class="rv-tile">
      <div class="rv-label">${escapeHtml(tile.label)}</div>
      <div class="rv-value" title="${escapeHtml(tile.value)}">${escapeHtml(tile.value)}</div>
      <div class="rv-sub">${escapeHtml(tile.sub)}</div>
    </div>`;
  }

  /** The year pill-selector buttons (newest first, current one selected). */
  function yearPillsHtml(years) {
    return years
      .map((year) => `<button type="button" class="rv-year-pill${year === selectedYear ? ' selected' : ''}"
        data-year="${year}" aria-pressed="${year === selectedYear}">${year}</button>`)
      .join('');
  }

  /** The "How your year moved" chart: Chart.js when available, else SVG bars. */
  function renderMonthsChart(ctx, review) {
    const container = document.getElementById('rvChart');
    if (!container) return;
    const months = review.months;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (ctx.Chart) {
      try {
        container.classList.add('rv-chart-canvas');
        const canvas = document.createElement('canvas');
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `Monthly spend, ${review.year}`);
        container.appendChild(canvas);
        chartInstance = new ctx.Chart(canvas, {
          type: 'bar',
          data: {
            labels: MONTHS_SHORT,
            datasets: [{
              data: months.map((entry) => entry.total),
              backgroundColor: cssVar('--accent', '#3b82f6'),
              borderRadius: 4,
              maxBarThickness: 46,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: reduce ? false : { duration: 400 },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (context) => {
                    const entry = months[context.dataIndex] || { total: 0, count: 0 };
                    return `${ctx.formatMoney(entry.total)} · ${plural(entry.count, 'order')}`;
                  },
                },
              },
            },
            scales: {
              x: { grid: { display: false }, ticks: { color: cssVar('--text-muted', '#6b7280') } },
              y: {
                beginAtZero: true,
                grid: { color: cssVar('--border', '#e5e7eb') },
                ticks: { color: cssVar('--text-muted', '#6b7280'), callback: (value) => ctx.formatMoney(value) },
              },
            },
          },
        });
        return;
      } catch (error) {
        console.warn('Year in review: Chart.js render failed, using fallback bars:', error);
        destroyChart();
        container.classList.remove('rv-chart-canvas');
      }
    }

    // Fallback: inline SVG bars (no external assets; static, so motion-safe).
    const maxTotal = months.reduce((max, entry) => Math.max(max, entry.total), 0);
    const bars = months
      .map((entry, index) => {
        const height = maxTotal > 0 && entry.total > 0
          ? Math.max(3, Math.round((entry.total / maxTotal) * 100))
          : 0;
        const title = `${ctx.monthLabel(entry.month)}: ${ctx.formatMoney(entry.total)}, ${plural(entry.count, 'order')}`;
        return `<rect class="rv-svg-bar" x="${index * 40 + 4}" y="${100 - height}" width="32" height="${height}" rx="2">
          <title>${escapeHtml(title)}</title></rect>`;
      })
      .join('');
    container.innerHTML = `<svg viewBox="0 0 480 100" preserveAspectRatio="none" role="img"
        aria-label="${escapeHtml(`Monthly spend, ${review.year}`)}">${bars}</svg>
      <div class="rv-chart-months">${MONTHS_SHORT.map((name) => `<span>${name}</span>`).join('')}</div>`;
  }

  /** Full view render into #viewReview. */
  function render(ctx) {
    lastCtx = ctx;
    const slot = document.getElementById('viewReview');
    if (!slot) return;
    destroyChart();

    // Combined "All providers" mode mixes currencies — a single year total
    // would be meaningless, so ask for a single site instead.
    if (ctx.combined) {
      slot.innerHTML = `<section class="card empty-card">
        <h3>One site at a time</h3>
        <p>Pick a single site to build your year in review.</p>
      </section>`;
      return;
    }

    const years = ReviewStats.yearsAvailable(ctx.records);
    if (!years.length) {
      slot.innerHTML = `<section class="card empty-card">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
        </svg>
        <h3>Your year in review is waiting</h3>
        <p>Your review builds itself once invoices are fetched — try Fetch data on the Orders view.</p>
        <p><button type="button" class="btn btn-primary" id="rvGoOrdersBtn">Go to Orders</button></p>
      </section>`;
      const goBtn = document.getElementById('rvGoOrdersBtn');
      if (goBtn) goBtn.addEventListener('click', () => { location.hash = '#/orders'; });
      return;
    }

    // Default to the newest year; reset whenever the available list changes.
    const key = years.join(',');
    if (key !== yearsKey || !years.includes(selectedYear)) {
      yearsKey = key;
      selectedYear = years[0];
    }

    const review = ReviewStats.computeYearReview(ctx.records, selectedYear);
    const fm = ctx.formatMoney;

    // Header card: title, year pills, and the how-it-arrived chips.
    const splitChips = review.deliverySplit
      .map((entry) => `<span class="rv-chip">${escapeHtml(entry.type)} × ${entry.count}</span>`)
      .join('');
    const header = `<section class="card rv-head-card">
      <div class="rv-head">
        <div class="rv-head-text">
          <h2 class="rv-title">Your ${selectedYear} at Walmart</h2>
          <div class="sub">Computed from your own invoices, entirely on your device.</div>
        </div>
        <div class="rv-years" role="group" aria-label="Pick a year">${yearPillsHtml(years)}</div>
      </div>
      ${splitChips ? `<div class="rv-chips">${splitChips}</div>` : ''}
    </section>`;

    // Hero stat row. The delta chip only appears when the prior year has
    // measured spend to honestly compare against.
    let deltaChip = '';
    if (review.prevYearTotal !== null && review.prevYearTotal > 0) {
      const pct = Math.round(((review.totalSpent - review.prevYearTotal) / review.prevYearTotal) * 100);
      const up = pct >= 0;
      deltaChip = `<span class="rv-delta ${up ? 'rv-delta-up' : 'rv-delta-down'}">${up ? '↑' : '↓'} ${Math.abs(pct)}% vs ${selectedYear - 1}</span>`;
    }
    const heroTiles = [
      {
        cls: ' rv-hero-accent',
        label: 'Total spent',
        value: fm(review.totalSpent),
        chip: deltaChip,
        sub: `across ${plural(review.orderCount, 'order')}`,
      },
      {
        label: 'Orders',
        value: String(review.orderCount),
        sub: review.firstOrder && review.lastOrder
          ? `${dayLabel(review.firstOrder.date)} → ${dayLabel(review.lastOrder.date)}`
          : 'measured invoices',
      },
      {
        label: 'Items',
        value: Math.round(review.itemCount).toLocaleString('en-US'),
        sub: plural(review.distinctItems, 'distinct product'),
      },
      {
        label: 'Saved',
        value: fm(review.totalSaved),
        sub: review.savingsRate !== null
          ? `${percentLabel(review.savingsRate)} off the pre-discount total`
          : 'discounts & rollbacks',
      },
    ];
    const hero = `<section class="rv-hero">${heroTiles
      .map((tile) => `<div class="rv-hero-tile${tile.cls || ''}">
        <div class="rv-label">${escapeHtml(tile.label)}</div>
        <div class="rv-hero-value mono">${escapeHtml(tile.value)}${tile.chip || ''}</div>
        <div class="rv-sub">${escapeHtml(tile.sub)}</div>
      </div>`)
      .join('')}</section>`;

    // Superlatives — only tiles whose datum exists render.
    const superTiles = [];
    if (review.biggestOrder) {
      superTiles.push({
        label: 'Biggest order',
        value: fm(review.biggestOrder.total),
        sub: `${dayLabel(review.biggestOrder.date)} · order …${String(review.biggestOrder.orderNumber).slice(-8)}`,
      });
    }
    if (review.mostBought) {
      superTiles.push({
        label: 'Most bought',
        value: review.mostBought.name,
        sub: `× ${Math.round(review.mostBought.count)} across the year`,
      });
    }
    if (review.busiestMonth) {
      superTiles.push({
        label: 'Busiest month',
        value: ctx.monthLabel(review.busiestMonth.month),
        sub: `${plural(review.busiestMonth.count, 'order')} · ${fm(review.busiestMonth.total)}`,
      });
    }
    if (review.busiestDay) {
      superTiles.push({
        label: 'Busiest day',
        value: review.busiestDay.name,
        sub: `${plural(review.busiestDay.count, 'order')} placed`,
      });
    }
    if (review.longestGapDays) {
      superTiles.push({
        label: 'Longest Walmart-free streak',
        value: plural(review.longestGapDays.days, 'day'),
        sub: `${dayLabel(review.longestGapDays.from)} → ${dayLabel(review.longestGapDays.to)}`,
      });
    }
    if (review.avgDaysBetweenOrders !== null) {
      superTiles.push({
        label: 'Avg days between orders',
        value: `${review.avgDaysBetweenOrders} days`,
        sub: 'from one order to the next',
      });
    }
    superTiles.push({ label: 'Total tips', value: fm(review.tipTotal), sub: 'for delivery drivers' });
    if (review.refundTotal > 0) {
      superTiles.push({ label: 'Total refunded', value: fm(review.refundTotal), sub: 'came back to you' });
    }
    const superlatives = `<section class="card">
      <h2>Superlatives</h2>
      <div class="rv-super-grid">${superTiles.map(tileHtml).join('')}</div>
    </section>`;

    const top5 = `<section class="card">
      <h2>Top 5 by spend</h2>
      ${review.topItemsBySpend.length
        ? `<ol class="rv-top5">${review.topItemsBySpend
            .map((item, index) => `<li>
              <span class="rv-rank">${index + 1}</span>
              <span class="rv-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
              <span class="rv-total mono">${escapeHtml(fm(item.total))}</span>
            </li>`)
            .join('')}</ol>`
        : '<div class="rv-muted">No item-level prices measured this year yet.</div>'}
    </section>`;

    const chartCard = `<section class="card">
      <h2>How your year moved</h2>
      <div class="sub">Spend per month across ${selectedYear}.</div>
      <div class="rv-chart" id="rvChart"></div>
    </section>`;

    slot.innerHTML = header + hero + superlatives + top5 + chartCard;

    slot.querySelectorAll('.rv-year-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        const year = Number(pill.dataset.year);
        if (!year || year === selectedYear) return;
        selectedYear = year;
        if (lastCtx) render(lastCtx);
      });
    });

    renderMonthsChart(ctx, review);
  }

  WIEDash.registerView('review', { render });
})();
