/**
 * Trends view (#/trends) for the full-page dashboard.
 *
 * Registers with the WIEDash view registry (dashboard.page.js) and renders
 * long-horizon spending trends into #viewTrends from the pure TrendStats
 * computations (dashboard.trendstats.js). Charts use the vendored Chart.js
 * (ctx.Chart) with colors resolved from the CSS design tokens at render time
 * — both themes come free; when Chart.js is unavailable every chart card
 * falls back to a text/table summary, never a blank card.
 *
 * render() is idempotent: every Chart.js instance created here is tracked
 * and destroy()ed at the top of the next render before innerHTML rebuilds.
 * The registry only calls render() while the view is visible AND its data
 * changed, so canvases are never sized inside a display:none container.
 */
(() => {
  'use strict';

  if (typeof WIEDash === 'undefined' || typeof TrendStats === 'undefined') return;

  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /** Live Chart.js instances from the previous render (destroyed on re-render). */
  const liveCharts = [];

  function destroyCharts() {
    while (liveCharts.length) {
      const chart = liveCharts.pop();
      try { chart.destroy(); } catch (_) { /* already torn down */ }
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

  /** All token-derived colors, read at render time so theme flips apply. */
  function readColors() {
    return {
      accent: cssVar('--accent', '#3b82f6'),
      accentWeak: cssVar('--accent-weak', '#dbeafe'),
      bar: cssVar('--bar', '#c7d7f2'),
      barHover: cssVar('--bar-hover', '#a3c0e8'),
      border: cssVar('--border', '#e5e7eb'),
      borderStrong: cssVar('--border-strong', '#d1d5db'),
      muted: cssVar('--text-muted', '#6b7280'),
      surface: cssVar('--surface', '#ffffff'),
      success: cssVar('--success-fg', '#146c2e'),
      warn: cssVar('--warn-fg', '#856404'),
      danger: cssVar('--danger-fg', '#c4291f'),
    };
  }

  /** Chart x-axis label: "Jul", or "Jul '25" when the chart spans years. */
  function shortMonth(month, spansYears) {
    const name = MONTHS_SHORT[Number(month.slice(5, 7)) - 1] || month;
    return spansYears ? `${name} '${month.slice(2, 4)}` : name;
  }

  /** Options shared by every chart here (a11y + reduced-motion + typography). */
  function baseOptions() {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return {
      responsive: true,
      maintainAspectRatio: false,
      ...(reduce ? { animation: false } : {}),
      plugins: { legend: { display: false } }, // legends are our own HTML (escaped, token-styled)
    };
  }

  /** Inherit the page's font stack instead of Chart.js's default. */
  function pageFont() {
    try {
      return { family: getComputedStyle(document.body).fontFamily };
    } catch (_) {
      return {};
    }
  }

  /** Standard money y-axis + label x-axis scales. */
  function moneyScales(ctx, colors, font) {
    return {
      x: { grid: { display: false }, ticks: { color: colors.muted, font } },
      y: {
        beginAtZero: true,
        grid: { color: colors.border },
        ticks: { color: colors.muted, font, callback: (value) => ctx.formatMoney(value) },
      },
    };
  }

  /** Count y-axis (integer ticks) + label x-axis scales. */
  function countScales(colors, font) {
    return {
      x: { grid: { display: false }, ticks: { color: colors.muted, font } },
      y: {
        beginAtZero: true,
        grid: { color: colors.border },
        ticks: { color: colors.muted, font, precision: 0 },
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * HTML builders (every interpolated string passes through ctx.escapeHtml)
   * ------------------------------------------------------------------ */

  /** One .card shell; `bodyHtml` is caller-built (and already escaped). */
  function cardHtml(title, sub, bodyHtml, esc) {
    return `<section class="card">
      <h2>${esc(title)}</h2>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
      ${bodyHtml}
    </section>`;
  }

  /** A fixed-height chart wrapper with a keyed canvas. */
  function chartBoxHtml(key, ariaLabel, esc) {
    return `<div class="trend-chart"><canvas data-trend="${esc(key)}" role="img" aria-label="${esc(ariaLabel)}"></canvas></div>`;
  }

  /** Compact label/value fallback rows (Chart.js unavailable). */
  function rowsHtml(rows, esc) {
    return `<div class="trend-rows">${rows
      .map(([label, value]) => `<div class="trend-row"><span>${esc(label)}</span><span class="mono">${esc(value)}</span></div>`)
      .join('')}</div>`;
  }

  /** Color-chip legend rows (identity is never color-alone). */
  function legendHtml(entries, esc) {
    return `<ul class="trend-legend">${entries
      .map((entry) => `<li><span class="tl-chip" style="background:${esc(entry.color)}"></span>` +
        `<span class="tl-name">${esc(entry.name)}</span>` +
        (entry.meta ? `<span class="tl-meta">${esc(entry.meta)}</span>` : '') +
        `</li>`)
      .join('')}</ul>`;
  }

  const emptyNote = (text, esc) => `<div class="trend-empty">${esc(text)}</div>`;

  /* ------------------------------------------------------------------ *
   * Calendar heatmap (pure DOM/CSS — no Chart.js involved)
   * ------------------------------------------------------------------ */

  /**
   * GitHub-style 53×7 CSS-grid heatmap of the last 365 days. Cells carry a
   * title tooltip (date + total + order count); intensity is one of 4
   * accent levels mixed in view-trends.css via color-mix.
   */
  function heatmapHtml(ctx, heat) {
    const esc = ctx.escapeHtml;
    const pad = (n) => String(n).padStart(2, '0');
    const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    const byDate = new Map(heat.days.map((day) => [day.date, day]));
    const end = new Date(ctx.now.getFullYear(), ctx.now.getMonth(), ctx.now.getDate());
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 364);
    const startIso = isoOf(start);
    // Column pitch = 11px cell + 2px gap (view-trends.css) — month labels
    // are positioned in px off the same pitch.
    const PITCH = 13;
    const gridStart = new Date(start);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay()); // back to Sunday

    let cells = '';
    let monthLabels = '';
    let column = -1;
    let lastLabeledMonth = -1;
    let lastLabelColumn = -10;
    for (const cursor = new Date(gridStart); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
      const dow = cursor.getDay();
      if (dow === 0) {
        column += 1;
        const monthIndex = cursor.getMonth();
        // Label the column whose first day starts a new month — but never
        // two labels within 3 columns of each other (they would collide).
        if (monthIndex !== lastLabeledMonth && column - lastLabelColumn >= 3) {
          monthLabels += `<span style="left:${column * PITCH}px">${esc(MONTHS_SHORT[monthIndex])}</span>`;
          lastLabeledMonth = monthIndex;
          lastLabelColumn = column;
        }
      }
      const iso = isoOf(cursor);
      if (iso < startIso) {
        // Alignment padding before the 365-day window starts.
        cells += '<span class="hm-cell hm-pad" aria-hidden="true"></span>';
        continue;
      }
      const entry = byDate.get(iso);
      if (!entry) {
        cells += `<span class="hm-cell hm-l0" title="${esc(`${iso} · no orders`)}"></span>`;
        continue;
      }
      // 4 intensity levels over the busiest day's total; a day whose money
      // didn't resolve (total 0 but orders exist) still shows at level 1.
      const level = heat.maxTotal > 0 && entry.total > 0
        ? Math.min(4, Math.max(1, Math.ceil((entry.total / heat.maxTotal) * 4)))
        : 1;
      const title = `${iso} · ${ctx.formatMoney(entry.total)} · ${entry.count} order${entry.count === 1 ? '' : 's'}`;
      cells += `<span class="hm-cell hm-l${level}" title="${esc(title)}"></span>`;
    }

    const dayLabels = ['', 'Mon', '', 'Wed', '', 'Fri', '']
      .map((label) => `<span>${esc(label)}</span>`)
      .join('');

    return `<div class="hm-scroll">
      <div class="hm-wrap">
        <div class="hm-months">${monthLabels}</div>
        <div class="hm-body">
          <div class="hm-daylabels" aria-hidden="true">${dayLabels}</div>
          <div class="hm-grid">${cells}</div>
        </div>
      </div>
    </div>`;
  }

  /* ------------------------------------------------------------------ *
   * Render
   * ------------------------------------------------------------------ */

  function render(ctx) {
    const root = document.getElementById('viewTrends');
    if (!root) return;
    destroyCharts();
    const esc = ctx.escapeHtml;

    // Combined multi-currency mode: trend money can't mix currencies.
    if (ctx.combined) {
      root.innerHTML = cardHtml(
        'Trends',
        '',
        `<p class="trend-note">Pick a single site in the header to see trends (one currency at a time).</p>`,
        esc
      );
      return;
    }
    // Empty / nothing-measured mode (ctx.model is null).
    if (!ctx.model) {
      root.innerHTML = cardHtml(
        'Trends',
        '',
        `<p class="trend-note">No measured invoices yet — Fetch data on the Orders view unlocks trends.</p>`,
        esc
      );
      return;
    }

    const now = ctx.now;
    const records = ctx.records;
    const ranged = ctx.recordsInRange(now);
    const rangeEcho = ctx.rangeLabel(ctx.range, now);
    const hasChartJs = typeof ctx.Chart === 'function';

    const cumulative = TrendStats.cumulativeByMonth(records, ctx.range, now);
    const yoy = TrendStats.yearOverYear(records, now);
    const heat = TrendStats.calendarHeatmap(records, now);
    const split = foldSplit(TrendStats.fulfillmentSplit(ranged), 4);
    const sizes = TrendStats.orderSizeHistogram(ranged);
    const weekdays = TrendStats.dayOfWeekPattern(ranged);
    const composition = TrendStats.moneyComposition(records, ctx.range, now);

    const colors = readColors();
    const yoyColors = yearColors(yoy.years, now, colors);
    const splitColors = [colors.accent, colors.warn, colors.success, colors.muted, colors.barHover];
    // Fixed series order + fixed token colors — never cycled, never rank-based.
    const compositionSeries = [
      { key: 'subtotal', label: 'Items', color: colors.bar },
      { key: 'tax', label: 'Tax', color: colors.warn },
      { key: 'tip', label: 'Tips', color: colors.barHover },
      { key: 'fees', label: 'Fees', color: colors.danger },
      { key: 'savings', label: 'Savings', color: colors.success },
    ].filter((series) => composition.some((entry) => Math.abs(entry[series.key]) >= 0.005));

    const html = [];

    // 1. Cumulative spend (range-scoped).
    html.push(cardHtml(
      `Cumulative spend · ${rangeEcho}`,
      'Running total of measured invoices, month by month.',
      cumulative.length
        ? (hasChartJs
          ? chartBoxHtml('cumulative', `Cumulative spend, ${rangeEcho}`, esc)
          : rowsHtml(
            cumulative.slice(-12).map((entry) => [ctx.monthLabel(entry.month), ctx.formatMoney(entry.cumulative)]),
            esc
          ))
        : emptyNote('No measured invoices in this range yet.', esc),
      esc
    ));

    // 2. Year over year (ALL records, by design).
    html.push(cardHtml(
      'Year over year',
      'All time — every measured invoice, regardless of the range picked above.',
      yoy.years.length
        ? (hasChartJs ? chartBoxHtml('yoy', 'Year-over-year monthly spend', esc) : '') +
          legendHtml(
            yoy.years.map((entry, index) => ({
              color: yoyColors[index],
              name: String(entry.year),
              meta: `${ctx.formatMoney(entry.total)} total`,
            })),
            esc
          )
        : emptyNote('No measured invoices yet.', esc),
      esc
    ));

    // 3. Shopping days heatmap (last 365 days; pure DOM/CSS).
    html.push(cardHtml(
      'Shopping days',
      'The last 12 months of measured orders — darker means more spent that day.',
      heat.days.length
        ? heatmapHtml(ctx, heat)
        : emptyNote('No measured orders in the last 12 months.', esc),
      esc
    ));

    // 4. How you shop (fulfillment split, range-scoped).
    html.push(cardHtml(
      `How you shop · ${rangeEcho}`,
      'Split orders share their total evenly across their fulfillment types.',
      split.length
        ? (hasChartJs ? chartBoxHtml('split', 'Orders by fulfillment type', esc) : '') +
          legendHtml(
            split.map((entry, index) => ({
              color: splitColors[index % splitColors.length],
              name: entry.type,
              meta: `${entry.count} order${entry.count === 1 ? '' : 's'} · ${ctx.formatMoney(entry.total)}`,
            })),
            esc
          )
        : emptyNote('No measured invoices in this range yet.', esc),
      esc
    ));

    // 5. Order sizes + by day of week, side by side (range-scoped).
    const sizesBody = sizes.some((bucket) => bucket.count > 0)
      ? (hasChartJs
        ? chartBoxHtml('sizes', 'Order count by order size', esc)
        : rowsHtml(sizes.map((bucket) => [bucket.label, `${bucket.count} order${bucket.count === 1 ? '' : 's'}`]), esc))
      : emptyNote('No measured invoices in this range yet.', esc);
    const weekdayBody = weekdays.some((day) => day.count > 0)
      ? (hasChartJs
        ? chartBoxHtml('weekday', 'Order count by day of week', esc)
        : rowsHtml(weekdays.map((day) => [day.day, `${day.count} · ${ctx.formatMoney(day.total)}`]), esc))
      : emptyNote('No measured invoices in this range yet.', esc);
    html.push(`<div class="trend-duo">
      ${cardHtml(`Order sizes · ${rangeEcho}`, 'How big your orders run.', sizesBody, esc)}
      ${cardHtml(`By day of week · ${rangeEcho}`, 'When you shop.', weekdayBody, esc)}
    </div>`);

    // 6. Where each dollar went (stacked composition, range-scoped). The
    // card is skipped entirely when only the Items series has data — a
    // one-series stack says nothing the cumulative chart doesn't.
    const hasBreakdown = compositionSeries.some((series) => series.key !== 'subtotal');
    if (composition.length && hasBreakdown) {
      html.push(cardHtml(
        `Where each dollar went · ${rangeEcho}`,
        'Items, tax, tips, fees, and savings per month.',
        (hasChartJs ? chartBoxHtml('composition', 'Monthly spend composition', esc) : '') +
          legendHtml(
            compositionSeries.map((series) => ({
              color: series.color,
              name: series.label,
              meta: ctx.formatMoney(composition.reduce((sum, entry) => sum + entry[series.key], 0)),
            })),
            esc
          ),
        esc
      ));
    }

    root.innerHTML = html.join('');
    if (!hasChartJs) return;

    // Chart.js instantiation — one failure downgrades that card's canvas to
    // nothing rather than killing the whole view.
    const canvasOf = (key) => root.querySelector(`canvas[data-trend="${key}"]`);
    const builders = [
      () => buildCumulativeChart(ctx, colors, canvasOf('cumulative'), cumulative),
      () => buildYoyChart(ctx, colors, yoyColors, canvasOf('yoy'), yoy.years, now),
      () => buildSplitChart(ctx, colors, splitColors, canvasOf('split'), split),
      () => buildSizesChart(ctx, colors, canvasOf('sizes'), sizes),
      () => buildWeekdayChart(ctx, colors, canvasOf('weekday'), weekdays),
      () => buildCompositionChart(ctx, colors, canvasOf('composition'), composition, compositionSeries),
    ];
    builders.forEach((build) => {
      try {
        const chart = build();
        if (chart) liveCharts.push(chart);
      } catch (error) {
        console.warn('Trends view: chart failed to render:', error);
      }
    });
  }

  /** Keep the top `max` fulfillment types; fold the rest into "Other". */
  function foldSplit(split, max) {
    if (split.length <= max + 1) return split;
    const kept = split.slice(0, max);
    const folded = split.slice(max).reduce(
      (accumulator, entry) => ({
        type: 'Other',
        count: accumulator.count + entry.count,
        total: Math.round((accumulator.total + entry.total) * 100) / 100,
      }),
      { type: 'Other', count: 0, total: 0 }
    );
    return [...kept, folded];
  }

  /** Accent for the current year; muted blue/gray tokens for prior years. */
  function yearColors(years, now, colors) {
    // Three distinct prior tokens: with ≤3 years total, no two lines can
    // ever share a color even when the current year has no data yet.
    const priors = [colors.barHover, colors.borderStrong, colors.muted];
    let priorIndex = years.filter((entry) => entry.year !== now.getFullYear()).length - 1;
    return years.map((entry) => {
      if (entry.year === now.getFullYear()) return colors.accent;
      const color = priors[Math.min(priorIndex, priors.length - 1)] || colors.borderStrong;
      priorIndex -= 1;
      return color;
    });
  }

  /* ------------------------------------------------------------------ *
   * Chart builders (all return a Chart instance or null)
   * ------------------------------------------------------------------ */

  function buildCumulativeChart(ctx, colors, canvas, cumulative) {
    if (!canvas) return null;
    const font = pageFont();
    const spansYears = cumulative.length > 1 &&
      cumulative[0].month.slice(0, 4) !== cumulative[cumulative.length - 1].month.slice(0, 4);
    return new ctx.Chart(canvas, {
      type: 'line',
      data: {
        labels: cumulative.map((entry) => shortMonth(entry.month, spansYears)),
        datasets: [{
          data: cumulative.map((entry) => entry.cumulative),
          borderColor: colors.accent,
          backgroundColor: colors.accentWeak, // the subtle accent tint token
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: colors.accent,
          fill: true,
          tension: 0.25,
        }],
      },
      options: {
        ...baseOptions(),
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            titleFont: font,
            bodyFont: font,
            callbacks: {
              title: (items) => ctx.monthLabel(cumulative[items[0].dataIndex].month),
              label: (item) => {
                const entry = cumulative[item.dataIndex];
                return `${ctx.formatMoney(entry.cumulative)} total · +${ctx.formatMoney(entry.total)} this month`;
              },
            },
          },
        },
        scales: moneyScales(ctx, colors, font),
      },
    });
  }

  function buildYoyChart(ctx, colors, yoyColors, canvas, years, now) {
    if (!canvas) return null;
    const font = pageFont();
    const nowYear = now.getFullYear();
    const nowMonthIndex = now.getMonth();
    return new ctx.Chart(canvas, {
      type: 'line',
      data: {
        labels: MONTHS_SHORT.slice(),
        datasets: years.map((entry, index) => ({
          label: String(entry.year),
          // The current year's line stops at the current month instead of
          // plunging to zero through months that haven't happened yet.
          data: entry.monthly.map((value, monthIndex) =>
            entry.year === nowYear && monthIndex > nowMonthIndex ? null : value),
          borderColor: yoyColors[index],
          backgroundColor: yoyColors[index],
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          spanGaps: false,
          tension: 0.25,
        })),
      },
      options: {
        ...baseOptions(),
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            titleFont: font,
            bodyFont: font,
            callbacks: {
              label: (item) => `${item.dataset.label}: ${ctx.formatMoney(item.parsed.y)}`,
            },
          },
        },
        scales: moneyScales(ctx, colors, font),
      },
    });
  }

  function buildSplitChart(ctx, colors, splitColors, canvas, split) {
    if (!canvas) return null;
    const font = pageFont();
    return new ctx.Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: split.map((entry) => entry.type),
        datasets: [{
          data: split.map((entry) => entry.total),
          backgroundColor: split.map((_, index) => splitColors[index % splitColors.length]),
          // 2px surface gap between segments so adjacent fills never touch.
          borderColor: colors.surface,
          borderWidth: 2,
        }],
      },
      options: {
        ...baseOptions(),
        cutout: '62%',
        plugins: {
          legend: { display: false }, // the HTML legend lists count + total
          tooltip: {
            titleFont: font,
            bodyFont: font,
            callbacks: {
              label: (item) => {
                const entry = split[item.dataIndex];
                return `${entry.type}: ${ctx.formatMoney(entry.total)} · ${entry.count} order${entry.count === 1 ? '' : 's'}`;
              },
            },
          },
        },
      },
    });
  }

  function buildSizesChart(ctx, colors, canvas, sizes) {
    if (!canvas) return null;
    const font = pageFont();
    return new ctx.Chart(canvas, {
      type: 'bar',
      data: {
        labels: sizes.map((bucket) => bucket.label),
        datasets: [{
          data: sizes.map((bucket) => bucket.count),
          backgroundColor: colors.accent,
          hoverBackgroundColor: colors.accent,
          borderRadius: 4,
          maxBarThickness: 46,
        }],
      },
      options: {
        ...baseOptions(),
        plugins: {
          legend: { display: false },
          tooltip: {
            titleFont: font,
            bodyFont: font,
            callbacks: {
              label: (item) => `${item.parsed.y} order${item.parsed.y === 1 ? '' : 's'}`,
            },
          },
        },
        scales: countScales(colors, font),
      },
    });
  }

  function buildWeekdayChart(ctx, colors, canvas, weekdays) {
    if (!canvas) return null;
    const font = pageFont();
    return new ctx.Chart(canvas, {
      type: 'bar',
      data: {
        labels: weekdays.map((day) => day.day),
        datasets: [{
          data: weekdays.map((day) => day.count),
          backgroundColor: colors.accent,
          hoverBackgroundColor: colors.accent,
          borderRadius: 4,
          maxBarThickness: 46,
        }],
      },
      options: {
        ...baseOptions(),
        plugins: {
          legend: { display: false },
          tooltip: {
            titleFont: font,
            bodyFont: font,
            callbacks: {
              title: (items) => DAY_LONG[items[0].dataIndex] || items[0].label,
              label: (item) => {
                const day = weekdays[item.dataIndex];
                return `${day.count} order${day.count === 1 ? '' : 's'} · ${ctx.formatMoney(day.total)}`;
              },
            },
          },
        },
        scales: countScales(colors, font),
      },
    });
  }

  function buildCompositionChart(ctx, colors, canvas, composition, compositionSeries) {
    if (!canvas) return null;
    const font = pageFont();
    const spansYears = composition.length > 1 &&
      composition[0].month.slice(0, 4) !== composition[composition.length - 1].month.slice(0, 4);
    return new ctx.Chart(canvas, {
      type: 'bar',
      data: {
        labels: composition.map((entry) => shortMonth(entry.month, spansYears)),
        datasets: compositionSeries.map((series) => ({
          label: series.label,
          data: composition.map((entry) => entry[series.key]),
          backgroundColor: series.color,
          hoverBackgroundColor: series.color,
          // 1px surface seam between stacked segments (2px doubles up
          // where two segments meet).
          borderColor: colors.surface,
          borderWidth: 1,
          maxBarThickness: 46,
        })),
      },
      options: {
        ...baseOptions(),
        plugins: {
          legend: { display: false }, // the HTML legend below carries identity
          tooltip: {
            titleFont: font,
            bodyFont: font,
            callbacks: {
              title: (items) => ctx.monthLabel(composition[items[0].dataIndex].month),
              label: (item) => `${item.dataset.label}: ${ctx.formatMoney(item.parsed.y)}`,
            },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: colors.muted, font } },
          y: {
            stacked: true,
            beginAtZero: true,
            grid: { color: colors.border },
            ticks: { color: colors.muted, font, callback: (value) => ctx.formatMoney(value) },
          },
        },
      },
    });
  }

  WIEDash.registerView('trends', { render });
})();
