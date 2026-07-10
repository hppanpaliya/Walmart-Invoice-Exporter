/**
 * Durable local order database (IndexedDB).
 *
 * Unlike the 24-hour chrome.storage collection cache, records here persist
 * across sessions, powering incremental collection ("only new orders"),
 * Quick Export fallback, and local analytics. Everything stays on-device.
 *
 * Loaded by both the side panel (script tag) and the background service
 * worker (importScripts) — both run on the extension origin, so they share
 * one database.
 *
 * Record shape (store "orders", keyPath "orderNumber"):
 *   {
 *     orderNumber: string,        // digits-only
 *     orderDate: string,          // ISO 8601 when known (from list payload)
 *     title: string,              // list-page tooltip title
 *     summary: Object|null,       // Quick Export summary from the list payload
 *     invoice: Object|null,       // full deep-export order data (schemaVersion 2+)
 *     firstSeenAt: number,        // epoch ms
 *     updatedAt: number,          // epoch ms
 *   }
 */
const OrderDb = (() => {
  const DB_NAME = 'walmart-invoice-exporter';
  const DB_VERSION = 1;
  const STORE = 'orders';

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'orderNumber' });
          store.createIndex('orderDate', 'orderDate');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Run `work(store)` inside a transaction and resolve when it commits.
   * @param {IDBTransactionMode} mode
   * @param {(store: IDBObjectStore) => Promise<*>} work
   */
  async function withStore(mode, work) {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const result = await work(store);
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
      });
      return result;
    } finally {
      db.close();
    }
  }

  /**
   * Merge purchase-history summaries into the database (upsert per order).
   * @param {Object} orderSummaries - orderNumber → Quick Export summary
   * @param {Object} additionalFields - orderNumber → title
   */
  async function putSummaries(orderSummaries = {}, additionalFields = {}) {
    const entries = Object.entries(orderSummaries || {});
    if (entries.length === 0) return 0;

    const now = Date.now();
    return withStore('readwrite', async (store) => {
      for (const [orderNumber, summary] of entries) {
        if (!orderNumber) continue;
        const existing = (await requestToPromise(store.get(orderNumber))) || null;
        store.put({
          orderNumber,
          orderDate: summary?.orderDate || existing?.orderDate || '',
          title: additionalFields[orderNumber] || existing?.title || '',
          summary: summary || existing?.summary || null,
          invoice: existing?.invoice || null,
          firstSeenAt: existing?.firstSeenAt || now,
          updatedAt: now,
        });
      }
      return entries.length;
    });
  }

  /**
   * Store the full deep-export invoice data for one order (upsert).
   * @param {string} orderNumber - digits-only order number
   * @param {Object} invoice - order data from the content script
   */
  async function putInvoice(orderNumber, invoice) {
    if (!orderNumber || !invoice) return;

    const now = Date.now();
    return withStore('readwrite', async (store) => {
      const existing = (await requestToPromise(store.get(orderNumber))) || null;
      store.put({
        orderNumber,
        orderDate: existing?.orderDate || '',
        title: existing?.title || '',
        summary: existing?.summary || null,
        invoice,
        firstSeenAt: existing?.firstSeenAt || now,
        updatedAt: now,
      });
    });
  }

  /** @returns {Promise<Object|null>} one record */
  function getOrder(orderNumber) {
    return withStore('readonly', (store) => requestToPromise(store.get(orderNumber)));
  }

  /** @returns {Promise<Object[]>} every record */
  function getAllOrders() {
    return withStore('readonly', (store) => requestToPromise(store.getAll()));
  }

  /** @returns {Promise<Set<string>>} every stored order number */
  async function getKnownOrderNumbers() {
    const keys = await withStore('readonly', (store) => requestToPromise(store.getAllKeys()));
    return new Set(keys || []);
  }

  /** @returns {Promise<{orders: number, invoices: number}>} database stats */
  async function getStats() {
    const records = await getAllOrders();
    return {
      orders: records.length,
      invoices: records.filter((record) => record.invoice).length,
    };
  }

  /** Remove every record. */
  function clearAll() {
    return withStore('readwrite', (store) => requestToPromise(store.clear()));
  }

  return {
    putSummaries,
    putInvoice,
    getOrder,
    getAllOrders,
    getKnownOrderNumbers,
    getStats,
    clearAll,
  };
})();
