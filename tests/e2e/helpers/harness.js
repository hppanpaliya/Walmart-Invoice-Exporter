/**
 * End-to-end harness: launches Chromium with the packaged extension loaded,
 * intercepts walmart.com and serves synthetic pages built from the sanitized
 * fixtures, and exposes helpers to drive the side-panel page like a user.
 *
 * No real Walmart account, session, or data is involved anywhere.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const { startMockWalmart } = require('./mock-walmart');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const EXTENSION_DIR = path.join(REPO_ROOT, 'dist', 'edge');

const ORDERS_URL = 'https://www.walmart.com/orders';
const ONLINE_ORDER = '200010000000042';
const INSTORE_ORDER = '77501234567890123456';

/** Build the clean packaged extension dir (same file set the store gets). */
function buildExtension() {
  execFileSync('bash', ['scripts/build-edge.sh'], { cwd: REPO_ROOT, stdio: 'pipe' });
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) {
    throw new Error('build-edge.sh did not produce dist/edge');
  }
}

/**
 * Launch Chromium with the extension and walmart.com interception.
 * @returns {Promise<{context, extensionId, panel, userDataDir}>}
 */
async function launch() {
  buildExtension();

  // Browser-level mock: tabs the EXTENSION opens bypass Playwright's route
  // API, so interception must happen at the network layer via a proxy.
  const mock = await startMockWalmart();

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wie-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', // new headless mode — supports extensions
    headless: true,
    acceptDownloads: true,
    proxy: { server: `http://127.0.0.1:${mock.proxyPort}` },
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      '--ignore-certificate-errors', // self-signed walmart cert from the mock
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  }
  const extensionId = new URL(worker.url()).host;

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.waitForFunction(() => window.Sidepanel && window.Sidepanel.download);

  const close = async () => {
    await context.close();
    await mock.close();
  };

  return { context, extensionId, panel, userDataDir, close };
}

/**
 * Run a full collection through the real background service worker and wait
 * for it to finish. Returns the final GET_PROGRESS response.
 */
async function collectOrders(panel) {
  await panel.evaluate((ordersUrl) => {
    window.Sidepanel.state.app.currentOrdersUrl = ordersUrl;
    return new Promise((resolve) =>
      chrome.runtime.sendMessage(
        { action: 'startCollection', url: ordersUrl, pageLimit: 0, incremental: false },
        resolve
      )
    );
  }, ORDERS_URL);

  // Poll from Node — an async predicate inside waitForFunction would return
  // a (truthy) Promise and pass immediately.
  const deadline = Date.now() + 30000;
  for (;;) {
    const progress = await panel.evaluate(
      () => new Promise((resolve) => chrome.runtime.sendMessage({ action: 'getProgress' }, resolve))
    );
    if (progress && !progress.isCollecting && progress.orderNumbers.length > 0) {
      return progress;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `collection did not finish: isCollecting=${progress && progress.isCollecting} ` +
        `orders=${progress ? progress.orderNumbers.length : 'n/a'} page=${progress && progress.currentPage}`
      );
    }
    await panel.waitForTimeout(500);
  }
}

/**
 * Render the order list in the panel DOM so buttons/checkboxes exist.
 * The v7.1 redesign (spec addendum 2026-07-17) hides the entire list +
 * download section behind body.first-run until view.updateMacroState(true)
 * runs — the panel's own flow (sidepanel.actions.js) does this itself from
 * displayOrdersFromDb/renderOrderList, but this harness calls
 * displayOrderNumbers directly (bypassing that layer) to render deterministically
 * for tests, so it must flip the macro state itself too.
 */
async function renderOrderList(panel, progress) {
  await panel.evaluate(async ({ orderNumbers, additionalFields }) => {
    window.Sidepanel.view.updateMacroState(true);
    await window.Sidepanel.view.displayOrderNumbers(orderNumbers, additionalFields);
  }, { orderNumbers: progress.orderNumbers, additionalFields: progress.additionalFields });
  await panel.waitForSelector('#singleFileDownload');
}

/**
 * Seed OrderDb with a deterministic, PII-free order history: `months`
 * months walking back from the current month, 2-3 orders each, every 6th
 * order summary-only (stored but never downloaded). Anchored to the real
 * current date so date-scoped features ("This year") always have data.
 * Returns the seeded records.
 */
async function seedOrderHistory(panel, { months = 14 } = {}) {
  const catalog = [
    ['Great Value Whole Milk, 1 Gallon', 3.98],
    ['Bananas, each', 0.28],
    ['Tide PODS Laundry Detergent, 42 ct', 12.97],
    ['Eggs, Large, 12 ct', 2.52],
    ['Chobani Greek Yogurt 4-pack', 4.48],
    ['Charmin Ultra Soft, 12 Mega Rolls', 13.24],
  ];
  const now = new Date();
  const records = [];
  let n = 0;
  for (let m = 0; m < months; m += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, 12);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-12`;
    const perMonth = m % 3 === 0 ? 3 : 2;
    for (let k = 0; k < perMonth; k += 1) {
      n += 1;
      const orderNumber = `20009900000${String(1000 + n)}`;
      const picked = catalog.slice(0, 2 + ((m + k) % 4));
      const drift = 1 + m * 0.015; // older months slightly cheaper
      const lineItems = picked.map(([name, price], i) => ({
        name,
        quantity: 1 + ((k + i) % 2),
        price: Number((price / drift).toFixed(2)),
      }));
      const subtotal = lineItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const tax = subtotal * 0.0825;
      const total = subtotal + tax;
      const summaryOnly = n % 6 === 0;
      records.push({
        orderNumber,
        summaryOnly,
        summary: {
          orderDate: iso,
          orderTotal: Number(total.toFixed(2)),
          subTotal: Number(subtotal.toFixed(2)),
          itemCount: lineItems.length,
          status: 'Delivered',
          items: lineItems.map((item) => ({ name: item.name, quantity: item.quantity })),
        },
        invoice: summaryOnly ? null : {
          schemaVersion: 3,
          orderDate: iso,
          orderNumber,
          orderSubtotal: Number(subtotal.toFixed(2)),
          tax: Number(tax.toFixed(2)),
          tip: 0,
          orderTotal: Number(total.toFixed(2)),
          savings: m % 2 === 0 ? Number((subtotal * 0.05).toFixed(2)) : 0,
          items: lineItems.map((item) => ({ productName: item.name, quantity: item.quantity, price: item.price })),
        },
      });
    }
  }
  await panel.evaluate(async (seeded) => {
    const summaries = {};
    for (const record of seeded) summaries[record.orderNumber] = record.summary;
    await OrderDb.putSummaries(summaries, {});
    for (const record of seeded) {
      if (record.invoice) await OrderDb.putInvoice(record.orderNumber, record.invoice);
    }
  }, records);
  return records;
}

/** Click a button and capture the next N downloads it triggers. */
async function clickAndCollectDownloads(panel, selector, expectedCount, timeoutMs = 30000) {
  const downloads = [];
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out: got ${downloads.length}/${expectedCount} downloads`)),
      timeoutMs
    );
    panel.on('download', async (download) => {
      downloads.push({ name: download.suggestedFilename(), path: await download.path() });
      if (downloads.length >= expectedCount) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await panel.click(selector);
  await done;
  return downloads;
}

module.exports = {
  REPO_ROOT,
  ORDERS_URL,
  ONLINE_ORDER,
  INSTORE_ORDER,
  launch,
  collectOrders,
  renderOrderList,
  seedOrderHistory,
  clickAndCollectDownloads,
};
