'use strict';
process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
// AI access (MCP) end to end: MCP client (this script) -> published relay
// walmart-invoice-mcp 0.2.0 -> packaged 8.8 extension -> saved orders.
// Synthetic seeded data and the mock Walmart only.
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { spawn, execSync } = require('node:child_process');
const os = require('node:os');
const lib = require('./launcher.cjs');

const HERE = __dirname;
const EXT = lib.DEFAULT_EXT;
// Path to the installed relay's bin script: npm install walmart-invoice-mcp --ignore-scripts in a scratch directory.
const RELAY = process.env.WIE_RELAY;
if (!RELAY) throw new Error('Set WIE_RELAY to <scratch>/node_modules/walmart-invoice-mcp/bin/walmart-invoice-mcp.js');
const OUT = process.env.WIE_OUT || path.join(os.tmpdir(), 'wie-mcp-sweep.json');
const PORT = 18924;
const result = { checks: {}, errors: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
const clip = (value, n = 260) => String(typeof value === 'string' ? value : JSON.stringify(value)).replace(/\s+/g, ' ').slice(0, n);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startRelay(token, port) {
  const child = spawn(process.execPath, [RELAY, '--token', token, '--port', String(port)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk).replace(token, '<token>').trim().slice(0, 200)));
  let buffer = ''; const pending = new Map(); let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      if (!line) continue;
      try { const message = JSON.parse(line); if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); } } catch (error) { /* not json */ }
    }
  });
  const request = (method, params, timeoutMs = 30000) => new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); resolve({ timedOut: true }); }, timeoutMs);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  // Returns { ok, data | error } for a tool call.
  const call = async (name, args = {}, timeoutMs = 30000) => {
    const response = await request('tools/call', { name, arguments: args }, timeoutMs);
    if (response.timedOut) return { ok: false, error: 'timed out' };
    if (response.error) return { ok: false, error: clip(response.error.message || response.error) };
    const text = (response.result && response.result.content && response.result.content[0] && response.result.content[0].text) || '';
    let data = text; try { data = JSON.parse(text); } catch (error) { /* plain text */ }
    return response.result && response.result.isError ? { ok: false, error: clip(text) } : { ok: true, data };
  };
  return { child, stderr, request, notify, call, stop: () => { try { child.kill(); } catch (error) { /* gone */ } } };
}

(async () => {
  let session; let relay;
  try {
    session = await lib.launchExt({ extDir: EXT });
    const { panel } = session;
    const seeded = await lib.seedOrderHistory(panel, { months: 8 });
    const withInvoice = seeded.filter((record) => record.invoice);
    const expected = { orders: seeded.length, invoices: withInvoice.length, invoiceTotal: Math.round(withInvoice.reduce((sum, record) => sum + record.invoice.orderTotal, 0) * 100) / 100 };
    result.expected = expected;

    // 1. Off by default: nothing dials the default port.
    const defaults = await lib.storageAll(panel);
    let attempts = 0;
    const probe = net.createServer((socket) => { attempts += 1; socket.destroy(); });
    const probeListening = await new Promise((resolve) => { probe.once('error', () => resolve(false)); probe.listen(8924, '127.0.0.1', () => resolve(true)); });
    await sleep(probeListening ? 20000 : 0);
    if (probeListening) await new Promise((resolve) => probe.close(resolve));
    result.checks.offByDefault = { storedEnabled: defaults.mcpBridgeEnabled ?? '<absent>', storedAllowActions: defaults.mcpBridgeAllowActions ?? '<absent>', tokenPresentBeforeEnable: Boolean(defaults.mcpBridgeToken), probeListenedOn8924: probeListening, connectionAttemptsIn20s: attempts };
    save();

    // 2. Enable through the Settings UI and pair with the real relay.
    await panel.click('#settingsButton');
    await panel.waitForSelector('#settingsMcpEnabled', { timeout: 8000 });
    await panel.check('#settingsMcpEnabled');
    await sleep(900);
    await panel.evaluate((port) => { const el = document.getElementById('settingsMcpPort'); el.focus(); el.value = String(port); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.blur(); }, PORT);
    await sleep(900);
    const enabled = await lib.storageAll(panel);
    const token = enabled.mcpBridgeToken || '';
    result.checks.enable = { storedEnabled: enabled.mcpBridgeEnabled, tokenLength: token.length, storedPort: enabled.mcpBridgePort, allowActionsStillOff: !enabled.mcpBridgeAllowActions, portFieldShows: await panel.inputValue('#settingsMcpPort').catch(() => '<missing>') };
    relay = startRelay(token, PORT);
    const init = await relay.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'release-sweep', version: '1' } });
    relay.notify('notifications/initialized', {});
    const tools = await relay.request('tools/list', {});
    result.checks.relay = { serverInfo: init.result && init.result.serverInfo, tools: ((tools.result && tools.result.tools) || []).map((tool) => tool.name) };
    const pairStarted = Date.now();
    let status = null;
    while (Date.now() - pairStarted < 45000) {
      status = await relay.call('get_status');
      if (status.ok && /"?connected"?\s*[:=]\s*true/i.test(JSON.stringify(status.data)) ) break;
      if (status.ok && status.data && status.data.extensionConnected) break;
      await sleep(1500);
    }
    result.checks.pairing = { secondsToPair: Math.round((Date.now() - pairStarted) / 1000), status: clip(status, 500) };
    result.checks.listenAddress = (() => { try { return execSync(`lsof -nP -iTCP:${PORT} -sTCP:LISTEN | tail -n +2 | awk '{print $9}'`).toString().trim(); } catch (error) { return 'lsof failed'; } })();
    save();

    // 3. Read tools against the seeded data.
    const read = {};
    read.pingIsNotARelayTool = clip(await relay.call('ping'), 120);
    const all = await relay.call('list_orders', { limit: 500 });
    const rows = all.ok ? (Array.isArray(all.data) ? all.data : (all.data.orders || all.data.rows || [])) : [];
    read.list_orders = { ok: all.ok, returned: rows.length, expectedOrders: expected.orders, keys: rows[0] ? Object.keys(rows[0]) : clip(all, 300), envelopeKeys: all.ok && !Array.isArray(all.data) ? Object.keys(all.data) : [] };
    const paged = await relay.call('list_orders', { limit: 3, offset: 2 });
    const pagedRows = paged.ok ? (Array.isArray(paged.data) ? paged.data : (paged.data.orders || paged.data.rows || [])) : [];
    read.list_orders_paged = { ok: paged.ok, returned: pagedRows.length };
    const sample = withInvoice[0];
    const one = await relay.call('get_order', { orderNumber: sample.orderNumber });
    const invoice = one.ok && (one.data.invoice || (one.data.order && one.data.order.invoice));
    read.get_order = { ok: one.ok, hasInvoice: Boolean(invoice), itemsMatch: invoice ? (invoice.items || []).length === sample.invoice.items.length : null, totalMatches: invoice ? Number(invoice.orderTotal) === sample.invoice.orderTotal : null, raw: one.ok ? undefined : clip(one, 200) };
    const search = await relay.call('search_orders', { query: 'Milk' });
    const hits = search.ok ? (Array.isArray(search.data) ? search.data : (search.data.results || search.data.orders || search.data.matches || [])) : [];
    const expectedHits = seeded.filter((record) => [...(record.summary.items || []), ...((record.invoice && record.invoice.items) || [])].some((item) => /milk/i.test(item.name || item.productName || ''))).length;
    read.search_orders = { ok: search.ok, hits: hits.length, expectedOrdersWithMilk: expectedHits, envelopeKeys: search.ok && !Array.isArray(search.data) ? Object.keys(search.data) : [] };
    const spend = await relay.call('spending_summary', {});
    read.spending_summary = { ok: spend.ok, expectedInvoiceTotal: expected.invoiceTotal, expectedInvoices: expected.invoices, returned: clip(spend.ok ? { ...spend.data, months: undefined, byMonth: undefined, perMonth: undefined } : spend, 420), monthKeys: spend.ok ? Object.keys(spend.data) : [] };
    const exported = await relay.call('export_orders', { limit: 500, includeInvoices: true });
    const exportedRows = exported.ok ? (Array.isArray(exported.data) ? exported.data : (exported.data.orders || exported.data.records || [])) : [];
    read.export_orders = { ok: exported.ok, returned: exportedRows.length, withInvoice: exportedRows.filter((row) => row && row.invoice).length, envelopeKeys: exported.ok && !Array.isArray(exported.data) ? Object.keys(exported.data) : [], bytes: JSON.stringify(exported.data || '').length };
    read.list_accounts = clip(await relay.call('list_accounts'), 260);
    read.get_collection_progress = clip(await relay.call('get_collection_progress'), 260);
    read.get_invoice_job = clip(await relay.call('get_invoice_job'), 260);
    result.checks.readTools = read;
    save();

    // 4. Bad input must fail cleanly and leave the bridge working.
    result.checks.badInput = {
      unknownTool: clip(await relay.call('no_such_tool'), 200),
      getOrderNoArgs: clip(await relay.call('get_order', {}), 200),
      getOrderUnknown: clip(await relay.call('get_order', { orderNumber: 'not-a-number' }), 200),
      searchNoQuery: clip(await relay.call('search_orders', {}), 200),
      negativeLimit: clip(await relay.call('list_orders', { limit: -5 }), 160),
      hugeLimit: (() => null)(),
      reversedDates: clip(await relay.call('list_orders', { since: '2030-01-01', until: '2020-01-01' }), 160),
      stillWorksAfter: (await relay.call('get_status')).ok,
    };
    const huge = await relay.call('list_orders', { limit: 100000000 });
    result.checks.badInput.hugeLimit = huge.ok ? `ok, ${(Array.isArray(huge.data) ? huge.data : (huge.data.orders || huge.data.rows || [])).length} rows` : clip(huge, 160);
    save();

    // 5. Action tools: refused while the second toggle is off.
    const tabsBefore = session.context.pages().length;
    result.checks.actionsOff = {
      start_collection: clip(await relay.call('start_collection', { pageLimit: 1 }), 260),
      collect_invoices: clip(await relay.call('collect_invoices', {}), 260),
      stop_collection: clip(await relay.call('stop_collection'), 200),
      cancel_invoice_job: clip(await relay.call('cancel_invoice_job'), 200),
      tabsOpened: session.context.pages().length - tabsBefore,
    };
    save();

    // 6. Action tools with the second toggle on, against the mock Walmart.
    await panel.check('#settingsMcpAllowActions');
    await sleep(1200);
    const on = {};
    on.storedAllowActions = (await lib.storageAll(panel)).mcpBridgeAllowActions;
    on.start_collection = clip(await relay.call('start_collection', { pageLimit: 1, incremental: false }), 260);
    let progress = null;
    for (let i = 0; i < 30; i += 1) { await sleep(1500); progress = await relay.call('get_collection_progress'); if (progress.ok && progress.data && progress.data.isCollecting === false) break; }
    on.collectionFinished = clip(progress, 320);
    const mockOrders = await panel.evaluate(async (ids) => { const out = []; for (const id of ids) { const record = await OrderDb.getOrder(id); out.push({ saved: Boolean(record), hasInvoice: Boolean(record && record.invoice) }); } return out; }, [lib.ONLINE_ORDER, lib.INSTORE_ORDER]);
    on.mockOrdersAfterCollection = mockOrders;
    on.collect_invoices = clip(await relay.call('collect_invoices', { orderNumbers: [lib.ONLINE_ORDER] }), 260);
    let job = null;
    for (let i = 0; i < 40; i += 1) { await sleep(1500); job = await relay.call('get_invoice_job'); if (job.ok && job.data && job.data.running === false) break; }
    on.invoiceJobFinished = clip(job, 320);
    on.onlineOrderHasInvoice = await panel.evaluate((id) => OrderDb.getOrder(id).then((record) => Boolean(record && record.invoice)), lib.ONLINE_ORDER);
    on.cancel_invoice_job_idle = clip(await relay.call('cancel_invoice_job'), 200);
    on.stop_collection_idle = clip(await relay.call('stop_collection'), 200);
    result.checks.actionsOn = on;
    save();

    // 7. Turning the main toggle off disconnects; wrong token never pairs.
    await panel.uncheck('#settingsMcpEnabled');
    await sleep(2500);
    result.checks.afterDisable = { get_status: clip(await relay.call('get_status'), 300), list_orders: clip(await relay.call('list_orders', { limit: 1 }, 20000), 240), storedEnabled: (await lib.storageAll(panel)).mcpBridgeEnabled };
    relay.stop();
    await sleep(800);
    relay = startRelay('wrong-token-' + 'x'.repeat(20), PORT);
    await relay.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'release-sweep', version: '1' } });
    relay.notify('notifications/initialized', {});
    await panel.check('#settingsMcpEnabled');
    await sleep(22000);
    result.checks.wrongToken = { get_status: clip(await relay.call('get_status'), 300), list_orders: clip(await relay.call('list_orders', { limit: 1 }, 20000), 240), relayStderr: relay.stderr.slice(-4) };
    result.extensionErrors = [...new Set(session.errors)].slice(0, 15);
    result.finished = true;
    save();
    console.log('FINISHED');
  } catch (error) {
    result.errors.push(String(error && error.stack ? error.stack : error).slice(0, 600));
    if (session) result.extensionErrors = [...new Set(session.errors)].slice(0, 15);
    if (relay) result.relayStderr = relay.stderr.slice(-6);
    result.finished = false;
    save();
    console.log('FAILED ' + String(error && error.message).slice(0, 200));
  } finally {
    if (relay) relay.stop();
    if (session) await session.close().catch(() => {});
  }
})();
