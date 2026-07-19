/**
 * Durable local order database (IndexedDB) — the single source of truth
 * for orders and invoices (spec §4.1).
 *
 * Unlike chrome.storage.session (ephemeral live-collection progress,
 * cleared when the browser closes — see background.js's CollectionState),
 * records here persist indefinitely across sessions, powering incremental
 * collection ("only new orders"), the panel's order list, Quick Export
 * fallback, and local analytics. Everything stays on-device.
 *
 * Loaded by both the side panel (script tag) and the background service
 * worker (importScripts) — both run on the extension origin, so they share
 * one database.
 *
 * Multi-provider (DB_VERSION 2): the store is keyed by the COMPOUND key
 * [provider, orderNumber] so different retailers can share the store without
 * order-number collisions, with a `provider` index for per-provider queries.
 * Every OrderDb method takes an optional `provider` filter that defaults to
 * 'WALMART_US', so all existing Walmart-only callers keep working unchanged.
 *
 * Record shape (store "orders", keyPath ["provider","orderNumber"]):
 *   {
 *     provider: string,           // provider id partition, e.g. 'WALMART_US'
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
  const DB_VERSION = 2;
  const STORE = 'orders';
  // Provider stamped on rows migrated from the pre-multi-provider schema, and
  // the default partition every method reads/writes when no provider is named.
  const DEFAULT_PROVIDER = 'WALMART_US';

  function createStore(db) {
    const store = db.createObjectStore(STORE, { keyPath: ['provider', 'orderNumber'] });
    store.createIndex('orderDate', 'orderDate');
    store.createIndex('provider', 'provider');
    return store;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const tx = request.transaction;

        // Fresh install: create the multi-provider store directly.
        if (!db.objectStoreNames.contains(STORE)) {
          createStore(db);
          return;
        }

        // Upgrade from v1 (keyPath 'orderNumber', single-retailer): read every
        // existing row, recreate the store with the compound key, and re-insert
        // each row stamped with provider 'WALMART_US'. No data loss — the
        // getAll request keeps this versionchange transaction alive until the
        // rebuild completes.
        const oldStore = tx.objectStore(STORE);
        const getAllRequest = oldStore.getAll();
        getAllRequest.onsuccess = () => {
          const rows = getAllRequest.result || [];
          db.deleteObjectStore(STORE);
          const store = createStore(db);
          rows.forEach((row) => {
            if (!row || !row.orderNumber) return;
            row.provider = row.provider || DEFAULT_PROVIDER;
            store.put(row);
          });
        };
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
   * @param {string} [provider] - provider partition (defaults to WALMART_US)
   */
  async function putSummaries(orderSummaries = {}, additionalFields = {}, provider = DEFAULT_PROVIDER, accountKey = null) {
    const entries = Object.entries(orderSummaries || {});
    if (entries.length === 0) return 0;

    const now = Date.now();
    return withStore('readwrite', async (store) => {
      for (const [orderNumber, summary] of entries) {
        if (!orderNumber) continue;
        const existing = (await requestToPromise(store.get([provider, orderNumber]))) || null;

        // Keep the richer stored summary when the incoming one is a
        // degraded DOM scrape (isPayloadQualitySummary lives in utils.js,
        // which loads before this module everywhere).
        const keepExisting =
          existing?.summary &&
          isPayloadQualitySummary(existing.summary) &&
          !isPayloadQualitySummary(summary);
        const summaryToStore = keepExisting ? existing.summary : summary || existing?.summary || null;

        store.put({
          provider,
          orderNumber,
          orderDate: summaryToStore?.orderDate || existing?.orderDate || '',
          title: additionalFields[orderNumber] || existing?.title || '',
          summary: summaryToStore,
          invoice: existing?.invoice || null,
          // Which Walmart account this order belongs to (null = untagged legacy).
          // A known key always wins; never blank out an existing tag.
          accountKey: accountKey || existing?.accountKey || null,
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
   * @param {string} [provider] - provider partition (defaults to WALMART_US)
   */
  async function putInvoice(orderNumber, invoice, provider = DEFAULT_PROVIDER, accountKey = null) {
    if (!orderNumber || !invoice) return;

    const now = Date.now();
    return withStore('readwrite', async (store) => {
      const existing = (await requestToPromise(store.get([provider, orderNumber]))) || null;
      store.put({
        provider,
        orderNumber,
        // Keep the summary's ISO date when we have it; otherwise take the
        // invoice's (human-format) date so the record is never dateless.
        orderDate: existing?.orderDate || invoice.orderDate || '',
        title: existing?.title || '',
        summary: existing?.summary || null,
        invoice,
        accountKey: accountKey || existing?.accountKey || null,
        firstSeenAt: existing?.firstSeenAt || now,
        updatedAt: now,
      });
    });
  }

  /**
   * @param {string} orderNumber
   * @param {string} [provider] - provider partition (defaults to WALMART_US)
   * @returns {Promise<Object|null>} one record
   */
  function getOrder(orderNumber, provider = DEFAULT_PROVIDER) {
    return withStore('readonly', (store) => requestToPromise(store.get([provider, orderNumber])));
  }

  /**
   * @param {string} [provider] - provider partition (defaults to WALMART_US)
   * @param {string|null} [accountKey] - the switcher's selection value:
   *   - null/absent → no account filter (account unknown → show everything);
   *   - ACCOUNTS.UNTAGGED → only the untagged legacy bucket (records with no key);
   *   - a real account key → ONLY that account's records.
   *   Untagged records are NOT grandfathered into a real account anymore — that
   *   silently leaked (and, via the old stamping, erased) one account's orders
   *   into another. They live in their own bucket until re-collected.
   * @returns {Promise<Object[]>} matching records for the provider
   */
  function getAllOrders(provider = DEFAULT_PROVIDER, accountKey = null) {
    const UNTAGGED = CONSTANTS.ACCOUNTS.UNTAGGED;
    return withStore('readonly', async (store) => {
      const all = (await requestToPromise(store.getAll())) || [];
      return all.filter((record) => {
        if (!record || record.provider !== provider) return false;
        if (accountKey == null) return true; // account unknown → show everything
        if (accountKey === UNTAGGED) return !record.accountKey; // legacy bucket
        return record.accountKey === accountKey; // strict: only this account
      });
    });
  }

  /**
   * Summarize the accounts that have saved data, so Settings can offer a
   * per-account "delete" without needing (or storing) any account name. Each
   * entry: { accountKey, orderCount, invoiceCount, newestOrderDate, updatedAt }.
   * Untagged legacy records are reported as one entry with accountKey null.
   * Sorted most-recently-used first.
   * @returns {Promise<Array<Object>>}
   */
  function getAccountSummaries() {
    return withStore('readonly', async (store) => {
      const all = (await requestToPromise(store.getAll())) || [];
      const byAccount = new Map();
      all.forEach((record) => {
        if (!record) return;
        const key = record.accountKey || null;
        const id = key || '__untagged__';
        let entry = byAccount.get(id);
        if (!entry) {
          entry = { accountKey: key, orderCount: 0, invoiceCount: 0, newestOrderDate: '', updatedAt: 0 };
          byAccount.set(id, entry);
        }
        entry.orderCount += 1;
        if (record.invoice) entry.invoiceCount += 1;
        const date = String(record.orderDate || '');
        if (date && date > entry.newestOrderDate) entry.newestOrderDate = date;
        if (typeof record.updatedAt === 'number' && record.updatedAt > entry.updatedAt) {
          entry.updatedAt = record.updatedAt;
        }
      });
      return Array.from(byAccount.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }

  /**
   * Delete every record belonging to ONE account (accountKey === null deletes
   * the untagged legacy bucket). Leaves other accounts untouched — same
   * clear + re-insert-survivors pattern as clearAll.
   * @param {string|null} accountKey
   * @returns {Promise<number>} how many records were removed
   */
  function clearAccount(accountKey) {
    const target = accountKey || null;
    return withStore('readwrite', async (store) => {
      const all = (await requestToPromise(store.getAll())) || [];
      const survivors = all.filter((record) => (record && (record.accountKey || null)) !== target);
      if (survivors.length === all.length) return 0;
      await requestToPromise(store.clear());
      survivors.forEach((record) => store.put(record));
      return all.length - survivors.length;
    });
  }

  /**
   * @param {string} [provider] - provider partition (defaults to WALMART_US)
   * @returns {Promise<Set<string>>} every stored order number for the provider
   */
  async function getKnownOrderNumbers(provider = DEFAULT_PROVIDER) {
    const records = await getAllOrders(provider);
    return new Set((records || []).map((record) => record.orderNumber).filter(Boolean));
  }

  /**
   * @param {string} [provider] - provider partition (defaults to WALMART_US)
   * @returns {Promise<{orders: number, invoices: number}>} database stats
   */
  async function getStats(provider = DEFAULT_PROVIDER) {
    const records = await getAllOrders(provider);
    return {
      orders: records.length,
      invoices: records.filter((record) => record.invoice).length,
    };
  }

  /**
   * Remove every record for a provider (defaults to WALMART_US) while leaving
   * other retailers' data untouched. Reads the whole store, clears it, then
   * re-inserts the survivors — avoids relying on an object-store index or
   * cursor at query time (keeps it environment-agnostic).
   * @param {string} [provider] - provider partition (defaults to WALMART_US)
   */
  function clearAll(provider = DEFAULT_PROVIDER) {
    return withStore('readwrite', async (store) => {
      const all = (await requestToPromise(store.getAll())) || [];
      const survivors = all.filter((record) => record && record.provider !== provider);
      await requestToPromise(store.clear());
      survivors.forEach((record) => store.put(record));
    });
  }

  /**
   * Wipe EVERY record for EVERY provider. Used by the inactivity-retention
   * sweep (below) — the "you haven't used the extension in a while, so we
   * cleaned up" one-shot. Manual per-provider clearing stays in clearAll().
   * @returns {Promise<number>} how many records were removed
   */
  function clearEverything() {
    return withStore('readwrite', async (store) => {
      const all = (await requestToPromise(store.getAll())) || [];
      await requestToPromise(store.clear());
      return all.length;
    });
  }

  // chrome.storage.local key holding the epoch-ms timestamp of the last time
  // the user actually used the extension (opened the panel / started a run).
  const LAST_USED_KEY = 'lastUsedAt';

  /**
   * Record that the extension is being used right now — resets the inactivity
   * clock, so an active user's data is never auto-deleted. Called on panel open
   * and when a collection starts.
   */
  function markUsed() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [LAST_USED_KEY]: Date.now() }, () => resolve());
      } catch (error) {
        resolve();
      }
    });
  }

  /**
   * Inactivity-based retention (Settings → Advanced, ON by default): if the
   * extension hasn't been used within the configured number of days, wipe ALL
   * saved data in one shot. This is NOT per-order aging — an active user keeps
   * everything forever (their lastUsedAt keeps resetting); only an abandoned
   * install gets cleaned up, so nothing lingers on a device that stopped using
   * the extension. Never touches lastUsedAt itself (markUsed owns that), so a
   * background wake can enforce the wipe without counting as "use".
   * @returns {Promise<number>} how many records were wiped (0 = nothing)
   */
  async function enforceInactivityRetention() {
    let settings = {};
    try {
      settings = await new Promise((resolve) =>
        chrome.storage.local.get(['dataRetentionEnabled', 'dataRetentionDays', LAST_USED_KEY], resolve)
      );
    } catch (error) {
      return 0;
    }

    // Default ON: only an explicit `false` disables the cleanup.
    if (settings.dataRetentionEnabled === false) return 0;

    // No baseline yet (fresh install / first run) — nothing to wipe; the first
    // markUsed() sets the clock.
    const lastUsed = settings[LAST_USED_KEY];
    if (typeof lastUsed !== 'number') return 0;

    const spec = (typeof CONSTANTS !== 'undefined' && CONSTANTS.DATA_RETENTION) || {
      defaultDays: 180,
      minDays: 1,
      maxDays: 3650,
    };
    const raw = Number(settings.dataRetentionDays);
    const days = Number.isFinite(raw)
      ? Math.min(spec.maxDays, Math.max(spec.minDays, Math.round(raw)))
      : spec.defaultDays;

    if (Date.now() - lastUsed <= days * 24 * 60 * 60 * 1000) return 0; // still active
    return clearEverything();
  }

  return {
    putSummaries,
    putInvoice,
    getOrder,
    getAllOrders,
    getKnownOrderNumbers,
    getStats,
    clearAll,
    clearEverything,
    clearAccount,
    getAccountSummaries,
    markUsed,
    enforceInactivityRetention,
  };
})();
