'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, evalIn, toPlain } = require('./helpers/sandbox');

/** background.js pulls in utils.js + orderdb.js itself via importScripts. */
function loadBackgroundSandbox() {
  return loadSandbox({ scripts: ['background.js'] });
}

function getProgress(sandbox, request = {}) {
  return new Promise((resolve) => sandbox.handleGetProgress(request, resolve));
}

function stopCollection(sandbox, request = {}) {
  return new Promise((resolve) => sandbox.handleStopCollection(request, resolve));
}

function resetSessionState(sandbox, request = {}) {
  return new Promise((resolve) => sandbox.handleResetSessionState(request, resolve));
}

const SESSION_KEY = 'walmart_collection_session';

test('CollectionState now mirrors to chrome.storage.session under a dedicated key (not the legacy local one)', () => {
  const sandbox = loadBackgroundSandbox();
  const CollectionState = evalIn(sandbox, 'CollectionState');
  assert.equal(CollectionState.sessionKey, SESSION_KEY);
  assert.equal(evalIn(sandbox, 'CONSTANTS.CACHE_KEYS.ORDER_COLLECTION'), 'walmart_order_cache');
});

test('handleGetProgress: idle with nothing in session returns clean defaults', async () => {
  const sandbox = loadBackgroundSandbox();

  const response = await getProgress(sandbox);

  assert.deepEqual(toPlain(response), {
    currentPage: 1,
    pageLimit: 0,
    orderNumbers: [],
    additionalFields: {},
    orderSummaries: {},
    isCollecting: false,
  });
});

test('handleGetProgress: hydrates order data left over in chrome.storage.session (a worker restart is recoverable)', async () => {
  const sandbox = loadBackgroundSandbox();
  // Simulate a PRIOR worker instance's last mirrored snapshot, as if this
  // worker had just been (re)spawned after Chrome evicted the old one.
  await new Promise((resolve) =>
    sandbox.chrome.storage.session.set(
      {
        [SESSION_KEY]: {
          orderNumbers: ['111', '222'],
          additionalFields: { '111': 'Groceries' },
          orderSummaries: { '111': { orderTotal: '$9.99' } },
          currentPage: 3,
          pageLimit: 5,
          isCollecting: true, // stale — the worker that wrote this is gone
        },
      },
      resolve
    )
  );

  const response = await getProgress(sandbox);

  assert.deepEqual([...response.orderNumbers].sort(), ['111', '222']);
  assert.equal(response.additionalFields['111'], 'Groceries');
  assert.equal(response.currentPage, 3);
  assert.equal(response.pageLimit, 5);
  // The critical property: a dead worker's stale "isCollecting: true" must
  // NEVER be surfaced — only the CURRENT (fresh) instance's live state can
  // claim to be actively collecting, or the panel would show a spinner
  // that can never stop.
  assert.equal(response.isCollecting, false);
});

test('handleGetProgress: while genuinely collecting, in-memory state is authoritative (no session read)', async () => {
  const sandbox = loadBackgroundSandbox();
  const CollectionState = evalIn(sandbox, 'CollectionState');
  CollectionState.isCollecting = true;
  CollectionState.allOrderNumbers.add('live-1');
  CollectionState.currentPage = 2;

  // Session storage (if any) must be ignored entirely on this path.
  await new Promise((resolve) =>
    sandbox.chrome.storage.session.set(
      { [SESSION_KEY]: { orderNumbers: ['stale'], isCollecting: false, currentPage: 99 } },
      resolve
    )
  );

  const response = await getProgress(sandbox);

  assert.equal(response.isCollecting, true);
  assert.deepEqual(toPlain(response.orderNumbers), ['live-1']);
  assert.equal(response.currentPage, 2);
});

test('handleStopCollection: the idle branch also hydrates from session instead of reporting fresh-worker defaults', async () => {
  const sandbox = loadBackgroundSandbox();
  await new Promise((resolve) =>
    sandbox.chrome.storage.session.set(
      { [SESSION_KEY]: { orderNumbers: ['777'], currentPage: 4, additionalFields: {}, orderSummaries: {} } },
      resolve
    )
  );

  const response = await stopCollection(sandbox);

  assert.equal(response.status, 'idle');
  assert.equal(response.currentPage, 4);
  assert.deepEqual(toPlain(response.orderNumbers), ['777']);
});

test('handleResetSessionState: removes the session key and resets in-memory state', async () => {
  const sandbox = loadBackgroundSandbox();
  const CollectionState = evalIn(sandbox, 'CollectionState');
  CollectionState.allOrderNumbers.add('abc');
  sandbox.saveSessionState();
  // Let the (microtask-queued) fake storage.session.set land.
  await Promise.resolve();
  await Promise.resolve();

  const response = await resetSessionState(sandbox);

  assert.equal(response.status, 'session_state_reset');
  assert.equal(sandbox.chrome.storage.session._dump()[SESSION_KEY], undefined);
  assert.equal(CollectionState.allOrderNumbers.size, 0);
});

test('saveSessionState/loadSessionState round-trip through chrome.storage.session', async () => {
  const sandbox = loadBackgroundSandbox();
  const CollectionState = evalIn(sandbox, 'CollectionState');
  CollectionState.allOrderNumbers.add('42');
  CollectionState.allAdditionalFields['42'] = 'Round trip order';
  CollectionState.currentPage = 5;
  sandbox.saveSessionState();
  await Promise.resolve();
  await Promise.resolve();

  // Simulate the worker dying and a brand new one starting from scratch.
  CollectionState.allOrderNumbers = new Set();
  CollectionState.allAdditionalFields = {};
  CollectionState.currentPage = 1;

  await new Promise((resolve) => { sandbox.loadSessionState().then(resolve); });

  assert.deepEqual([...CollectionState.allOrderNumbers], ['42']);
  assert.equal(CollectionState.allAdditionalFields['42'], 'Round trip order');
  assert.equal(CollectionState.currentPage, 5);
});

test('handleStartCollection refuses to double-start while already collecting', async () => {
  const sandbox = loadBackgroundSandbox();
  const CollectionState = evalIn(sandbox, 'CollectionState');
  CollectionState.isCollecting = true;
  const tabCreateCallsBefore = sandbox.chrome.tabs._calls.create.length;

  const response = await new Promise((resolve) =>
    sandbox.handleStartCollection({ url: 'https://www.walmart.com/orders', pageLimit: 0 }, resolve)
  );

  assert.equal(response.status, 'started');
  assert.equal(sandbox.chrome.tabs._calls.create.length, tabCreateCallsBefore, 'must not open a second collection tab');
});
