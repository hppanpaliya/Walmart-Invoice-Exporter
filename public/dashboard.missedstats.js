/**
 * "What you didn't get": lines Walmart could not supply, canceled, swapped
 * for a substitute, or charged by final weight — plus late deliveries.
 *
 * Pure computation, shared with the unit tests. Only invoices read by an
 * extraction that records these details are counted; older saved invoices
 * are reported as "without detail" instead of being read as "nothing missed".
 */
(() => {
  'use strict';

  /** The extraction version that started recording these details, per site. */
  const DETAIL_VERSION = 6;
  const DETAIL_VERSION_BY_PROVIDER = { WALMART_CA: 2 };
  const KINDS = ['unavailable', 'canceled', 'substituted', 'weightAdjusted'];

  const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
  const money = (value) => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const numeric = String(value === null || value === undefined ? '' : value).replace(/[^0-9.-]+/g, '');
    return /\d/.test(numeric) && Number.isFinite(Number(numeric)) ? Number(numeric) : 0;
  };
  const quantityOf = (value) => {
    const parsed = money(value);
    return parsed > 0 ? parsed : 1;
  };

  function defaultIsMeasured(record) {
    const invoice = record && record.invoice;
    if (!invoice || !Array.isArray(invoice.items)) return false;
    const minVersion = (typeof CONSTANTS !== 'undefined' && CONSTANTS && CONSTANTS.ORDER_SCHEMA_VERSION) || 3;
    return Number(invoice.schemaVersion || 0) >= minVersion;
  }

  /** True when the invoice was read by an extraction that records these details. */
  function hasDetail(invoice, provider) {
    const required = DETAIL_VERSION_BY_PROVIDER[provider] || DETAIL_VERSION;
    return Number((invoice && invoice.walmartExtractionVersion) || 0) >= required;
  }

  function recordDate(record) {
    if (typeof dashboardRecordDate === 'function') return dashboardRecordDate(record) || '';
    return String((record && record.invoice && record.invoice.orderDate) || (record && record.orderDate) || '').slice(0, 10);
  }

  /**
   * @param {Array} records - OrderDb records in the range being shown
   * @param {function(Object): boolean} [isMeasured] - measured-invoice predicate override
   * @returns {{
   *   ordersMeasured: number, ordersWithDetail: number, ordersAffected: number, lateDeliveries: number,
   *   totals: Object<string, {lines: number, quantity: number, value: number}>,
   *   top: Object<string, Array<{name: string, times: number, quantity: number, value: number, lastDate: string}>>,
   *   recent: Array<{date: string, orderNumber: string, name: string, kind: string, quantity: number, value: number}>
   * }}
   */
  function buildMissedSummary(records, isMeasured) {
    const measured = typeof isMeasured === 'function' ? isMeasured : defaultIsMeasured;
    const totals = {};
    const byName = {};
    KINDS.forEach((kind) => {
      totals[kind] = { lines: 0, quantity: 0, value: 0 };
      byName[kind] = new Map();
    });
    const events = [];
    const affected = new Set();
    let ordersMeasured = 0;
    let ordersWithDetail = 0;
    let lateDeliveries = 0;

    (Array.isArray(records) ? records : []).forEach((record) => {
      if (!measured(record)) return;
      ordersMeasured += 1;
      const invoice = record.invoice;
      if (!hasDetail(invoice, record && record.provider)) return;
      ordersWithDetail += 1;
      if (invoice.wasDelayed === true) lateDeliveries += 1;
      const date = recordDate(record);
      const orderNumber = String(record.orderNumber || invoice.orderNumber || '');

      const add = (kind, item) => {
        const name = String((item && item.productName) || '').trim();
        if (!name) return;
        const quantity = quantityOf(item.quantity);
        const value = round2(money(item.price));
        totals[kind].lines += 1;
        totals[kind].quantity += quantity;
        totals[kind].value += value;
        const key = name.toLowerCase();
        const entry = byName[kind].get(key) || { name, times: 0, quantity: 0, value: 0, lastDate: '' };
        entry.times += 1;
        entry.quantity += quantity;
        entry.value += value;
        if (date > entry.lastDate) entry.lastDate = date;
        byName[kind].set(key, entry);
        events.push({ date, orderNumber, name, kind, quantity, value });
        if (orderNumber) affected.add(orderNumber);
      };

      (Array.isArray(invoice.unfulfilledItems) ? invoice.unfulfilledItems : []).forEach((item) => {
        if (!item) return;
        add(String(item.reason || '').toLowerCase() === 'unavailable' ? 'unavailable' : 'canceled', item);
      });
      invoice.items.forEach((item) => {
        if (!item) return;
        if (item.fulfillment === 'Substituted') add('substituted', item);
        else if (item.fulfillment === 'Weight adjusted') add('weightAdjusted', item);
      });
    });

    const top = {};
    KINDS.forEach((kind) => {
      totals[kind].value = round2(totals[kind].value);
      totals[kind].quantity = round2(totals[kind].quantity);
      top[kind] = [...byName[kind].values()]
        .map((entry) => ({ ...entry, quantity: round2(entry.quantity), value: round2(entry.value) }))
        .sort((a, b) => b.times - a.times || b.value - a.value || a.name.localeCompare(b.name))
        .slice(0, 10);
    });
    const recent = events
      .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name))
      .slice(0, 25);

    return { ordersMeasured, ordersWithDetail, ordersAffected: affected.size, lateDeliveries, totals, top, recent };
  }

  const MissedStats = { DETAIL_VERSION, KINDS, hasDetail, buildMissedSummary };
  if (typeof module !== 'undefined' && module.exports) module.exports = MissedStats;
  (typeof self !== 'undefined' ? self : globalThis).MissedStats = MissedStats;
})();
