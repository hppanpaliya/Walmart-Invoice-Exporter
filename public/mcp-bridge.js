/**
 * Local MCP bridge — OFF by default, enabled in Settings → "AI access (MCP)".
 *
 * The extension can't listen on a port (no server sockets in a service
 * worker), so the MCP server proper is the separate `walmart-invoice-mcp`
 * npm package: an MCP stdio server (spawned by Claude Code / Claude Desktop /
 * any MCP client) that also listens on ws://127.0.0.1:<port>. This module is
 * the OTHER half: an outbound WebSocket client that connects to that relay,
 * authenticates with the shared token from Settings, and answers tool calls.
 * Two tiers: READ tools (list/search/get orders, stats, summaries, exports)
 * are always available and touch nothing but OrderDb; ACTION tools
 * (start_collection, collect_invoices) are additionally gated on the separate
 * "Allow AI tools to collect data" toggle (MCP_BRIDGE_ALLOW_ACTIONS, off by
 * default) because they open a background walmart tab and use the signed-in
 * session. Either way nothing leaves the machine — the socket never targets
 * anything but 127.0.0.1.
 *
 * Wire protocol (JSON text frames, one object per frame):
 *   ext → relay  {type:'hello', token, client, version, protocol}
 *   relay → ext  {type:'hello_ok'}            — token accepted
 *   relay → ext  {type:'call', id, tool, args} — tool request
 *   ext → relay  {type:'result', id, ok, data | error}
 *   ext → relay  {type:'ping'}  / relay → ext {type:'pong'} — 20s heartbeat;
 *     the traffic also stops Chrome from idle-killing this worker (≥116).
 *
 * Lifecycle: config lives in chrome.storage.local (MCP_BRIDGE_* keys) and is
 * watched via onChanged, so toggling in Settings takes effect immediately in
 * this worker with no reload. If the relay isn't running, a modest retry loop
 * keeps trying while the worker is alive; if the worker is later reborn (panel
 * open, any message), init runs again and reconnects. Loaded at the end of
 * background-main.js's importScripts chain, so CONSTANTS/OrderDb/
 * ProviderRegistry already exist; on Firefox the same chain runs as event-page
 * scripts (firefox-shim.js provides the importScripts no-op).
 */
const McpBridge = (() => {
  const KEYS = CONSTANTS.STORAGE_KEYS;
  const SPEC = CONSTANTS.MCP_BRIDGE;

  const state = {
    socket: null,
    paired: false,
    reconnectTimer: null,
    heartbeatTimer: null,
    config: { enabled: false, port: SPEC.DEFAULT_PORT, token: '', allowActions: false },
  };

  /**
   * One-at-a-time background invoice-fetch job (collect_invoices). Progress is
   * polled via get_invoice_job; the job survives only as long as this worker
   * (the heartbeat keeps it alive while the relay is connected).
   */
  const invoiceJob = {
    running: false,
    provider: null,
    total: 0,
    done: 0,
    saved: 0,
    failed: [],
    current: null,
    startedAt: null,
    finishedAt: null,
    tabId: null,
    cancelled: false,
  };

  function clampPort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < SPEC.MIN_PORT || port > SPEC.MAX_PORT) {
      return SPEC.DEFAULT_PORT;
    }
    return port;
  }

  function readConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        [KEYS.MCP_BRIDGE_ENABLED, KEYS.MCP_BRIDGE_PORT, KEYS.MCP_BRIDGE_TOKEN, KEYS.MCP_BRIDGE_ALLOW_ACTIONS],
        (stored) => {
          resolve({
            enabled: Boolean(stored && stored[KEYS.MCP_BRIDGE_ENABLED]),
            port: clampPort(stored && stored[KEYS.MCP_BRIDGE_PORT]),
            token: String((stored && stored[KEYS.MCP_BRIDGE_TOKEN]) || ''),
            allowActions: Boolean(stored && stored[KEYS.MCP_BRIDGE_ALLOW_ACTIONS]),
          });
        }
      );
    });
  }


  // ---- Tool handlers (all read-only) --------------------------------------

  /** Providers that could have data: every registered adapter id. */
  function providerIds() {
    try {
      return ProviderRegistry.list().map((adapter) => adapter.id);
    } catch (_) {
      return ['WALMART_US'];
    }
  }

  function resolveProvider(args) {
    const requested = String((args && args.provider) || '').trim();
    if (!requested) return 'WALMART_US';
    if (!providerIds().includes(requested)) {
      throw new Error(`Unknown provider "${requested}". Known: ${providerIds().join(', ')}`);
    }
    return requested;
  }

  /** Compact row for list_orders — enough to reason about without the full record. */
  function compactRow(record) {
    const summary = record.summary || {};
    const items = Array.isArray(summary.items) ? summary.items : [];
    return {
      orderNumber: record.orderNumber,
      orderDate: normalizeDashboardDate(record.orderDate || summary.orderDate) || null,
      title: record.title || summary.title || null,
      total: summary.orderTotal ?? summary.total ?? null,
      itemCount: items.length || summary.itemCount || null,
      hasInvoice: Boolean(record.invoice),
      accountKey: record.accountKey || null,
    };
  }

  const TOOLS = {
    async ping() {
      return { ok: true, version: chrome.runtime.getManifest().version };
    },

    async get_status() {
      const providers = {};
      for (const id of providerIds()) {
        try {
          providers[id] = await OrderDb.getStats(id);
        } catch (error) {
          providers[id] = { error: String(error && error.message ? error.message : error) };
        }
      }
      return { extensionVersion: chrome.runtime.getManifest().version, providers };
    },

    async list_accounts() {
      const accounts = await OrderDb.getAccountSummaries();
      return { accounts };
    },

    async list_orders(args = {}) {
      const provider = resolveProvider(args);
      const accountKey = args.accountKey ? String(args.accountKey) : null;
      const since = args.since ? String(args.since).slice(0, 10) : null;
      const until = args.until ? String(args.until).slice(0, 10) : null;
      const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 1000);
      const offset = Math.max(Number(args.offset) || 0, 0);

      const records = await OrderDb.getAllOrders(provider, accountKey);
      const rows = records
        .map(compactRow)
        .filter((row) => {
          if (since && (!row.orderDate || row.orderDate < since)) return false;
          if (until && (!row.orderDate || row.orderDate > until)) return false;
          return true;
        })
        .sort((a, b) => String(b.orderDate || '').localeCompare(String(a.orderDate || '')));
      return {
        provider,
        total: rows.length,
        offset,
        orders: rows.slice(offset, offset + limit),
      };
    },

    async get_order(args = {}) {
      const provider = resolveProvider(args);
      const orderNumber = String((args && args.orderNumber) || '').trim();
      if (!orderNumber) throw new Error('orderNumber is required');
      const record = await OrderDb.getOrder(orderNumber, provider);
      if (!record) throw new Error(`No saved order ${orderNumber} for ${provider}`);
      return { order: record };
    },

    // ---- Richer reads (still read-only, always available) -----------------

    async search_orders(args = {}) {
      const provider = resolveProvider(args);
      const query = String((args && args.query) || '').trim().toLowerCase();
      if (!query) throw new Error('query is required');
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500);
      const accountKey = args.accountKey ? String(args.accountKey) : null;

      const records = await OrderDb.getAllOrders(provider, accountKey);
      const matches = [];
      for (const record of records) {
        const row = compactRow(record);
        const names = itemNames(record);
        const haystack = [record.orderNumber, row.title || '', ...names].join('\n').toLowerCase();
        if (!haystack.includes(query)) continue;
        matches.push({
          ...row,
          matchedItems: names.filter((name) => name.toLowerCase().includes(query)).slice(0, 5),
        });
      }
      matches.sort((a, b) => String(b.orderDate || '').localeCompare(String(a.orderDate || '')));
      return { provider, query: String(args.query), total: matches.length, orders: matches.slice(0, limit) };
    },

    async spending_summary(args = {}) {
      const provider = resolveProvider(args);
      const accountKey = args.accountKey ? String(args.accountKey) : null;
      const since = args.since ? String(args.since).slice(0, 10) : null;
      const until = args.until ? String(args.until).slice(0, 10) : null;

      const records = await OrderDb.getAllOrders(provider, accountKey);
      const rows = records.map(compactRow).filter((row) => inDateRange(row, since, until));

      const byMonth = new Map();
      let totalCents = 0;
      let unparseable = 0;
      for (const row of rows) {
        const cents = parseMoneyCents(row.total);
        const month = String(row.orderDate || '').slice(0, 7) || 'unknown';
        const bucket = byMonth.get(month) || { month, orders: 0, totalCents: 0 };
        bucket.orders += 1;
        if (cents === null) unparseable += 1;
        else {
          bucket.totalCents += cents;
          totalCents += cents;
        }
        byMonth.set(month, bucket);
      }
      const months = Array.from(byMonth.values())
        .sort((a, b) => b.month.localeCompare(a.month))
        .map((bucket) => ({ month: bucket.month, orders: bucket.orders, total: centsToDollars(bucket.totalCents) }));

      return {
        provider,
        orders: rows.length,
        totalSpent: centsToDollars(totalCents),
        months,
        ...(unparseable ? { note: `${unparseable} order(s) had no parseable total and are counted in order counts only.` } : {}),
      };
    },

    async export_orders(args = {}) {
      const provider = resolveProvider(args);
      const accountKey = args.accountKey ? String(args.accountKey) : null;
      const since = args.since ? String(args.since).slice(0, 10) : null;
      const until = args.until ? String(args.until).slice(0, 10) : null;
      const includeInvoices = args.includeInvoices !== false;
      const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500);
      const offset = Math.max(Number(args.offset) || 0, 0);

      const records = await OrderDb.getAllOrders(provider, accountKey);
      const scoped = records
        .filter((record) => inDateRange(compactRow(record), since, until))
        .sort((a, b) => String(compactRow(b).orderDate || '').localeCompare(String(compactRow(a).orderDate || '')));
      const orders = scoped.slice(offset, offset + limit).map((record) => ({
        orderNumber: record.orderNumber,
        orderDate: compactRow(record).orderDate,
        accountKey: record.accountKey || null,
        summary: record.summary || null,
        ...(includeInvoices ? { invoice: record.invoice || null } : {}),
      }));
      return { provider, total: scoped.length, offset, orders };
    },

    async get_collection_progress() {
      if (typeof CollectionState === 'undefined') {
        return { isCollecting: false, note: 'Collection engine not loaded in this worker.' };
      }
      return {
        isCollecting: Boolean(CollectionState.isCollecting),
        provider: CollectionState.provider || 'WALMART_US',
        currentPage: CollectionState.currentPage || 0,
        pageLimit: CollectionState.pageLimit || 0,
        ordersFound: CollectionState.allOrderNumbers ? CollectionState.allOrderNumbers.size : 0,
      };
    },

    async get_invoice_job() {
      return {
        running: invoiceJob.running,
        provider: invoiceJob.provider,
        total: invoiceJob.total,
        done: invoiceJob.done,
        saved: invoiceJob.saved,
        failed: invoiceJob.failed.slice(-20),
        current: invoiceJob.current,
        startedAt: invoiceJob.startedAt,
        finishedAt: invoiceJob.finishedAt,
      };
    },

    // ---- Actions (require the separate "allow actions" toggle) ------------

    async start_collection(args = {}) {
      requireActions();
      const engine = collectionEngine();
      if (engine.state.isCollecting) {
        throw new Error('A collection run is already in progress — poll get_collection_progress, or call stop_collection first.');
      }
      const provider = resolveProvider(args);
      const adapter = ProviderRegistry.getById(provider);
      if (!adapter) throw new Error(`Unknown provider ${provider}`);
      if (typeof canCollectProvider === 'function' && !(await canCollectProvider(provider))) {
        throw new Error(`Provider ${provider} is disabled or missing host permission — enable it in the extension's Settings.`);
      }

      const typeFilter = args.typeFilter ? String(args.typeFilter) : 'all';
      const fromDate = args.fromDate ? String(args.fromDate).slice(0, 10) : '';
      const toDate = args.toDate ? String(args.toDate).slice(0, 10) : '';
      let url = null;
      if ((typeFilter !== 'all' || fromDate || toDate) && typeof buildOrdersFilterUrl === 'function') {
        url = buildOrdersFilterUrl(adapter.ordersListUrl, { typeFilter, fromDate, toDate });
      }

      const request = {
        action: CONSTANTS.MESSAGES.START_COLLECTION,
        provider,
        url,
        pageLimit: Math.max(Number(args.pageLimit) || 0, 0),
        incremental: args.incremental !== false,
        fastFetch: Boolean(args.fastFetch),
      };
      engine.start(request, () => {});
      return {
        started: true,
        provider,
        url: url || adapter.ordersListUrl,
        pageLimit: request.pageLimit,
        incremental: request.incremental,
        fastFetch: request.fastFetch,
        note:
          'Collection runs in a background browser tab using the signed-in Walmart session — the user must be ' +
          'logged in to walmart.com in this browser. Poll get_collection_progress until isCollecting is false.',
      };
    },

    async stop_collection() {
      requireActions();
      const engine = collectionEngine();
      const response = await new Promise((resolve) => {
        const returned = engine.stop({ action: CONSTANTS.MESSAGES.STOP_COLLECTION }, resolve);
        if (returned === false) return; // sendResponse was called synchronously
      });
      return { stopped: true, ...(response || {}) };
    },

    async collect_invoices(args = {}) {
      requireActions();
      const provider = resolveProvider(args);
      const adapter = ProviderRegistry.getById(provider);
      if (!adapter || !adapter.supportsFastInvoice) {
        throw new Error(`Provider ${provider} does not support background invoice fetching.`);
      }
      if (invoiceJob.running) {
        throw new Error('An invoice job is already running — poll get_invoice_job.');
      }
      if (typeof CollectionState !== 'undefined' && CollectionState.isCollecting) {
        throw new Error('A collection run is in progress — wait for it to finish before fetching invoices.');
      }

      let orderNumbers = Array.isArray(args.orderNumbers) ? args.orderNumbers.map(String).filter(Boolean) : [];
      if (!orderNumbers.length) {
        // Default scope: every saved order that doesn't have its invoice yet.
        const records = await OrderDb.getAllOrders(provider, null);
        orderNumbers = records.filter((record) => !record.invoice).map((record) => record.orderNumber);
      }
      if (!orderNumbers.length) {
        return { started: false, note: 'Nothing to do — every requested order already has its invoice saved.' };
      }

      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 15000, 3000), 120000);
      Object.assign(invoiceJob, {
        running: true,
        provider,
        total: orderNumbers.length,
        done: 0,
        saved: 0,
        failed: [],
        current: null,
        startedAt: Date.now(),
        finishedAt: null,
        tabId: null,
        cancelled: false,
      });
      runInvoiceJob(orderNumbers, provider, adapter, timeoutMs); // fire and forget; progress via get_invoice_job
      return {
        started: true,
        total: orderNumbers.length,
        note:
          'Fetching invoices in a background browser tab using the signed-in Walmart session. ' +
          'Poll get_invoice_job until running is false.',
      };
    },

    async cancel_invoice_job() {
      requireActions();
      if (!invoiceJob.running) return { cancelled: false, note: 'No invoice job is running.' };
      invoiceJob.cancelled = true;
      return { cancelled: true, note: 'The job stops after the in-flight order finishes.' };
    },
  };

  // ---- Action plumbing ----------------------------------------------------

  /** Every action tool goes through this gate; reads never do. */
  function requireActions() {
    if (!state.config.allowActions) {
      throw new Error(
        'AI actions are disabled (the bridge is read-only by default). In the Walmart Invoice Exporter ' +
          'extension — which is required for everything this server does — open Settings → "AI access (MCP)" ' +
          'and enable "Allow AI tools to collect data".'
      );
    }
  }

  /** The collection engine lives in background-main.js; absent in unit tests. */
  function collectionEngine() {
    if (typeof CollectionState === 'undefined' || typeof handleStartCollection !== 'function') {
      throw new Error('Collection engine unavailable in this worker.');
    }
    return { state: CollectionState, start: handleStartCollection, stop: handleStopCollection };
  }

  function itemNames(record) {
    const names = [];
    const summaryItems = record.summary && Array.isArray(record.summary.items) ? record.summary.items : [];
    const invoiceItems = record.invoice && Array.isArray(record.invoice.items) ? record.invoice.items : [];
    for (const item of [...summaryItems, ...invoiceItems]) {
      const name = String((item && (item.name || item.title || item.productName)) || '').trim();
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  }

  function inDateRange(row, since, until) {
    if (since && (!row.orderDate || row.orderDate < since)) return false;
    if (until && (!row.orderDate || row.orderDate > until)) return false;
    return true;
  }

  /** "$1,234.56" | "62.93" | number → integer cents, or null if unparseable. */
  function parseMoneyCents(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100);
    const cleaned = String(value ?? '').replace(/[$,\s]/g, '');
    if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    return Math.round(Number(cleaned) * 100);
  }

  function centsToDollars(cents) {
    return Math.round(cents) / 100;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function tabsSendMessage(tabId, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No answer from the walmart tab within ${timeoutMs}ms`)), timeoutMs);
      try {
        chrome.tabs.sendMessage(tabId, payload, (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function waitForTabComplete(tabId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error('Timed out loading the walmart orders tab'));
      }, timeoutMs);
      function onUpdated(updatedTabId, changeInfo) {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.get(tabId, (tab) => {
        if (!chrome.runtime.lastError && tab && tab.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      });
    });
  }

  /**
   * Background port of the panel's fast-invoice flow (sidepanel.download.js):
   * one hidden orders-list tab, then per-order GET_ORDER_DATA_FAST messages to
   * the content script — no per-order navigation. Results go straight to
   * OrderDb.putInvoice, preserving each record's existing accountKey.
   */
  async function runInvoiceJob(orderNumbers, provider, adapter, timeoutMs) {
    let tabId = null;
    try {
      const tab = await new Promise((resolve, reject) =>
        chrome.tabs.create({ url: adapter.ordersListUrl, active: false }, (created) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(created);
        })
      );
      tabId = tab.id;
      invoiceJob.tabId = tabId;
      await waitForTabComplete(tabId, 45000);
      await sleep(1200); // let the content script + main-world bridge install

      for (const orderNumber of orderNumbers) {
        if (invoiceJob.cancelled) break;
        invoiceJob.current = orderNumber;
        try {
          const response = await tabsSendMessage(
            tabId,
            { action: CONSTANTS.MESSAGES.GET_ORDER_DATA_FAST, orderNumber },
            timeoutMs
          );
          if (response && response.data && !response.fallback) {
            const existing = await OrderDb.getOrder(orderNumber, provider);
            await OrderDb.putInvoice(orderNumber, response.data, provider, (existing && existing.accountKey) || null);
            invoiceJob.saved += 1;
          } else {
            invoiceJob.failed.push({ orderNumber, reason: 'fast fetch unavailable for this order' });
          }
        } catch (error) {
          invoiceJob.failed.push({ orderNumber, reason: String((error && error.message) || error) });
        }
        invoiceJob.done += 1;
        await sleep(400); // pace requests against the user's own session
      }
    } catch (error) {
      invoiceJob.failed.push({ orderNumber: null, reason: `job aborted: ${String((error && error.message) || error)}` });
    } finally {
      invoiceJob.running = false;
      invoiceJob.current = null;
      invoiceJob.finishedAt = Date.now();
      if (tabId !== null) {
        try {
          chrome.tabs.remove(tabId, () => void chrome.runtime.lastError);
        } catch (_) {
          /* tab already gone */
        }
      }
      invoiceJob.tabId = null;
    }
  }

  // ---- Socket plumbing ----------------------------------------------------

  function send(payload) {
    const socket = state.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        console.warn('[mcp-bridge] send failed:', error);
      }
    }
  }

  async function handleCall(message) {
    const { id, tool, args } = message;
    const handler = TOOLS[tool];
    if (!handler) {
      send({ type: 'result', id, ok: false, error: `Unknown tool "${tool}"` });
      return;
    }
    try {
      const data = await handler(args || {});
      send({ type: 'result', id, ok: true, data });
    } catch (error) {
      send({ type: 'result', id, ok: false, error: String(error && error.message ? error.message : error) });
    }
  }

  function stopTimers() {
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.heartbeatTimer = null;
    state.reconnectTimer = null;
  }

  function disconnect() {
    stopTimers();
    state.paired = false;
    const socket = state.socket;
    state.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch (_) {
        /* already closed */
      }
    }
  }

  function scheduleReconnect() {
    if (!state.config.enabled || state.reconnectTimer) return;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connect();
    }, SPEC.RECONNECT_MS);
  }

  function connect() {
    if (!state.config.enabled || state.socket) return;
    if (!state.config.token) {
      // No token yet (Settings generates one on first enable) — don't dial
      // out unauthenticated.
      return;
    }

    let socket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${state.config.port}`);
    } catch (error) {
      console.warn('[mcp-bridge] could not open socket:', error);
      scheduleReconnect();
      return;
    }
    state.socket = socket;

    socket.onopen = () => {
      send({
        type: 'hello',
        token: state.config.token,
        client: 'walmart-invoice-exporter',
        version: chrome.runtime.getManifest().version,
        protocol: SPEC.PROTOCOL_VERSION,
      });
      state.heartbeatTimer = setInterval(() => send({ type: 'ping' }), SPEC.HEARTBEAT_MS);
    };

    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (_) {
        return; // not ours — ignore malformed frames
      }
      if (!message || typeof message !== 'object') return;
      if (message.type === 'hello_ok') {
        state.paired = true;
        console.log('[mcp-bridge] connected to local MCP relay on port', state.config.port);
      } else if (message.type === 'call') {
        handleCall(message);
      }
      // 'pong' and anything unknown: nothing to do.
    };

    socket.onclose = () => {
      const wasPaired = state.paired;
      disconnect();
      if (wasPaired) console.log('[mcp-bridge] relay disconnected');
      scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose always follows and owns the retry; nothing to do here.
    };
  }

  /** (Re)load config and converge the connection to match it. */
  async function applyConfig() {
    state.config = await readConfig();
    disconnect();
    if (state.config.enabled) connect();
  }

  function init() {
    applyConfig();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      // The actions toggle only gates tool calls — flip it in place so the
      // socket doesn't drop and reconnect for a permission change.
      if (changes[KEYS.MCP_BRIDGE_ALLOW_ACTIONS]) {
        state.config.allowActions = Boolean(changes[KEYS.MCP_BRIDGE_ALLOW_ACTIONS].newValue);
      }
      const relevant =
        changes[KEYS.MCP_BRIDGE_ENABLED] || changes[KEYS.MCP_BRIDGE_PORT] || changes[KEYS.MCP_BRIDGE_TOKEN];
      if (relevant) applyConfig();
    });
  }

  init();

  // Exposed for tests; nothing else in the extension calls into this module.
  return { TOOLS, clampPort, compactRow, parseMoneyCents, _state: state, _invoiceJob: invoiceJob };
})();
