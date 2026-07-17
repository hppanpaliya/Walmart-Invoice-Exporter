/**
 * Upgrade-path e2e: simulates a real user updating from v6.25 (chrome.storage
 * invoice/collection caches) to v6.26 (IndexedDB single source of truth).
 *
 * Seeds the exact legacy storage shapes the old version wrote, reloads the
 * panel (which runs migrateLegacyStorage on init), and asserts:
 *   1. legacy invoices land in OrderDb (nothing lost),
 *   2. malformed legacy entries are skipped (nothing fabricated),
 *   3. both retired chrome.storage keys are removed,
 *   4. old per-key settings survive untouched,
 *   5. the migrated invoice powers an instant single-file export with NO
 *      order tab opened (the IndexedDB fast path).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { launch, renderOrderList, clickAndCollectDownloads } = require('./helpers/harness');

const MIGRATED_ORDER = '200099000000777';

const LEGACY_INVOICE = {
  orderNumber: MIGRATED_ORDER,
  orderDate: 'Jul 1, 2026',
  orderTotal: '$12.34',
  orderSubtotal: '$11.00',
  schemaVersion: 3,
  items: [{ productName: 'Migrated Widget', quantity: '1', price: '$12.34' }],
};

test('upgrade from v6.25 storage: data migrates, keys are removed, export needs no tab', async (t) => {
  const { context, panel, close } = await launch();
  t.after(close);

  // --- Simulate the pre-upgrade state the old version left behind ---------
  await panel.evaluate(
    ({ order, invoice }) =>
      new Promise((resolve) =>
        chrome.storage.local.set(
          {
            walmart_invoice_cache: {
              [order]: { data: invoice, timestamp: Date.now() - 60 * 60 * 1000 },
              // A cleared/malformed legacy entry — must be skipped, not stored.
              '200099000000888': { data: null, timestamp: Date.now() },
            },
            walmart_order_cache: {
              orderNumbers: [order],
              additionalFields: { [order]: 'Delivered Jul 2' },
              orderSummaries: {},
              pagesCached: { 1: { hasNextPage: false, orderNumbers: [order], timestamp: Date.now() } },
              timestamp: Date.now() - 60 * 60 * 1000,
            },
            exportFormat: 'xlsx',
            includeThumbnails: false,
          },
          resolve
        )
      ),
    { order: MIGRATED_ORDER, invoice: LEGACY_INVOICE }
  );

  // --- "Upgrade": reload the panel so init runs migrateLegacyStorage ------
  await panel.reload();
  await panel.waitForFunction(() => window.Sidepanel && window.Sidepanel.download);

  // Migration is awaited during init, but poll defensively for the worker
  // copy too (both contexts run it; either may win the race — idempotent).
  await panel.waitForFunction(
    () =>
      new Promise((resolve) =>
        chrome.storage.local.get(['walmart_invoice_cache', 'walmart_order_cache'], (r) =>
          resolve(!('walmart_invoice_cache' in r) && !('walmart_order_cache' in r))
        )
      ),
    { timeout: 10000 }
  );

  // --- 1+2: the good invoice migrated; the malformed one did not ----------
  const migrated = await panel.evaluate(
    (order) => OrderDb.getOrder(order),
    MIGRATED_ORDER
  );
  assert.ok(migrated && migrated.invoice, 'legacy invoice should exist in OrderDb after upgrade');
  assert.equal(migrated.invoice.items[0].productName, 'Migrated Widget');
  assert.equal(Number(migrated.invoice.schemaVersion), 3);

  const junk = await panel.evaluate(() => OrderDb.getOrder('200099000000888'));
  assert.ok(!junk || !junk.invoice, 'malformed legacy entry must not become an invoice');

  // --- 4: untouched settings keys survive ---------------------------------
  const settings = await panel.evaluate(
    () => new Promise((resolve) => chrome.storage.local.get(['exportFormat'], resolve))
  );
  assert.equal(settings.exportFormat, 'xlsx', 'settings keys must survive migration');

  // --- 5: migrated data powers an instant, tab-free export ----------------
  await renderOrderList(panel, {
    orderNumbers: [MIGRATED_ORDER],
    additionalFields: { [MIGRATED_ORDER]: 'Delivered Jul 2' },
  });
  await panel.click(`input[value="${MIGRATED_ORDER}"]`);

  let openedTabs = 0;
  context.on('page', () => openedTabs++);

  const [download] = await clickAndCollectDownloads(panel, '#singleFileDownload', 1, 30000);
  assert.ok(download.name.endsWith('.xlsx'), `expected an xlsx download, got ${download.name}`);
  assert.equal(openedTabs, 0, 'export of a migrated order must not open any tab');
});
