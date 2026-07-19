'use strict';

/**
 * buildOrdersFilterUrl (utils.js): applies Walmart's own order-history filter
 * query grammar (filterIds / startDate+endDate epoch seconds + date-range) to
 * an orders-list URL. Pure function — the Options UI and collection start
 * both rely on exactly this behavior.
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadSandbox } from './helpers/sandbox';

const BASE = 'https://www.walmart.com/orders';

function loadUtils() {
  return loadSandbox({ scripts: ['utils.js'] });
}

test('no filters → base URL unchanged', () => {
  const sandbox = loadUtils();
  assert.equal(sandbox.buildOrdersFilterUrl(BASE), `${BASE}/`.replace(/\/$/, '') || BASE);
  assert.equal(new URL(sandbox.buildOrdersFilterUrl(BASE)).search, '');
  assert.equal(sandbox.buildOrdersFilterUrl(BASE, { typeFilter: 'all' }).includes('filterIds'), false);
});

test('type filter maps to a single filterIds param (Walmart grammar)', () => {
  const sandbox = loadUtils();
  for (const type of ['online', 'in-store', 'in-progress', 'completed', 'returned']) {
    const url = new URL(sandbox.buildOrdersFilterUrl(BASE, { typeFilter: type }));
    assert.deepEqual(url.searchParams.getAll('filterIds'), [type]);
  }
});

test('date range → epoch-second startDate/endDate (inclusive local days) + filterIds=date-range', () => {
  const sandbox = loadUtils();
  const url = new URL(
    sandbox.buildOrdersFilterUrl(BASE, { fromDate: '2026-07-08', toDate: '2026-07-09' })
  );
  assert.deepEqual(url.searchParams.getAll('filterIds'), ['date-range']);
  const start = Number(url.searchParams.get('startDate'));
  const end = Number(url.searchParams.get('endDate'));
  assert.equal(start, Math.floor(new Date('2026-07-08T00:00:00').getTime() / 1000));
  assert.equal(end, Math.floor(new Date('2026-07-09T23:59:59').getTime() / 1000));
  assert.ok(end > start);
});

test('date range + type combine as repeated filterIds (date-range first, like the site)', () => {
  const sandbox = loadUtils();
  const url = new URL(
    sandbox.buildOrdersFilterUrl(BASE, { typeFilter: 'returned', fromDate: '2026-07-08', toDate: '2026-07-09' })
  );
  assert.deepEqual(url.searchParams.getAll('filterIds'), ['date-range', 'returned']);
  assert.ok(url.searchParams.get('startDate'));
  assert.ok(url.searchParams.get('endDate'));
});

test('pre-existing filter params on the base URL are replaced, never stacked', () => {
  const sandbox = loadUtils();
  const dirty = `${BASE}?filterIds=online&startDate=1&endDate=2`;
  const url = new URL(sandbox.buildOrdersFilterUrl(dirty, { typeFilter: 'completed' }));
  assert.deepEqual(url.searchParams.getAll('filterIds'), ['completed']);
  assert.equal(url.searchParams.get('startDate'), null);
  assert.equal(url.searchParams.get('endDate'), null);
});

test('half-filled or inverted date ranges are ignored; garbage base URL passes through', () => {
  const sandbox = loadUtils();
  const onlyFrom = new URL(sandbox.buildOrdersFilterUrl(BASE, { fromDate: '2026-07-08' }));
  assert.equal(onlyFrom.searchParams.get('startDate'), null, 'from without to → no range');
  const inverted = new URL(
    sandbox.buildOrdersFilterUrl(BASE, { fromDate: '2026-07-09', toDate: '2026-07-08' })
  );
  assert.equal(inverted.searchParams.get('startDate'), null, 'inverted range → ignored');
  assert.equal(sandbox.buildOrdersFilterUrl('not a url', { typeFilter: 'online' }), 'not a url');
});
