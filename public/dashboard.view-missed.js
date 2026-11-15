/**
 * Missed items view (#/missed) — what was ordered but not received as
 * ordered. All math lives in dashboard.missedstats.js; this file only draws.
 * Scope: the header range (ctx.scopedRecords), like the Overview.
 */
(() => {
  'use strict';
  if (typeof WIEDash === 'undefined' || typeof MissedStats === 'undefined') return;

  const KIND_LABELS = {
    unavailable: { title: 'Unavailable', note: 'not charged', what: 'Unavailable' },
    canceled: { title: 'Canceled', note: 'not charged', what: 'Canceled' },
    substituted: { title: 'Substituted', note: 'you got a replacement', what: 'Substituted' },
    weightAdjusted: { title: 'Weight adjusted', note: 'charged by final weight', what: 'Weight adjusted' },
  };
  const plural = (count, singular) => `${count} ${singular}${count === 1 ? '' : 's'}`;

  function emptyState(root, icon, title, body) {
    root.innerHTML = `<section class="mis-empty"><span class="mis-empty-icon" aria-hidden="true">${icon}</span><h2>${title}</h2><p>${body}</p></section>`;
  }

  function tile(ctx, kind, total) {
    const esc = ctx.escapeHtml;
    const label = KIND_LABELS[kind];
    const charged = kind === 'substituted' || kind === 'weightAdjusted';
    const sub = total.lines === 0
      ? 'none'
      : charged ? label.note : `${ctx.formatMoney(total.value)} ${label.note}`;
    return `<div class="mis-tile${total.lines ? '' : ' mis-tile-zero'}">
      <span class="mis-tile-title">${esc(label.title)}</span>
      <strong class="mis-tile-value mono">${total.lines}</strong>
      <span class="mis-tile-note">${esc(total.lines ? `${plural(total.lines, 'line')} · ${sub}` : sub)}</span>
    </div>`;
  }

  function topTable(ctx, rows, showValue) {
    const esc = ctx.escapeHtml;
    if (!rows.length) return '';
    const body = rows.map((row) => `<tr>
      <td class="mis-name">${esc(row.name)}</td>
      <td class="num">${row.times}</td>
      <td class="num">${row.quantity}</td>
      ${showValue ? `<td class="num mono">${esc(ctx.formatMoney(row.value))}</td>` : ''}
      <td>${esc(row.lastDate || '')}</td>
    </tr>`).join('');
    return `<div class="mis-scroll"><table class="mis-table"><thead><tr><th>Product</th><th class="num">Times</th><th class="num">Qty</th>${showValue ? '<th class="num">Not charged</th>' : ''}<th>Last time</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function render(ctx) {
    const root = document.getElementById('viewMissed');
    if (!root) return;
    const esc = ctx.escapeHtml;
    if (ctx.combined) {
      emptyState(root, '◷', 'Choose one Walmart site', 'This view reads one site at a time. Pick a site in the header to see what went missing there.');
      return;
    }
    if (!ctx.model) {
      emptyState(root, '▤', 'This view starts with a full invoice', 'Fetch item details from the Orders view, then come back to see what was unavailable, canceled or substituted.');
      return;
    }

    const summary = MissedStats.buildMissedSummary(ctx.scopedRecords);
    const range = ctx.scopeEchoLabel(ctx.now);
    const without = summary.ordersMeasured - summary.ordersWithDetail;
    const coverage = without > 0
      ? `Based on ${summary.ordersWithDetail} of ${plural(summary.ordersMeasured, 'order')} in this range. The other ${without} ${without === 1 ? 'was' : 'were'} saved before this detail existed and ${without === 1 ? 'gains' : 'gain'} it the next time ${without === 1 ? 'it is' : 'they are'} exported or saved.`
      : `Based on all ${plural(summary.ordersMeasured, 'order')} in this range.`;

    if (summary.ordersWithDetail === 0) {
      emptyState(root, '◌', 'No orders here carry this detail yet',
        `${esc(coverage)} Select them in the Orders view and save or export them once.`);
      return;
    }

    const anything = MissedStats.KINDS.some((kind) => summary.totals[kind].lines > 0) || summary.lateDeliveries > 0;
    const tiles = MissedStats.KINDS.map((kind) => tile(ctx, kind, summary.totals[kind])).join('')
      + `<div class="mis-tile${summary.lateDeliveries ? '' : ' mis-tile-zero'}"><span class="mis-tile-title">Late deliveries</span><strong class="mis-tile-value mono">${summary.lateDeliveries}</strong><span class="mis-tile-note">${summary.lateDeliveries ? esc(plural(summary.lateDeliveries, 'order')) : 'none'}</span></div>`;

    const sections = [
      ['unavailable', 'Most often unavailable', true],
      ['canceled', 'Most often canceled', true],
      ['substituted', 'Most often substituted', false],
      ['weightAdjusted', 'Charged by final weight', false],
    ].filter(([kind]) => summary.top[kind].length > 0)
      .map(([kind, title, showValue]) => `<section class="card mis-card"><h2>${esc(title)}</h2>${topTable(ctx, summary.top[kind], showValue)}</section>`)
      .join('');

    const recentRows = summary.recent.map((event) => `<tr>
      <td>${esc(event.date || '')}</td>
      <td class="mis-name">${esc(event.name)}</td>
      <td><span class="mis-chip mis-chip-${esc(event.kind)}">${esc(KIND_LABELS[event.kind].what)}</span></td>
      <td class="num">${event.quantity}</td>
      <td class="num mono">${event.value ? esc(ctx.formatMoney(event.value)) : ''}</td>
    </tr>`).join('');
    const recent = summary.recent.length
      ? `<section class="card mis-card"><h2>Most recent</h2><div class="mis-scroll"><table class="mis-table"><thead><tr><th>Date</th><th>Product</th><th>What happened</th><th class="num">Qty</th><th class="num">Line price</th></tr></thead><tbody>${recentRows}</tbody></table></div></section>`
      : '';

    root.innerHTML = `<div class="mis-page">
      <section class="mis-intro">
        <div><span class="mis-kicker">ORDERED, NOT RECEIVED AS ORDERED</span><h1>What you didn't get</h1>
        <p>Items Walmart could not supply or canceled, items swapped for a substitute, and items charged by their final weight.</p></div>
        <div class="mis-period"><span class="mis-period-dot"></span><span>${esc(range)}</span></div>
      </section>
      <section class="mis-tiles">${tiles}</section>
      <p class="mis-coverage">${esc(coverage)}${summary.ordersAffected ? ` ${esc(plural(summary.ordersAffected, 'order'))} affected.` : ''}</p>
      ${anything ? sections + recent : '<section class="card mis-card mis-allgood"><h2>Nothing went missing</h2><p>Every line in these orders arrived as ordered.</p></section>'}
    </div>`;
  }

  WIEDash.registerView('missed', { render });
})();
