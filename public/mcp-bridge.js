/**
 * Local MCP bridge — OFF by default, enabled in Settings → "AI access (MCP)".
 *
 * The extension can't listen on a port (no server sockets in a service
 * worker), so the MCP server proper is the separate `walmart-invoice-mcp`
 * npm package: an MCP stdio server (spawned by Claude Code / Claude Desktop /
 * any MCP client) that also listens on ws://127.0.0.1:<port>. This module is
 * the OTHER half: an outbound WebSocket client that connects to that relay,
 * authenticates with the shared token from Settings, and answers read-only
 * tool calls (list orders, get one order, stats, accounts) straight from
 * OrderDb. Nothing here writes to the database and nothing leaves the machine
 * — the socket never targets anything but 127.0.0.1.
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
    config: { enabled: false, port: SPEC.DEFAULT_PORT, token: '' },
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
        [KEYS.MCP_BRIDGE_ENABLED, KEYS.MCP_BRIDGE_PORT, KEYS.MCP_BRIDGE_TOKEN],
        (stored) => {
          resolve({
            enabled: Boolean(stored && stored[KEYS.MCP_BRIDGE_ENABLED]),
            port: clampPort(stored && stored[KEYS.MCP_BRIDGE_PORT]),
            token: String((stored && stored[KEYS.MCP_BRIDGE_TOKEN]) || ''),
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
  };

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
      const relevant =
        changes[KEYS.MCP_BRIDGE_ENABLED] || changes[KEYS.MCP_BRIDGE_PORT] || changes[KEYS.MCP_BRIDGE_TOKEN];
      if (relevant) applyConfig();
    });
  }

  init();

  // Exposed for tests; nothing else in the extension calls into this module.
  return { TOOLS, clampPort, compactRow, _state: state };
})();
