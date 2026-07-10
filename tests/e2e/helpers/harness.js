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

/** Render the order list in the panel DOM so buttons/checkboxes exist. */
async function renderOrderList(panel, progress) {
  await panel.evaluate(async ({ orderNumbers, additionalFields }) => {
    await window.Sidepanel.view.displayOrderNumbers(orderNumbers, additionalFields);
  }, { orderNumbers: progress.orderNumbers, additionalFields: progress.additionalFields });
  await panel.waitForSelector('#quickExportButton');
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
  clickAndCollectDownloads,
};
