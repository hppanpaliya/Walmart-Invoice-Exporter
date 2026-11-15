'use strict';
// Shared launcher for the verification scripts in this directory. Never builds:
// build first (wxt build) or point WIE_EXT at an unpacked build.
// Synthetic data and the mock Walmart only.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Repository root (this file lives in .opencode/skills/release-verification/scripts).
const RB = process.env.WIE_REPO || path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_EXT = process.env.WIE_EXT || path.join(RB, 'dist', 'chrome-mv3');
const { chromium } = require(path.join(RB, 'node_modules/playwright'));
const ExcelJS = require(path.join(RB, 'node_modules/exceljs'));
const { startMockWalmart } = require(path.join(RB, 'tests/e2e/helpers/mock-walmart.js'));
// Only the non-building helpers are used from the repo harness (never launch()).
const harness = require(path.join(RB, 'tests/e2e/helpers/harness.js'));

async function launchExt({ extDir, profileDir = null, mockOptions = {}, waitForPanelApi = true }) {
  const mock = await startMockWalmart(mockOptions);
  const userDataDir = profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'wie-sw-'));
  let context;
  const close = async () => {
    try { if (context) await context.close(); } finally {
      try { await mock.close(); } finally { if (!profileDir) fs.rmSync(userDataDir, { recursive: true, force: true }); }
    }
  };
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium', headless: true, acceptDownloads: true,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--ignore-certificate-errors', '--disable-quic', '--disable-background-networking'],
      proxy: { server: `http://127.0.0.1:${mock.proxyPort}` },
    });
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).host;
    const errors = [];
    const clip = (text) => String(text || '').replace(/\s+/g, ' ').slice(0, 220);
    const watch = (page, tag) => {
      page.on('pageerror', (error) => errors.push(`${tag}: ${clip(error.message)}`));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(`${tag}: ${clip(message.text())}`); });
      return page;
    };
    worker.on('console', (message) => { if (message.type() === 'error') errors.push(`worker: ${clip(message.text())}`); });
    const panel = watch(await context.newPage(), 'panel');
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    if (waitForPanelApi) await panel.waitForFunction(() => window.Sidepanel && window.Sidepanel.download, null, { timeout: 15000 });
    else await panel.waitForSelector('#startCollection', { timeout: 15000 });
    return { context, worker, extensionId, panel, errors, watch, close };
  } catch (error) {
    await close();
    throw error;
  }
}

const storageAll = (page) => page.evaluate(() => new Promise((resolve) => chrome.storage.local.get(null, resolve)));

// Every IndexedDB record of the extension origin, as JSON strings keyed by store and key.
const dumpIndexedDb = (page) => page.evaluate(async () => {
  const out = [];
  const dbs = await indexedDB.databases();
  for (const info of dbs) {
    const db = await new Promise((resolve, reject) => { const req = indexedDB.open(info.name); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const stores = {};
    for (const name of [...db.objectStoreNames]) {
      const tx = db.transaction(name, 'readonly');
      const store = tx.objectStore(name);
      const keys = await new Promise((resolve) => { const req = store.getAllKeys(); req.onsuccess = () => resolve(req.result); });
      const values = await new Promise((resolve) => { const req = store.getAll(); req.onsuccess = () => resolve(req.result); });
      const records = {};
      keys.forEach((key, index) => { records[JSON.stringify(key)] = JSON.stringify(values[index]); });
      stores[name] = records;
    }
    out.push({ name: info.name, version: db.version, stores });
    db.close();
  }
  return out;
});

module.exports = { RB, DEFAULT_EXT, chromium, ExcelJS, launchExt, storageAll, dumpIndexedDb, ...harness };
