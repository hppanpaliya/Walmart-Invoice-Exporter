/**
 * Item-level purchase analytics for the dashboard Items view.
 *
 * PURE computation, no DOM — exposed as a single `ItemStats` global so both
 * dashboard.view-items.js and the node vm test sandbox can load it (like
 * utils.js). Depends on the shared globals from utils.js
 * (parseNumericValue, CONSTANTS) and sidepanel.dashboard.js
 * (dashboardRecordDate), which load before this file in every context
 * (dashboard index.html, tests/helpers/sandbox.js script list).
 */
(() => {
  'use strict';

  /** Round a money value to cents (floating-point sums drift otherwise). */
  const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

  /** Round a percentage to one decimal (rates are claims — keep them honest, not fake-precise). */
  const round1 = (value) => Math.round((Number(value) || 0) * 10) / 10;

  /**
   * Default measured-invoice predicate — same rule as computeDashboardStats:
   * only schema-current invoices are trusted (pre-v3 invoices can contain
   * doubled items / $0.00 prices). CONSTANTS is read lazily so the module
   * stays loadable in a sandbox where the load order differs.
   * @param {Object} record - OrderDb record
   * @returns {boolean}
   */
  function defaultIsMeasured(record) {
    const invoice = record && record.invoice;
    if (!invoice) return false;
    const minVersion =
      (typeof CONSTANTS !== 'undefined' && CONSTANTS && CONSTANTS.ORDER_SCHEMA_VERSION) || 3;
    return Number(invoice.schemaVersion || 0) >= minVersion;
  }

  /**
   * Aggregate every line item across MEASURED invoices into one entry per
   * distinct product. Items are keyed the same way computePriceHistory keys
   * them — usItemId when present, else the trimmed lowercased product name —
   * so the same product merges across invoices.
   *
   * Price stats (avg/first/last/min/max/percentChange) only consider
   * purchases with a computable positive unit price; unpriced purchases
   * (missing/"" price — the fast SSR-fetch invoice path stores those) still
   * count toward timesBought/totalQty so the buy history stays complete.
   *
   * @param {Array} records - OrderDb records ({orderNumber, invoice, ...})
   * @param {function(Object): boolean} [isMeasured] - measured-invoice predicate override
   * @returns {Array<{
   *   name: string,
   *   purchases: Array<{date: string, orderNumber: string, quantity: number, unitPrice: number, lineTotal: number}>,
   *   timesBought: number,
   *   totalQty: number,
   *   totalSpent: number,
   *   avgPrice: number,
   *   firstPrice: number,
   *   lastPrice: number,
   *   minPrice: number,
   *   maxPrice: number,
   *   percentChange: number|null
   * }>} sorted by totalSpent desc, name asc
   */
  function buildItemIndex(records, isMeasured) {
    const list = Array.isArray(records) ? records : [];
    const measured = typeof isMeasured === 'function' ? isMeasured : defaultIsMeasured;
    const byKey = new Map();

    list.forEach((record) => {
      if (!measured(record)) return;
      const invoice = record.invoice;
      if (!Array.isArray(invoice.items)) return;
      const date = dashboardRecordDate(record); // 'YYYY-MM-DD' or ''
      const orderNumber = String((record && record.orderNumber) || '');

      // Duplicate lines of the same item within one order merge into a
      // single purchase (summed qty + line total), mirroring how
      // computeDashboardStats / computePriceHistory treat an order as one
      // purchase event per item.
      const inOrder = new Map();
      invoice.items.forEach((item) => {
        const name = String((item && item.productName) || '').trim();
        const usItemId = String((item && item.usItemId) || '').trim();
        const key = usItemId || name.toLowerCase();
        if (!key) return;

        const rawQty = item && item.quantity;
        const quantity = rawQty === null || rawQty === undefined || rawQty === ''
          ? 1
          : parseNumericValue(rawQty);
        const lineTotal = parseNumericValue(item && item.price);

        let line = inOrder.get(key);
        if (!line) {
          line = { name, quantity: 0, lineTotal: 0 };
          inOrder.set(key, line);
        }
        if (!line.name && name) line.name = name;
        line.quantity += quantity;
        line.lineTotal += lineTotal;
      });

      inOrder.forEach((line, key) => {
        let entry = byKey.get(key);
        if (!entry) {
          entry = { name: line.name, purchases: [] };
          byKey.set(key, entry);
        }
        if (!entry.name && line.name) entry.name = line.name;
        const quantity = line.quantity;
        const lineTotal = round2(line.lineTotal);
        entry.purchases.push({
          date,
          orderNumber,
          quantity,
          unitPrice: quantity > 0 ? round2(lineTotal / quantity) : 0,
          lineTotal,
        });
      });
    });

    return [...byKey.values()]
      .map((entry) => {
        const purchases = entry.purchases
          .slice()
          .sort((a, b) => a.date.localeCompare(b.date) || a.orderNumber.localeCompare(b.orderNumber));
        const priced = purchases.filter((purchase) => purchase.unitPrice > 0);
        const prices = priced.map((purchase) => purchase.unitPrice);
        const totalSpent = round2(purchases.reduce((sum, purchase) => sum + purchase.lineTotal, 0));
        const totalQty = purchases.reduce((sum, purchase) => sum + purchase.quantity, 0);
        const pricedQty = priced.reduce((sum, purchase) => sum + purchase.quantity, 0);
        const pricedSpend = priced.reduce((sum, purchase) => sum + purchase.lineTotal, 0);
        const firstPrice = prices.length ? prices[0] : 0;
        const lastPrice = prices.length ? prices[prices.length - 1] : 0;
        return {
          name: entry.name,
          purchases,
          timesBought: purchases.length,
          totalQty,
          totalSpent,
          avgPrice: pricedQty > 0 ? round2(pricedSpend / pricedQty) : 0,
          firstPrice,
          lastPrice,
          minPrice: prices.length ? Math.min(...prices) : 0,
          maxPrice: prices.length ? Math.max(...prices) : 0,
          // A price-change claim needs two priced purchases; anything less is
          // null (unknown), never a made-up 0%.
          percentChange:
            priced.length >= 2 && firstPrice > 0
              ? Math.round(((lastPrice - firstPrice) / firstPrice) * 100)
              : null,
        };
      })
      .sort((a, b) => b.totalSpent - a.totalSpent || a.name.localeCompare(b.name));
  }

  /**
   * 'YYYY-MM-DD' of `now` shifted back by whole months, clamped to the month
   * end (Jul 31 − 1mo → Jun 30, not Jul 1).
   * @param {Date} now
   * @param {number} months
   * @returns {string}
   */
  function isoMonthsBack(now, months) {
    const shifted = new Date(now.getTime());
    const day = shifted.getDate();
    shifted.setMonth(shifted.getMonth() - months);
    if (shifted.getDate() !== day) shifted.setDate(0);
    const pad = (n) => String(n).padStart(2, '0');
    return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`;
  }

  /** Spend-weighted average unit price of one window's priced purchases, or 0. */
  function windowAvg(purchases) {
    let qty = 0;
    let spend = 0;
    purchases.forEach((purchase) => {
      if (!(purchase.unitPrice > 0) || !(purchase.quantity > 0)) return;
      qty += purchase.quantity;
      spend += purchase.lineTotal;
    });
    return qty > 0 ? { avg: spend / qty, qty, spend } : null;
  }

  /**
   * Laspeyres-style personal inflation over the caller's own purchases.
   *
   * Basket: the items bought (with a computable unit price) in BOTH the last
   * 12 months and the 12 months before that. For each, the spend-weighted
   * average unit price is computed per window; the base-period quantities
   * are then repriced at current averages (classic Laspeyres):
   *
   *   ratePercent = (Σ qtyThen·avgNow / Σ qtyThen·avgThen − 1) × 100
   *
   * Fewer than 3 overlapping items → null: too little data to honestly
   * claim a personal rate.
   *
   * @param {Array} itemIndex - output of buildItemIndex
   * @param {Date} [now] - injectable for deterministic tests
   * @returns {{
   *   ratePercent: number,
   *   itemCount: number,
   *   basketNow: number,
   *   basketThen: number,
   *   topRisers: Array<{name: string, thenAvg: number, nowAvg: number, percent: number}>,
   *   topFallers: Array<{name: string, thenAvg: number, nowAvg: number, percent: number}>
   * }|null}
   */
  function computePersonalInflation(itemIndex, now = new Date()) {
    const list = Array.isArray(itemIndex) ? itemIndex : [];
    const pad = (n) => String(n).padStart(2, '0');
    const nowIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const cut12 = isoMonthsBack(now, 12);
    const cut24 = isoMonthsBack(now, 24);

    const overlaps = [];
    list.forEach((entry) => {
      const nowWindow = [];
      const thenWindow = [];
      entry.purchases.forEach((purchase) => {
        const date = purchase.date;
        if (!date) return; // undated purchases cannot be windowed
        if (date > cut12 && date <= nowIso) nowWindow.push(purchase);
        else if (date > cut24 && date <= cut12) thenWindow.push(purchase);
      });
      const nowStats = windowAvg(nowWindow);
      const thenStats = windowAvg(thenWindow);
      if (!nowStats || !thenStats || !(nowStats.avg > 0) || !(thenStats.avg > 0)) return;
      overlaps.push({
        name: entry.name,
        thenAvg: thenStats.avg,
        nowAvg: nowStats.avg,
        thenQty: thenStats.qty,
        thenSpend: thenStats.spend,
      });
    });

    if (overlaps.length < 3) return null;

    let basketThen = 0;
    let basketNow = 0;
    overlaps.forEach((item) => {
      basketThen += item.thenQty * item.thenAvg;
      basketNow += item.thenQty * item.nowAvg;
    });
    if (!(basketThen > 0)) return null;

    const movers = overlaps.map((item) => ({
      name: item.name,
      thenAvg: round2(item.thenAvg),
      nowAvg: round2(item.nowAvg),
      percent: round1(((item.nowAvg - item.thenAvg) / item.thenAvg) * 100),
    }));

    return {
      ratePercent: round1(((basketNow - basketThen) / basketThen) * 100),
      itemCount: overlaps.length,
      basketNow: round2(basketNow),
      basketThen: round2(basketThen),
      topRisers: movers
        .filter((item) => item.percent > 0)
        .sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name))
        .slice(0, 5),
      topFallers: movers
        .filter((item) => item.percent < 0)
        .sort((a, b) => a.percent - b.percent || a.name.localeCompare(b.name))
        .slice(0, 5),
    };
  }

  const ItemStats = { buildItemIndex, computePersonalInflation, isoMonthsBack };

  // Dual-environment export: `self` is the window in browser documents and
  // the context object in the node vm test sandbox (sandbox.self = sandbox),
  // so both reach ItemStats the same way.
  (typeof self !== 'undefined' ? self : globalThis).ItemStats = ItemStats;
})();
