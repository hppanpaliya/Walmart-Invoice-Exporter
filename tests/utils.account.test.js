'use strict';

/**
 * Pure multi-account helpers (utils.js): mapping summary keys to switcher
 * selection values, stable "Account N" ordinals, display names, and picking
 * the default account. All DOM-free, so tested directly in the sandbox.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox, evalIn, toPlain } = require('./helpers/sandbox');

function loadUtils() {
  return loadSandbox({ scripts: ['utils.js'] });
}

test('accountSelectionValue: real key passes through; null → UNTAGGED sentinel', () => {
  const sandbox = loadUtils();
  const UNTAGGED = evalIn(sandbox, 'CONSTANTS.ACCOUNTS.UNTAGGED');
  assert.equal(sandbox.accountSelectionValue('KEY_A'), 'KEY_A');
  assert.equal(sandbox.accountSelectionValue(null), UNTAGGED);
  assert.equal(sandbox.accountSelectionValue(undefined), UNTAGGED);
});

test('assignAccountOrdinals: numbers new accounts, never renumbers existing, skips untagged', () => {
  const sandbox = loadUtils();
  const UNTAGGED = evalIn(sandbox, 'CONSTANTS.ACCOUNTS.UNTAGGED');

  const first = toPlain(sandbox.assignAccountOrdinals(['KEY_A', 'KEY_B'], {}));
  assert.deepEqual(first, { KEY_A: 1, KEY_B: 2 });

  // A new account appears; existing numbers are frozen, new one continues.
  const second = toPlain(sandbox.assignAccountOrdinals(['KEY_B', 'KEY_C', 'KEY_A'], first));
  assert.equal(second.KEY_A, 1);
  assert.equal(second.KEY_B, 2);
  assert.equal(second.KEY_C, 3);

  // The untagged bucket never gets an ordinal.
  const withUntagged = toPlain(sandbox.assignAccountOrdinals([UNTAGGED, 'KEY_A'], {}));
  assert.equal(withUntagged[UNTAGGED], undefined);
  assert.equal(withUntagged.KEY_A, 1);
});

test('accountDisplayName: custom label wins, else "Account N", else "Earlier orders" for untagged', () => {
  const sandbox = loadUtils();
  const UNTAGGED = evalIn(sandbox, 'CONSTANTS.ACCOUNTS.UNTAGGED');
  const maps = { labels: { KEY_A: 'Work' }, ordinals: { KEY_A: 1, KEY_B: 2 } };

  assert.equal(sandbox.accountDisplayName('KEY_A', maps), 'Work');
  assert.equal(sandbox.accountDisplayName('KEY_B', maps), 'Account 2');
  assert.equal(sandbox.accountDisplayName(UNTAGGED, maps), 'Earlier orders');
  assert.equal(sandbox.accountDisplayName(null, maps), 'All accounts');
  // A key with neither label nor ordinal degrades gracefully.
  assert.equal(sandbox.accountDisplayName('KEY_Z', maps), 'Account');
});

test('resolveSelectedAccount: keeps a still-valid stored choice, else most-recently-used', () => {
  const sandbox = loadUtils();
  const UNTAGGED = evalIn(sandbox, 'CONSTANTS.ACCOUNTS.UNTAGGED');
  // getAccountSummaries returns MRU-first.
  const summaries = [{ accountKey: 'KEY_B' }, { accountKey: 'KEY_A' }, { accountKey: null }];

  assert.equal(sandbox.resolveSelectedAccount(summaries, 'KEY_A'), 'KEY_A', 'valid stored choice kept');
  assert.equal(sandbox.resolveSelectedAccount(summaries, UNTAGGED), UNTAGGED, 'untagged bucket is selectable');
  assert.equal(sandbox.resolveSelectedAccount(summaries, 'GONE'), 'KEY_B', 'stale choice falls back to MRU');
  assert.equal(sandbox.resolveSelectedAccount(summaries, null), 'KEY_B', 'no choice → MRU');
  assert.equal(sandbox.resolveSelectedAccount([], 'KEY_A'), null, 'no data at all → null (All accounts)');
});

test('buildAccountOptions: renders name + meta + selection, MRU order preserved', () => {
  const sandbox = loadUtils();
  const UNTAGGED = evalIn(sandbox, 'CONSTANTS.ACCOUNTS.UNTAGGED');
  const summaries = [
    { accountKey: 'KEY_B', orderCount: 3, newestOrderDate: '2026-05-01T00:00:00.000Z' },
    { accountKey: 'KEY_A', orderCount: 12, newestOrderDate: '2026-03-01T00:00:00.000Z' },
    { accountKey: null, orderCount: 2, newestOrderDate: '2025-01-01T00:00:00.000Z' },
  ];
  const options = toPlain(
    sandbox.buildAccountOptions(summaries, {
      labels: { KEY_B: 'Work' },
      ordinals: { KEY_A: 1, KEY_B: 2 },
      selected: 'KEY_A',
    })
  );

  assert.deepEqual(options.map((o) => o.value), ['KEY_B', 'KEY_A', UNTAGGED]);
  assert.deepEqual(options.map((o) => o.name), ['Work', 'Account 1', 'Earlier orders']);
  assert.deepEqual(options.map((o) => o.selected), [false, true, false]);
  assert.equal(options[1].orderCount, 12);
});
