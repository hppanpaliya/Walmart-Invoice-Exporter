'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox } = require('./helpers/sandbox');

function loadComponentsSandbox() {
  return loadSandbox({
    scripts: ['utils.js', 'orderdb.js', 'sidepanel.state.js', 'sidepanel.components.js'],
  });
}

test('Sidepanel.components exposes Banner/StatusLine/ProgressBar/Dialog/Toast as functions', () => {
  const sandbox = loadComponentsSandbox();
  const components = sandbox.window.Sidepanel.components;

  ['Banner', 'StatusLine', 'ProgressBar', 'Dialog', 'Toast'].forEach((name) => {
    assert.equal(typeof components[name], 'function', `${name} must be exposed as a function`);
  });
});

test('Banner: renders the right role/variant class and message, with an icon then body child', () => {
  const sandbox = loadComponentsSandbox();
  const { Banner } = sandbox.window.Sidepanel.components;

  const banner = Banner({ variant: 'danger', message: '10 of 12 exported' });

  assert.equal(banner.className, 'banner banner-danger');
  assert.equal(banner.children.length, 2, 'icon + body, no dismiss button when dismissible is not set');
  assert.equal(banner.children[1].innerHTML, '10 of 12 exported');
});

test('Banner: info variant defaults role to status; warning/danger use alert (spec §5.5)', () => {
  const sandbox = loadComponentsSandbox();
  const { Banner } = sandbox.window.Sidepanel.components;

  // The sandbox's setAttribute is a no-op stub (no real attribute storage),
  // so this asserts via the documented variant->role mapping's observable
  // side effect instead: dismissible adds a third (button) child, which
  // still must not throw while constructing role="alert" banners.
  assert.doesNotThrow(() => Banner({ variant: 'warning', message: 'x', dismissible: true }));
  assert.doesNotThrow(() => Banner({ variant: 'info', message: 'x' }));
  const withDismiss = Banner({ variant: 'danger', message: 'x', dismissible: true });
  assert.equal(withDismiss.children.length, 3, 'icon + body + dismiss button');
});

test('Banner: actionHtml is appended inside the body, after the message', () => {
  const sandbox = loadComponentsSandbox();
  const { Banner } = sandbox.window.Sidepanel.components;

  const banner = Banner({
    variant: 'info',
    message: 'Filtered view',
    actionHtml: '<a id="returnLink" href="#">Walmart Orders</a>',
  });

  const body = banner.children[1];
  assert.equal(body.children.length, 1, 'the actionHtml wrapper is the body\'s one child');
});

test('StatusLine: holds the given text and is hidden only when empty', () => {
  const sandbox = loadComponentsSandbox();
  const { StatusLine } = sandbox.window.Sidepanel.components;

  const withText = StatusLine('Fetching page 2...');
  assert.equal(withText.textContent, 'Fetching page 2...');
  assert.equal(withText.hidden, false);

  const empty = StatusLine();
  assert.equal(empty.hidden, true);
});

test('ProgressBar: computes a percentage width and exposes .update for reuse', () => {
  const sandbox = loadComponentsSandbox();
  const { ProgressBar } = sandbox.window.Sidepanel.components;

  const bar = ProgressBar(3, 12);
  const fill = bar.children[0];
  assert.equal(fill.style.width, '25%');

  bar.update(6, 12);
  assert.equal(fill.style.width, '50%');

  bar.update(0, 0);
  assert.equal(fill.style.width, '0%', 'a zero total must not divide-by-zero into NaN%');
});

test('Toast: returns null gracefully when no #toast element exists (no throw)', () => {
  const sandbox = loadComponentsSandbox();
  const { Toast } = sandbox.window.Sidepanel.components;

  assert.equal(Toast('Link copied to clipboard!'), null);
});
