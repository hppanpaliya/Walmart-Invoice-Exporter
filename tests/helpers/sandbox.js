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
 * A stateful, chrome.storage.{local,session}-shaped fake backed by a plain
 * object, supporting the get/set/remove call shapes actually used in the
 * codebase (get(undefined|string|string[]), set(object), remove(string|
 * string[])). Callback-style only (matches MV3's non-promise callback form,
 * which is what every call site here uses).
 */
function createFakeStorageArea() {
  let data = {};

  function normalizeKeys(keys) {
    if (keys === undefined || keys === null) return Object.keys(data);
    return Array.isArray(keys) ? keys : [keys];
  }

  return {
    get(keys, callback) {
      const result = {};
      normalizeKeys(keys).forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(data, key)) result[key] = data[key];
      });
      if (callback) queueMicrotask(() => callback(result));
    },
    set(items, callback) {
      data = { ...data, ...items };
      if (callback) queueMicrotask(() => callback());
    },
    remove(keys, callback) {
      normalizeKeys(keys).forEach((key) => delete data[key]);
      if (callback) queueMicrotask(() => callback());
    },
    /** Test-only inspection hook — not part of the chrome.storage API. */
    _dump() { return { ...data }; },
  };
}

/**
 * A tiny fake `indexedDB` sufficient for orderdb.js's usage: open (with
 * onupgradeneeded/onsuccess), a single object store, get/getAll/getAllKeys/
 * put/clear, and transaction oncomplete. Databases persist for the lifetime
 * of the sandbox (module-level Map), matching real IndexedDB surviving a
 * connection close() — a fresh `loadSandbox()` call always starts empty.
 *
 * Individual requests resolve on a microtask (fast); transaction completion
 * is a "dirty flag, wait one more macrotask tick" loop so it only ever
 * fires *after* the calling code (orderdb.js's withStore) has had a chance
 * to assign tx.oncomplete — assigning it happens after `await`ing the last
 * request, which is a microtask-scale delay, so waiting for a clean
 * macrotask tick is the only way to avoid a firing race either way.
 */
function createFakeIndexedDB() {
  const databases = new Map();

  class FakeRequest {
    constructor() {
      this.result = undefined;
      this.error = null;
      this.onsuccess = null;
      this.onerror = null;
      this.onupgradeneeded = null;
    }
    _succeed(result) {
      this.result = result;
      queueMicrotask(() => { if (this.onsuccess) this.onsuccess({ target: this }); });
    }
  }

  class FakeObjectStore {
    constructor(records, keyPath, notifyActivity) {
      this._records = records;
      this.keyPath = keyPath;
      this._notify = notifyActivity;
    }
    createIndex() { /* no-op — tests here never query by index */ }
    // Real IndexedDB matches compound keys ([provider, orderNumber]) by
    // structured-clone equality; a JS Map keys by identity, so array keys
    // never match. Normalize keys (scalar or array) to a stable string so
    // put/get agree — this mirrors real IndexedDB behavior, it does not
    // change anything a test asserts.
    _normalizeKey(key) {
      const keyPath = this.keyPath;
      const source = (key && typeof key === 'object' && !Array.isArray(key)) ? undefined : key;
      const parts = Array.isArray(keyPath)
        ? (Array.isArray(source) ? source : keyPath.map((p) => (key && typeof key === 'object' ? key[p] : key)))
        : [source];
      return JSON.stringify(parts);
    }
    _keyForValue(value) {
      const keyPath = this.keyPath;
      const parts = Array.isArray(keyPath) ? keyPath.map((p) => value[p]) : [value[keyPath]];
      return JSON.stringify(parts);
    }
    get(key) {
      this._notify();
      const req = new FakeRequest();
      queueMicrotask(() => req._succeed(this._records.get(this._normalizeKey(key))));
      return req;
    }
    getAll() {
      this._notify();
      const req = new FakeRequest();
      queueMicrotask(() => req._succeed(Array.from(this._records.values())));
      return req;
    }
    getAllKeys() {
      this._notify();
      const req = new FakeRequest();
      queueMicrotask(() => req._succeed(Array.from(this._records.keys())));
      return req;
    }
    put(value) {
      this._notify();
      const key = this._keyForValue(value);
      this._records.set(key, value);
      const req = new FakeRequest();
      queueMicrotask(() => req._succeed(key));
      return req;
    }
    clear() {
      this._notify();
      this._records.clear();
      const req = new FakeRequest();
      queueMicrotask(() => req._succeed(undefined));
      return req;
    }
  }

  class FakeTransaction {
    constructor() {
      this._store = null;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      this._dirty = true;
      this._tick();
    }
    _tick() {
      setTimeout(() => {
        if (this._dirty) {
          this._dirty = false;
          this._tick();
        } else if (this.oncomplete) {
          this.oncomplete();
        }
      }, 0);
    }
    objectStore() {
      return this._store;
    }
  }

  class FakeDB {
    constructor(name) {
      this.name = name;
      this._stores = new Map(); // storeName -> { records: Map, keyPath }
      this.objectStoreNames = { contains: (n) => this._stores.has(n) };
    }
    createObjectStore(name, { keyPath }) {
      const records = new Map();
      this._stores.set(name, { records, keyPath });
      return new FakeObjectStore(records, keyPath, () => {});
    }
    transaction(storeName) {
      const info = this._stores.get(storeName);
      const tx = new FakeTransaction();
      tx._store = new FakeObjectStore(info.records, info.keyPath, () => { tx._dirty = true; });
      return tx;
    }
    close() { /* no-op — data persists like real IndexedDB does past close() */ }
  }

  return {
    open(name, _version) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        let db = databases.get(name);
        const isNew = !db;
        if (!db) {
          db = new FakeDB(name);
          databases.set(name, db);
        }
        req.result = db;
        if (isNew && req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
  };
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
  scripts = [
    'utils.js',
    'providers/base.js',
    'providers/registry.js',
    'providers/walmart-us.js',
    'flags.js',
    'content.js',
  ],
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

  /** Records every call so tests can assert e.g. "no tab was ever created". */
  function createTabsStub() {
    const calls = { create: [], get: [], update: [], remove: [], sendMessage: [], query: [] };
    let nextTabId = 1;
    const tabsById = new Map();

    return {
      _calls: calls,
      _tabsById: tabsById,
      query(queryInfo, callback) {
        calls.query.push(queryInfo);
        if (callback) queueMicrotask(() => callback([]));
      },
      create(createProperties, callback) {
        calls.create.push(createProperties);
        const tab = { id: nextTabId++, url: createProperties.url, status: 'complete' };
        tabsById.set(tab.id, tab);
        if (callback) queueMicrotask(() => callback(tab));
      },
      update(tabId, updateProperties, callback) {
        calls.update.push({ tabId, updateProperties });
        const tab = tabsById.get(tabId) || { id: tabId };
        Object.assign(tab, updateProperties, { status: 'complete' });
        tabsById.set(tabId, tab);
        if (callback) queueMicrotask(() => callback(tab));
      },
      get(tabId, callback) {
        calls.get.push(tabId);
        const tab = tabsById.get(tabId);
        if (callback) queueMicrotask(() => callback(tab));
      },
      remove(tabId, callback) {
        calls.remove.push(tabId);
        tabsById.delete(tabId);
        if (callback) {
          queueMicrotask(() => callback());
          return undefined;
        }
        return Promise.resolve();
      },
      sendMessage(tabId, message, callback) {
        calls.sendMessage.push({ tabId, message });
        // No content script is present in unit tests — every call fails
        // fast (via chrome.runtime.lastError) instead of hanging/timing out.
        chrome.runtime.lastError = { message: 'Could not establish connection.' };
        if (callback) {
          queueMicrotask(() => {
            callback(undefined);
            chrome.runtime.lastError = null;
          });
        }
      },
      onUpdated: { addListener() {}, removeListener() {} },
      onActivated: { addListener() {} },
    };
  }

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {}, removeListener() {} },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
      sendMessage() {},
      getManifest: () => ({ version: '0.0.0-test' }),
    },
    storage: {
      local: createFakeStorageArea(),
      session: createFakeStorageArea(),
    },
    tabs: createTabsStub(),
    action: { onClicked: { addListener() {} } },
    sidePanel: { open() {} },
  };

  const sandbox = {
    console,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
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
    location: window.location,
    chrome,
    ExcelJS: {},
    indexedDB: createFakeIndexedDB(),
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  // Tells provider adapters (providers/walmart-us.js) they are running under
  // the unit-test harness, so they re-expose their internal parsing helpers
  // (scrapeOrderData, mergeOrderItems, …) as sandbox globals. Never set in
  // the real extension runtimes, where those helpers stay IIFE-private.
  sandbox.__WIE_TEST_SANDBOX__ = true;
  // Service-worker-only global (background.js's first line). Loads each
  // named repo-relative file into this SAME context, synchronously, just
  // like the real one — lets tests load background.js by itself and have
  // its own `importScripts('utils.js', 'orderdb.js')` pull in the rest.
  sandbox.importScripts = (...files) => {
    files.forEach((file) => {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      vm.runInContext(source, sandbox, { filename: file });
    });
  };

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
