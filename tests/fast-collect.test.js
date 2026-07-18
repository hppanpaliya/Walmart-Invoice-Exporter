'use strict';

/**
 * Fast Collect (optional `fastFetch` setting): the whole purchase history is
 * pulled in one content-script call by replaying Walmart's own
 * PurchaseHistoryV3 request page by page, in-page, with the user's live
 * session. These tests drive PurchaseHistoryDataSource.collectAllViaFetch with
 * a fake __NEXT_DATA__ (page 1) and a stubbed fetch (pages 2+), and assert:
 *   - every page is collected with its real date (the "no date past page 1"
 *     cure — page 2+ come from full dated payloads, not the DOM),
 *   - pagination follows the cursor to the end,
 *   - the request carries the Akamai-clearing Apollo headers + credentials,
 *   - it falls back to the classic loop when the query hash can't be resolved.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, evalIn, toPlain } = require('./helpers/sandbox');

const HASH = 'a'.repeat(64);
const ENDPOINT = '/orchestra/cph/graphql/PurchaseHistoryV3/';

/** A minimal purchase-history order node buildSnapshot understands. */
function order(id, iso, title) {
  return { id, orderDate: iso, title, groups: [], priceDetails: {} };
}

/** Page-1 __NEXT_DATA__ carrying `orders` and a next-page cursor. */
function nextDataWith(orders, nextPageCursor) {
  return {
    props: {
      pageProps: {
        phRedesignInitialData: {
          data: { purchaseHistory: { orders, pageInfo: { nextPageCursor } } },
        },
      },
    },
  };
}

/** A GraphQL fetch response body (what pages 2+ return). */
function apiBody(orders, nextPageCursor) {
  return { data: { purchaseHistory: { orders, pageInfo: { nextPageCursor } } } };
}

/** Install a fetch stub that serves a queue of page bodies, recording calls. */
function stubFetch(sandbox, bodies) {
  const calls = [];
  let i = 0;
  sandbox.fetch = (url, opts) => {
    calls.push({ url, opts });
    const body = bodies[i++] || apiBody([], null);
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  };
  return calls;
}

test('collectAllViaFetch: pages the whole history via cursor, every page fully dated', async () => {
  const sandbox = loadSandbox({
    nextData: nextDataWith([order('200000000000001', '2026-03-04T10:00:00-08:00', 'Mar 04, 2026 order')], 'c1'),
    scripts: ['utils.js', 'providers/base.js', 'providers/registry.js', 'providers/walmart-us.js', 'flags.js'],
  });
  // Cached hash ⇒ no seeding click needed.
  sandbox.chrome.storage.local.set({ wm_ph_signature: { hash: HASH } });

  const calls = stubFetch(sandbox, [
    apiBody([order('200000000000002', '2026-02-28T10:00:00-08:00', 'Feb 28, 2026 order')], 'c2'),
    apiBody([order('200000000000003', '2026-01-24T10:00:00-05:00', 'Jan 24, 2026 order')], null),
  ]);

  const result = await evalIn(sandbox, 'PurchaseHistoryDataSource.collectAllViaFetch({})');
  const plain = toPlain(result);

  assert.equal(result.fast, true);
  assert.equal(result.hasNextPage, false);
  assert.equal(result.pages, 3, 'page 1 (__NEXT_DATA__) + two API pages');
  assert.deepEqual(plain.orderNumbers, [
    '200000000000001',
    '200000000000002',
    '200000000000003',
  ]);

  // The date-bug cure: every page — not just page 1 — carries its order date.
  assert.ok(plain.orderSummaries['200000000000001'].orderDate, 'page 1 dated');
  assert.ok(plain.orderSummaries['200000000000002'].orderDate, 'page 2 dated');
  assert.ok(plain.orderSummaries['200000000000003'].orderDate, 'page 3 dated');

  // Two API calls (pages 2 and 3); page 1 needed none.
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.startsWith(ENDPOINT + HASH), 'replays the captured PurchaseHistoryV3 hash');
  assert.equal(calls[0].opts.credentials, 'include', 'sends the live session cookies');
  assert.equal(
    calls[0].opts.headers['X-APOLLO-OPERATION-NAME'],
    'PurchaseHistoryV3',
    'carries the Apollo marker that clears Akamai'
  );
});

test('collectAllViaFetch: a 429 throttle is retried with backoff, not abandoned', async () => {
  const sandbox = loadSandbox({
    nextData: nextDataWith([order('200000000000001', '2026-03-04T10:00:00-08:00', 'Mar 04, 2026 order')], 'c1'),
    scripts: ['utils.js', 'providers/base.js', 'providers/registry.js', 'providers/walmart-us.js', 'flags.js'],
  });
  sandbox.chrome.storage.local.set({ wm_ph_signature: { hash: HASH } });

  // First API call is throttled (429), then it succeeds on retry.
  let n = 0;
  const statuses = [];
  sandbox.fetch = () => {
    n += 1;
    statuses.push(n);
    if (n === 1) return Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(apiBody([order('200000000000002', '2026-02-28T10:00:00-08:00', 'Feb 28, 2026 order')], null)),
    });
  };

  const result = await evalIn(sandbox, 'PurchaseHistoryDataSource.collectAllViaFetch({})');
  const plain = toPlain(result);

  assert.equal(plain.pages, 2, 'the retry recovered page 2 rather than falling back');
  assert.deepEqual(plain.orderNumbers, ['200000000000001', '200000000000002']);
  assert.ok(n >= 2, 'the throttled call was retried');
});

test('collectAllViaFetch: a single-page history needs no network at all', async () => {
  const sandbox = loadSandbox({
    nextData: nextDataWith([order('200000000000009', '2026-07-01T10:00:00-07:00', 'Jul 01, 2026 order')], null),
    scripts: ['utils.js', 'providers/base.js', 'providers/registry.js', 'providers/walmart-us.js', 'flags.js'],
  });
  const calls = stubFetch(sandbox, []);

  const result = await evalIn(sandbox, 'PurchaseHistoryDataSource.collectAllViaFetch({})');
  const plain = toPlain(result);

  assert.equal(result.pages, 1);
  assert.deepEqual(plain.orderNumbers, ['200000000000009']);
  assert.equal(calls.length, 0, 'no cursor ⇒ no API request');
});

test('collectAllViaFetch: honors a page limit', async () => {
  const sandbox = loadSandbox({
    nextData: nextDataWith([order('200000000000001', '2026-03-04T10:00:00-08:00', 'a')], 'c1'),
    scripts: ['utils.js', 'providers/base.js', 'providers/registry.js', 'providers/walmart-us.js', 'flags.js'],
  });
  sandbox.chrome.storage.local.set({ wm_ph_signature: { hash: HASH } });
  const calls = stubFetch(sandbox, [
    apiBody([order('200000000000002', '2026-02-28T10:00:00-08:00', 'b')], 'c2'),
    apiBody([order('200000000000003', '2026-01-24T10:00:00-05:00', 'c')], 'c3'),
  ]);

  const result = await evalIn(sandbox, 'PurchaseHistoryDataSource.collectAllViaFetch({ pageLimit: 2 })');
  const plain = toPlain(result);

  assert.equal(result.pages, 2, 'page 1 + exactly one API page, then stops at the limit');
  assert.equal(calls.length, 1);
});

test('collectAllViaFetch: uses the bundled default hash with no cached hash and no clicks', async () => {
  const sandbox = loadSandbox({
    // Multi-page history, but NO cached hash and NO Next button in the DOM.
    // The bundled default hash lets it fetch anyway — zero clicks, no fallback.
    nextData: nextDataWith([order('200000000000001', '2026-03-04T10:00:00-08:00', 'a')], 'c1'),
    scripts: ['utils.js', 'providers/base.js', 'providers/registry.js', 'providers/walmart-us.js', 'flags.js'],
  });
  const calls = stubFetch(sandbox, [
    apiBody([order('200000000000002', '2026-02-28T10:00:00-08:00', 'b')], null),
  ]);

  const result = await evalIn(sandbox, 'PurchaseHistoryDataSource.collectAllViaFetch({})');
  const plain = toPlain(result);

  assert.equal(plain.fast, true, 'proceeds via fetch rather than falling back');
  assert.equal(plain.pages, 2);
  assert.deepEqual(plain.orderNumbers, ['200000000000001', '200000000000002']);
  assert.equal(calls.length, 1, 'fetched page 2 with the default hash — no seed click needed');
});

test('getBestSnapshot: page 1 with a next-page cursor reports hasNextPage (crawl must continue)', async () => {
  const sandbox = loadSandbox({
    nextData: nextDataWith([order('200000000000001', '2026-03-04T10:00:00-08:00', 'Mar 04, 2026 order')], 'n123'),
    scripts: ['utils.js', 'providers/base.js', 'providers/registry.js', 'providers/walmart-us.js', 'flags.js'],
  });

  const snap = toPlain(await evalIn(sandbox, 'PurchaseHistoryDataSource.getBestSnapshot({ currentPage: 1 })'));

  assert.ok(snap, 'page 1 snapshot present from __NEXT_DATA__');
  assert.deepEqual(snap.orderNumbers, ['200000000000001']);
  assert.equal(snap.hasNextPage, true, 'a present cursor MUST tell the loop to advance past page 1');
  assert.ok(snap.orderSummaries['200000000000001'].orderDate, 'page 1 is dated');
});

test('getBestSnapshot: page 1 with NO cursor reports the end of the list', async () => {
  const sandbox = loadSandbox({
    nextData: nextDataWith([order('200000000000009', '2026-07-01T10:00:00-07:00', 'Jul 01, 2026 order')], null),
    scripts: ['utils.js', 'providers/base.js', 'providers/registry.js', 'providers/walmart-us.js', 'flags.js'],
  });

  const snap = toPlain(await evalIn(sandbox, 'PurchaseHistoryDataSource.getBestSnapshot({ currentPage: 1 })'));

  assert.equal(snap.hasNextPage, false, 'no cursor ⇒ single page');
});

test('replayPage: re-fetches a known page as a dated snapshot; unknown page ⇒ null', async () => {
  const sandbox = loadSandbox({
    nextData: nextDataWith([order('200000000000001', '2026-03-04T10:00:00-08:00', 'a')], 'c1'),
    scripts: ['utils.js', 'providers/base.js', 'providers/registry.js', 'providers/walmart-us.js', 'flags.js'],
  });
  sandbox.chrome.storage.local.set({ wm_ph_signature: { hash: HASH } });
  const calls = stubFetch(sandbox, [
    apiBody([order('200000000000002', '2026-02-28T10:00:00-08:00', 'Feb 28, 2026 order')], 'c2'),
  ]);

  // Page 1's forward cursor becomes page 2's fetch cursor (as classic collection
  // records it after collecting page 1).
  await evalIn(sandbox, "PurchaseHistoryDataSource.noteCursor(1, 'c1')");
  const snap = toPlain(await evalIn(sandbox, 'PurchaseHistoryDataSource.replayPage(2)'));

  assert.ok(snap, 'page 2 replayed');
  assert.deepEqual(snap.orderNumbers, ['200000000000002']);
  assert.ok(snap.orderSummaries['200000000000002'].orderDate, 'replayed page is dated (no DOM, no NO DATE)');
  assert.equal(calls[0].opts.credentials, 'include');

  // A page we have no cursor for cannot be replayed.
  const none = await evalIn(sandbox, 'PurchaseHistoryDataSource.replayPage(9)');
  assert.equal(none, null);
});

test('collectAllViaFetch: a rotated hash / throttle still returns page 1 and does NOT fall back to the crawl', async () => {
  const sandbox = loadSandbox({
    // Page 1 always comes from __NEXT_DATA__, so even when every API request
    // fails the run keeps page 1 and reports fast:true — it must never degrade
    // into the slow page-by-page crawl just because the API is unhappy.
    nextData: nextDataWith([order('200000000000001', '2026-03-04T10:00:00-08:00', 'Mar 04, 2026 order')], 'c1'),
    scripts: ['utils.js', 'providers/base.js', 'providers/registry.js', 'providers/walmart-us.js', 'flags.js'],
  });
  sandbox.chrome.storage.local.set({ wm_ph_signature: { hash: HASH } });
  // 418 = a bad/rotated persisted-query hash (not retried).
  sandbox.fetch = () => Promise.resolve({ ok: false, status: 418, json: () => Promise.resolve({}) });

  const result = await evalIn(sandbox, 'PurchaseHistoryDataSource.collectAllViaFetch({})');
  const plain = toPlain(result);

  assert.equal(plain.fast, true, 'still a fast-mode result, not a classic fallback');
  assert.notEqual(plain.fallbackToClassic, true);
  assert.deepEqual(plain.orderNumbers, ['200000000000001'], 'page 1 survived');
  assert.ok(plain.orderSummaries['200000000000001'].orderDate, 'page 1 dated');
});

test('collectAllViaFetch: falls back to classic only when the request truly cannot yield orders', async () => {
  const sandbox = loadSandbox({
    // No __NEXT_DATA__ orders at all, and every fetch errors — nothing can be
    // collected via the request path, so it asks for the classic DOM loop.
    nextData: null,
    scripts: ['utils.js', 'providers/base.js', 'providers/registry.js', 'providers/walmart-us.js', 'flags.js'],
  });
  sandbox.fetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });

  const result = await evalIn(sandbox, 'PurchaseHistoryDataSource.collectAllViaFetch({})');
  const plain = toPlain(result);

  assert.deepEqual(plain, { fallbackToClassic: true });
});
