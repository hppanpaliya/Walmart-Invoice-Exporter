/**
 * Loads the extension's plain <script>-style sources (utils.js, content.js)
 * into a Node `vm` context with just enough browser/chrome stubs to exercise
 * the extraction and export logic.
 *
 * Function declarations become properties of the returned sandbox object;
 * top-level const/let (e.g. CONSTANTS, PurchaseHistoryDataSource) live in the
 * context's global lexical scope — read them with `evalIn(sandbox, expr)`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.join(__dirname, '..', '..');

function makeFakeElement() {
  const element = {
    textContent: '',
    innerText: '',
    style: {},
    dataset: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    getAttribute: () => null,
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child) { this.children.push(child); return child; },
    removeChild() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    click() {},
  };
  return element;
}

/**
 * Create a sandbox and load the given scripts into it.
 * @param {Object} options
 * @param {Object|null} options.nextData - Parsed JSON served as script#__NEXT_DATA__
 * @param {string[]} options.scripts - Files (repo-relative) to load, in order
 * @param {string} options.url - window.location.href to simulate
 * @returns {Object} the vm sandbox (function declarations are properties)
 */
function loadSandbox({
  nextData = null,
  scripts = ['utils.js', 'content.js'],
  url = 'https://www.walmart.com/orders',
} = {}) {
  const documentElement = makeFakeElement();
  const head = makeFakeElement();
  const body = makeFakeElement();
  body.firstChild = null;

  const document = {
    readyState: 'complete',
    documentElement,
    head,
    body,
    createElement: () => makeFakeElement(),
    createTextNode: (text) => ({ nodeValue: text }),
    addEventListener() {},
    removeEventListener() {},
    getElementById: () => null,
    getElementsByClassName: () => [],
    querySelectorAll: () => [],
    querySelector(selector) {
      if (selector === 'script#__NEXT_DATA__' && nextData) {
        return { textContent: JSON.stringify(nextData) };
      }
      return null;
    },
  };

  const parsedUrl = new URL(url);
  const window = {
    location: {
      href: url,
      origin: parsedUrl.origin,
      pathname: parsedUrl.pathname,
    },
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    URL,
    Image: function Image() {},
  };
  window.document = document;
  window.window = window;

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage() {},
    },
    storage: {
      local: {
        get: (_keys, cb) => cb && cb({}),
        set: (_obj, cb) => cb && cb(),
        remove: (_keys, cb) => cb && cb(),
      },
    },
    tabs: {
      query() {},
      onUpdated: { addListener() {}, removeListener() {} },
      onActivated: { addListener() {} },
    },
  };

  const sandbox = {
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextEncoder,
    TextDecoder,
    Blob: function Blob(parts, opts) { this.parts = parts; this.opts = opts; },
    fetch: () => Promise.reject(new Error('network disabled in tests')),
    MutationObserver: function MutationObserver() {
      this.observe = () => {};
      this.disconnect = () => {};
    },
    HTMLImageElement: function HTMLImageElement() {},
    navigator: {},
    document,
    window,
    chrome,
    ExcelJS: {},
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  for (const script of scripts) {
    const source = fs.readFileSync(path.join(REPO_ROOT, script), 'utf8');
    vm.runInContext(source, sandbox, { filename: script });
  }
  return sandbox;
}

/** Evaluate an expression inside a loaded sandbox (reaches const/let globals). */
function evalIn(sandbox, expression) {
  return vm.runInContext(expression, sandbox);
}

/**
 * Strip vm-realm prototypes so deepStrictEqual works across realms.
 * (Objects created inside the sandbox have a different Object/Array
 * prototype identity than the host realm.)
 */
function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { loadSandbox, evalIn, toPlain, REPO_ROOT };
