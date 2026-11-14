/**
 * providers/walmart-us.js — Walmart.com (WALMART_US) provider adapter.
 *
 * The ONLY provider registered today. It owns every Walmart.com-specific
 * detail that used to live in content.js / utils.js: the CSS selectors, the
 * orders-list URL predicate, the __NEXT_DATA__ parser, the in-page fetch/XHR
 * bridge, and the DOM fallback. The shared engine (background collection loop,
 * OrderDb, export, side panel) drives this adapter through the interface
 * documented in providers/base.js — it never references "walmart.com" directly.
 *
 * Loadable in all three extension contexts and safe at load time everywhere:
 *  - service worker (background.js importScripts) — for id/flag/isOrdersListUrl,
 *  - content script (manifest content_scripts) — for the extraction engine,
 *  - side panel (script tag) — if ever needed for config lookups.
 * Nothing below touches the DOM at load; the content engine only runs when a
 * content-script method (initContent / collectOrderNumbers / scrapeOrder /
 * clickNextPage) is invoked, which only ever happens inside a page.
 *
 * The extraction engine (from "// Function to wait for an element…" down to
 * checkForNextPage) was moved here VERBATIM from the pre-refactor content.js —
 * the only change is CONSTANTS.SELECTORS → the adapter-local SELECTORS below,
 * so Walmart.com behavior is byte-for-byte identical.
 */
const WalmartUsProvider = (() => {
  "use strict";

  const SELECTORS = {
    PRINT_ITEMS: '.dn.print-items-list',
    PRINT_ITEM_NAME: '.flex.justify-between > .w_U9_0.w_sD6D.w_QcqU, .flex.justify-between > div:first-child',
    PRINT_BILL_TYPE: '.print-bill-type .w_U9_0.w_sD6D.w_QcqU, .print-bill-type > div',
    PRINT_BILL_QTY: '.print-bill-qty .w_U9_0.w_sD6D.w_QcqU, .print-bill-qty > div',
    PRINT_BILL_PRICE: '.print-bill-price .w_U9_0.w_sD6D.w_QcqU, .print-bill-price > div',
    VISIBLE_ITEMS: '[data-testid="itemtile-stack"] [data-testid="productName"] span',
    ITEM_STACK: '[data-testid="itemtile-stack"]',
    PRODUCT_LINK: 'a[link-identifier="itemClick"]',

    PRINT_BILL_GROUP: '.print-bill-group',
    PRINT_ITEM_ROW: '.dn.print-items-list > .flex.justify-between',
    PAYMENT_METHODS: '[aria-labelledby^="card-description-"]',
    ADDRESS: '.print-bill-payment-section .w_U9_0.w_sD6D.w_QcqU span, .print-bill-payment-section .w_yTSq.w_0aYG.w_MwbK, .print-bill-payment-section .flex.flex-column.mid-gray [data-sensitivity="medium"], .print-bill-payment-section .flex.flex-column.mid-gray span',
    ORDER_NUMBER_BAR: '.f-subheadline-m.dark-gray-m.print-bill-bar-id',
    ORDER_INFO_CARD: "[data-testid='orderInfoCard'] .dark-gray",
    ORDER_NUMBER_HEADING: '.print-bill-heading .dark-gray',
    PRINT_BILL_ID: '.print-bill-bar-id',
    ORDER_DATE: '.print-bill-date',
    ORDER_SUBTOTAL: '.flex.justify-between.pb3.bill-order-payment-subtotal, span[aria-label^="Subtotal after savings"]',
    ORDER_TOTAL: '.bill-order-total-payment',
    DELIVERY_CHARGES: '.print-fees-item',
    TAX_ELEMENTS: '.print-fees-item',
    TIP: '.flex.justify-between.pb2.pt3',
    FEE_LABEL: '.ld_FS',
    ORDER_CARDS: '[data-testid^="order-"], div.ld_V.mv4',
    NEXT_BUTTON: 'button[data-automation-id="next-pages-button"]:not([disabled])',
    MAIN_HEADING: 'h1, .ld_FM.ld_FQ.ld_FO',
  };

  /** The orders LIST page (an order-detail URL like /orders/123 is NOT it). */
  function isOrdersListUrl(url) {
    return /^https:\/\/www\.walmart\.com\/orders\/?($|\?)/.test(String(url || ""));
  }

  // ==========================================================================
  // Content-context extraction engine — runs ONLY inside a Walmart.com page.
  // Moved verbatim from content.js (CONSTANTS.SELECTORS → local SELECTORS).
  // ==========================================================================

// Function to wait for an element to appear
// Timeout reduced to 10s with 200ms polling for faster response
async function waitForElement(
  selector,
  timeout = CONSTANTS.TIMING.COLLECTION_TIMEOUT,
  pollInterval = CONSTANTS.TIMING.ELEMENT_POLL_INTERVAL
) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const element = document.querySelector(selector);
    if (element) {
      return element;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Element ${selector} not found after ${timeout}ms`);
}

async function waitForAnyElement(
  selectors,
  timeout = CONSTANTS.TIMING.COLLECTION_TIMEOUT,
  pollInterval = CONSTANTS.TIMING.ELEMENT_POLL_INTERVAL
) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`None of the selectors matched after ${timeout}ms: ${selectors.join(", ")}`);
}

const PurchaseHistoryDataSource = (() => {
  const MESSAGE_SOURCE = "WIE_PURCHASE_HISTORY_BRIDGE";
  const MESSAGE_TYPE = "PURCHASE_HISTORY_SNAPSHOT";
  const NEXT_DATA_SELECTOR = 'script#__NEXT_DATA__';
  const SNAPSHOT_MAX_AGE_MS = 30000;

  let latestSnapshot = null;
  let consumedSnapshotTimestamp = 0;
  let messageListenerAttached = false;

  // ----- Fast Collect (optional; feature-flagged, off by default) -----
  // The PurchaseHistoryV3 persisted-query hash, learned from the page's own
  // request (relayed by the in-page bridge). It is the ONE value Fast Collect
  // cannot synthesize; everything else in the request is static/derivable.
  const PH_ENDPOINT_PREFIX = "/orchestra/cph/graphql/PurchaseHistoryV3/";
  const SIGNATURE_CACHE_KEY = "wm_ph_signature";
  const FAST_FETCH_PAGE_LIMIT = 10; // orders per request
  // Pace requests like a real person clicking "Next": a randomized gap in this
  // range between pages. When you browse manually you wait a second or two
  // between clicks, so Walmart never throttles you — matching that cadence
  // (instead of firing several requests a second) is what keeps the API from
  // rate-limiting the crawl. Slower than a machine could go, but it never trips
  // the bot limiter, which is the whole point.
  const FAST_FETCH_MIN_DELAY_MS = 1500;
  const FAST_FETCH_MAX_DELAY_MS = 3500;
  const FAST_FETCH_MAX_PAGES = 500; // runaway guard

  /** A human-like pause between page requests (randomized, not a fixed beat). */
  function humanPacingDelay() {
    const span = FAST_FETCH_MAX_DELAY_MS - FAST_FETCH_MIN_DELAY_MS;
    return FAST_FETCH_MIN_DELAY_MS + Math.floor(Math.random() * (span + 1));
  }
  // A known-good persisted-query hash, so the request path works with ZERO
  // extra clicks on the common case. If Walmart rotates it on a deploy, the
  // first request fails and we re-learn the live hash from the page's own
  // traffic (and cache it) — self-healing, no hardcoded value ever gets stuck.
  const DEFAULT_HASH = "e229f4ac329ebafc737315bb65e303d5ea43d21a415750dcc72b572cd2f19094";
  let capturedHash = null;
  // The page's own request `variables` (parsed from its captured URL). Replays
  // clone this and swap ONLY the cursor, so a filtered view's filterIds /
  // date range carry into every replayed page instead of being dropped.
  let capturedVariables = null;

  // Cursor needed to fetch each page: page 1 needs none; page N's cursor is the
  // previous page's nextPageCursor. Lets the request path re-fetch (and date)
  // ANY page directly when the browser's own capture is missed — so classic
  // collection stays request-driven (DOM is a last resort), never "NO DATE".
  const cursorForPage = { 1: null };

  const normalizeOrderNumber = (value) => String(value || "").replace(/[^\d]/g, "");

  /** Pull the 64-hex persisted-query hash out of a PurchaseHistoryV3 URL. */
  function extractHashFromUrl(url) {
    const match = String(url || "").match(/PurchaseHistoryV3\/([a-f0-9]{64})/);
    return match ? match[1] : null;
  }

  function extractPurchaseHistoryNode(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    return (
      payload.purchaseHistory ||
      payload.data?.purchaseHistory ||
      payload.props?.pageProps?.phRedesignInitialData?.data?.purchaseHistory ||
      payload.pageProps?.phRedesignInitialData?.data?.purchaseHistory ||
      payload.props?.pageProps?.initialData?.data?.purchaseHistory ||
      payload.pageProps?.initialData?.data?.purchaseHistory ||
      null
    );
  }

  /**
   * Build a lightweight order summary from a purchase-history order node.
   * Every field falls back to an empty string when missing so downstream
   * consumers can render partial data without extra guards.
   * @param {Object} order - Raw order node from the purchase-history payload
   * @param {string} normalizedOrderNumber - Digits-only order number
   * @returns {Object} Summary object for Quick Export
   */
  function buildOrderSummary(order, normalizedOrderNumber) {
    const groups = Array.isArray(order?.groups) ? order.groups : [];
    const statusTexts = [];
    const fulfillmentTypes = [];
    const items = [];

    groups.forEach((group) => {
      const statusParts = Array.isArray(group?.status?.message?.parts)
        ? group.status.message.parts
        : [];
      const statusText = cleanText(statusParts.map((part) => part?.text || "").join(" "));
      if (statusText && !statusTexts.includes(statusText)) {
        statusTexts.push(statusText);
      }

      const fulfillmentType = cleanText(group?.fulfillmentType || "");
      if (fulfillmentType && !fulfillmentTypes.includes(fulfillmentType)) {
        fulfillmentTypes.push(fulfillmentType);
      }

      const groupItems = Array.isArray(group?.items) ? group.items : [];
      groupItems.forEach((item) => {
        items.push({
          name: cleanText(item?.name || ""),
          quantity: item?.quantity ?? "",
          statusCode: item?.statusCode || "",
          thumbnailUrl: item?.imageInfo?.thumbnailUrl || "",
        });
      });
    });

    return {
      source: "payload",
      orderNumber: normalizedOrderNumber,
      // Years-old orders omit orderDate from the payload; their title
      // ("Jun 15, 2022 order") still carries the full date Walmart shows.
      orderDate: order?.orderDate || parseWalmartTitleDate(order?.title || order?.shortTitle || "") || "",
      // Full ISO timestamp per delivery group (live-verified 2026-07) —
      // the "Delivered on …" date Walmart shows. Kept as a fallback date
      // source for orders whose orderDate/title yield nothing.
      deliveredDate: groups.map((group) => group?.deliveredDate || group?.deliveryDate || "").find(Boolean) || "",
      orderType: cleanText(order?.type || ""),
      isInStore: Boolean(order?.isInStore),
      itemCount: order?.itemCount ?? "",
      // The purchase-history payload's priceDetails carries the whole money
      // breakdown per order (same shape as the order-detail page), so capture
      // savings/tax/tips/subtotal here too — the dashboard falls back to these
      // when a fast (SSR-fetch) invoice didn't include its own price block.
      orderTotal: order?.priceDetails?.orderTotal?.displayValue || "",
      subTotal: order?.priceDetails?.subTotal?.displayValue || "",
      driverTip: order?.priceDetails?.driverTip?.displayValue || "",
      savings: order?.priceDetails?.savings?.displayValue || "",
      tax: order?.priceDetails?.taxTotal?.displayValue || "",
      refund: order?.priceDetails?.refund?.displayValue || "",
      donations: order?.priceDetails?.donations?.displayValue || "",
      status: statusTexts.join("; "),
      fulfillmentTypes: fulfillmentTypes.join(", "),
      items,
    };
  }

  function buildSnapshot(purchaseHistory, source = "unknown") {
    const orders = Array.isArray(purchaseHistory?.orders) ? purchaseHistory.orders : [];
    if (orders.length === 0) {
      return null;
    }

    const orderNumbers = [];
    const additionalFields = {};
    const orderSummaries = {};
    const seen = new Set();

    orders.forEach((order) => {
      const rawOrderNumber =
        order?.id ||
        order?.orderId ||
        order?.displayId ||
        order?.groups?.[0]?.orderId ||
        "";

      const normalizedOrderNumber = normalizeOrderNumber(rawOrderNumber);
      if (!normalizedOrderNumber || seen.has(normalizedOrderNumber)) {
        return;
      }

      seen.add(normalizedOrderNumber);
      orderNumbers.push(normalizedOrderNumber);

      const title = cleanText(
        order?.title ||
        order?.shortTitle ||
        order?.displayId ||
        order?.groups?.[0]?.status?.message?.parts?.[0]?.text ||
        ""
      );
      additionalFields[normalizedOrderNumber] = title;
      orderSummaries[normalizedOrderNumber] = buildOrderSummary(order, normalizedOrderNumber);
    });

    if (orderNumbers.length === 0) {
      return null;
    }

    const nextPageCursor = purchaseHistory?.pageInfo?.nextPageCursor || null;
    const signature = `${orderNumbers.slice(0, 3).join("|")}|${nextPageCursor || ""}`;

    return {
      orderNumbers,
      additionalFields,
      orderSummaries,
      hasNextPage: Boolean(nextPageCursor),
      nextPageCursor,
      source,
      signature,
      timestamp: Date.now(),
    };
  }

  function parseSnapshotFromNextData() {
    try {
      const script = document.querySelector(NEXT_DATA_SELECTOR);
      const text = script?.textContent;
      if (!text) {
        return null;
      }

      const parsed = JSON.parse(text);
      const purchaseHistory = extractPurchaseHistoryNode(parsed);
      return buildSnapshot(purchaseHistory, "next-data");
    } catch (error) {
      console.warn("Failed to parse __NEXT_DATA__ purchase history payload", error);
      return null;
    }
  }

  function updateLatestSnapshot(snapshot) {
    if (!snapshot) {
      return;
    }

    if (
      latestSnapshot &&
      latestSnapshot.signature === snapshot.signature &&
      snapshot.timestamp <= latestSnapshot.timestamp
    ) {
      return;
    }

    latestSnapshot = snapshot;
  }

  function getLatestSnapshotTimestamp() {
    return latestSnapshot?.timestamp || 0;
  }

  function getFreshUnconsumedNetworkSnapshot() {
    if (!latestSnapshot || latestSnapshot.source !== "network") {
      return null;
    }

    if (Date.now() - latestSnapshot.timestamp > SNAPSHOT_MAX_AGE_MS) {
      return null;
    }

    if (latestSnapshot.timestamp <= consumedSnapshotTimestamp) {
      return null;
    }

    consumedSnapshotTimestamp = latestSnapshot.timestamp;
    return latestSnapshot;
  }

  function handleBridgeMessage(event) {
    if (event.source !== window) {
      return;
    }

    const message = event.data;
    if (
      !message ||
      message.source !== MESSAGE_SOURCE ||
      message.type !== MESSAGE_TYPE ||
      !message.payload
    ) {
      return;
    }

    // Learn the persisted-query hash from the page's own request URL, so Fast
    // Collect can replay it. Cache it for future sessions (self-heals across
    // Walmart front-end deploys the next time the page paginates for real).
    // Remember the page's own request variables for faithful replays.
    try {
      const capturedUrl = new URL(message.requestUrl, window.location.origin);
      const rawVariables = capturedUrl.searchParams.get("variables");
      if (rawVariables) capturedVariables = JSON.parse(rawVariables);
    } catch (_) {
      // Unparseable/absent — the synthesized default still works unfiltered.
    }

    const hashFromUrl = extractHashFromUrl(message.requestUrl);
    if (hashFromUrl && hashFromUrl !== capturedHash) {
      capturedHash = hashFromUrl;
      try {
        chrome.storage.local.set({ [SIGNATURE_CACHE_KEY]: { hash: hashFromUrl } });
      } catch (error) {
        // Storage unavailable in this context — in-memory capture still works.
      }
    }

    const purchaseHistory = extractPurchaseHistoryNode(message.payload) || message.payload;
    const snapshot = buildSnapshot(purchaseHistory, "network");
    updateLatestSnapshot(snapshot);
  }

  function attachBridgeMessageListener() {
    if (messageListenerAttached) {
      return;
    }
    window.addEventListener("message", handleBridgeMessage);
    messageListenerAttached = true;
  }

  // The old inline <script> bridge injector lived here. It is GONE on
  // purpose: walmart-mainworld.js (a "world": "MAIN" content script) now
  // installs the fetch/XHR capture bridge before any page script runs —
  // and Walmart's CSP blocks inline scripts anyway, so the injector could
  // never execute and only spammed CSP violations in the console.

  function initialize() {
    attachBridgeMessageListener();

    // Prime the snapshot cache from initial HTML payload when available.
    updateLatestSnapshot(parseSnapshotFromNextData());
  }

  function getBestSnapshot({ currentPage = 1 } = {}) {
    if (currentPage <= 1) {
      const nextDataSnapshot = parseSnapshotFromNextData();
      if (nextDataSnapshot) {
        updateLatestSnapshot(nextDataSnapshot);
        return nextDataSnapshot;
      }

      const networkSnapshot = getFreshUnconsumedNetworkSnapshot();
      if (networkSnapshot) {
        return networkSnapshot;
      }

      return null;
    }

    const networkSnapshot = getFreshUnconsumedNetworkSnapshot();
    if (networkSnapshot) {
      return networkSnapshot;
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Fast Collect engine (optional; used only when the `fastFetch` setting is
  // on). Reads page 1 from the server-rendered __NEXT_DATA__ (always fully
  // dated) and then pages the rest by replaying Walmart's OWN PurchaseHistoryV3
  // request directly, in-page, with the user's live session — no tab
  // back-and-forth, no bot-flag (the request is indistinguishable from the
  // site's own). Every page is a full dated payload, which also cures the
  // "no date past page 1" problem the click-through path hits when its passive
  // network capture misses. When it cannot proceed it returns
  // { fallbackToClassic: true } so the caller runs the normal loop — so Fast
  // Collect can only ever speed things up, never regress.
  // -------------------------------------------------------------------------

  /** Read the cached persisted-query hash (survives across sessions). */
  function readCachedHash() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([SIGNATURE_CACHE_KEY], (result) => {
          const sig = result && result[SIGNATURE_CACHE_KEY];
          resolve((sig && sig.hash) || null);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  /** Drop a cached hash that a live request just proved stale (a deploy). */
  function invalidateCachedHash() {
    try {
      chrome.storage.local.remove(SIGNATURE_CACHE_KEY);
    } catch (error) {
      // best-effort
    }
  }

  /** The web app's build version, read from __NEXT_DATA__ (needed by Akamai). */
  function getPlatformVersion() {
    try {
      const text = document.querySelector(NEXT_DATA_SELECTOR)?.textContent || "";
      const match = text.match(/usweb-[0-9.]+-[a-f0-9]+-\d+r/);
      if (match) return match[0];
    } catch (error) {
      // fall through to a generic value
    }
    return "usweb-1.0.0";
  }

  /**
   * The static header set that gets a same-session PurchaseHistoryV3 fetch past
   * Akamai. Live-verified: the GraphQL/Apollo markers are what clear the bot
   * check (their absence is a hard 418); no per-request token, correlation id,
   * or trace header is required.
   */
  function buildFetchHeaders(platformVersion) {
    return {
      accept: "application/json",
      "content-type": "application/json",
      "X-APOLLO-OPERATION-NAME": "PurchaseHistoryV3",
      "x-apollo-operation-name": "PurchaseHistoryV3",
      "x-o-gql-query": "query PurchaseHistoryV3",
      "x-o-platform": "rweb",
      "x-o-platform-version": platformVersion || "usweb-1.0.0",
      "x-o-segment": "oaoh",
      "x-o-ccm": "server",
      WM_MP: "true",
    };
  }

  /** The `variables` payload shape Walmart's own request uses. */
  function buildFetchVariables(cursor, limit) {
    // Prefer the page's OWN captured variables (keeps filterIds/date range and
    // any future fields Walmart adds) — only the cursor changes per page.
    if (capturedVariables && capturedVariables.input) {
      const cloned = JSON.parse(JSON.stringify(capturedVariables));
      cloned.input.cursor = cursor || null;
      return cloned;
    }
    return {
      input: {
        cursor: cursor || null,
        search: "",
        filterIds: [],
        limit: limit || FAST_FETCH_PAGE_LIMIT,
        type: null,
        minTimestamp: null,
        maxTimestamp: null,
        filters: { minTimestamp: null, maxTimestamp: null, filterIds: [] },
        enabledFeatures: [],
        eligibleFeatures: {
          isEbtEligible: false,
          enablePhFiltersEnhancement: true,
          isBnbEligible: false,
          isWcpAccEligible: false,
        },
      },
      platform: "WEB",
      enableIsWcpOrder: false,
      enableWcpPhaseOrder: false,
    };
  }

  // Fast Collect replay protocol — must match walmart-mainworld.js.
  const REPLAY_REQ = "WIE_REPLAY_REQUEST";
  const REPLAY_RES = "WIE_REPLAY_RESULT";
  // Fast invoice protocol — must match walmart-mainworld.js.
  const ORDER_REQ = "WIE_FETCH_ORDER";
  const ORDER_RES = "WIE_FETCH_ORDER_RESULT";
  let replayCounter = 0;

  /**
   * Ask the MAIN-world bridge to fetch one order's detail HTML (same-origin,
   * with the user's session) and return its __NEXT_DATA__ order node — the
   * whole invoice — without navigating a tab to that order. Resolves to the
   * order node, or null.
   */
  function fetchOrderNodeViaMainWorld(orderNumber, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const reqId = `wie-order-${replayCounter++}`;
      const onMessage = (event) => {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || msg.source !== MESSAGE_SOURCE || msg.type !== ORDER_RES || msg.reqId !== reqId) {
          return;
        }
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        resolve(msg && msg.ok ? msg.order || null : null);
      };
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(null);
      }, timeoutMs);
      window.addEventListener("message", onMessage);
      window.postMessage({ source: MESSAGE_SOURCE, type: ORDER_REQ, reqId, orderNumber }, "*");
    });
  }

  /**
   * Ask the MAIN-world bridge (walmart-mainworld.js) to fetch a purchase-history
   * URL using the page's OWN captured request headers. Those real headers are
   * what Walmart's bot check accepts — a request we build from synthesized
   * headers gets 429-challenged. Resolves to the raw JSON payload, or null.
   */
  function replayViaMainWorld(url, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const reqId = `wie-replay-${replayCounter++}`;
      const onMessage = (event) => {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || msg.source !== MESSAGE_SOURCE || msg.type !== REPLAY_RES || msg.reqId !== reqId) {
          return;
        }
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs);
      window.addEventListener("message", onMessage);
      window.postMessage({ source: MESSAGE_SOURCE, type: REPLAY_REQ, reqId, url }, "*");
    });
  }

  /**
   * Fetch one page of purchase history, returning its purchaseHistory node.
   *
   * Real runtime: the request is REPLAYED in the page's own world by
   * walmart-mainworld.js with the page's captured headers (the only way it
   * passes Walmart's bot check). Under the unit-test harness there is no
   * main-world bridge, so we fetch directly (tests stub `fetch`). Throws on a
   * non-2xx or a missing payload; `error.status` carries the HTTP status so the
   * caller can tell a rotated hash (4xx) from a throttle (429/503).
   */
  async function fetchPurchaseHistoryPage(hash, cursor) {
    const variables = buildFetchVariables(cursor, FAST_FETCH_PAGE_LIMIT);
    const url = `${PH_ENDPOINT_PREFIX}${hash}?variables=${encodeURIComponent(JSON.stringify(variables))}`;

    if (typeof globalThis !== "undefined" && globalThis.__WIE_TEST_SANDBOX__) {
      const response = await fetch(url, {
        credentials: "include",
        headers: buildFetchHeaders(getPlatformVersion()),
      });
      if (!response.ok) {
        const err = new Error(`PurchaseHistoryV3 HTTP ${response.status}`);
        err.status = response.status;
        throw err;
      }
      const json = await response.json();
      const purchaseHistory = extractPurchaseHistoryNode(json);
      if (!purchaseHistory) throw new Error("PurchaseHistoryV3 payload missing purchaseHistory");
      return purchaseHistory;
    }

    const res = await replayViaMainWorld(url);
    if (!res || !res.ok || !res.payload) {
      const err = new Error(`PurchaseHistoryV3 replay failed (${(res && (res.reason || res.status)) || "unknown"})`);
      err.status = res && res.status;
      throw err;
    }
    const purchaseHistory = extractPurchaseHistoryNode(res.payload);
    if (!purchaseHistory) {
      const err = new Error("PurchaseHistoryV3 payload missing purchaseHistory");
      err.status = 200;
      throw err;
    }
    return purchaseHistory;
  }

  /**
   * Trigger Walmart's OWN "next page" once so the in-page bridge can learn the
   * current persisted-query hash. Resolves true once a hash is captured.
   */
  async function seedSignatureViaClick() {
    try {
      const before = capturedHash;
      const button = findNextPageButton();
      if (!button) return false;
      button.scrollIntoView({ block: "center", inline: "center" });
      button.click();

      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (capturedHash && capturedHash !== before) return true;
        await delay(200);
      }
      return Boolean(capturedHash);
    } catch (error) {
      return false;
    }
  }

  /**
   * Collect the ENTIRE purchase history in one content-script call by replaying
   * the PurchaseHistoryV3 request page by page.
   * @param {{pageLimit?: number}} [opts]
   * @returns {Promise<Object>} a merged CollectResult ({orderNumbers,
   *   additionalFields, orderSummaries, pages, hasNextPage:false, fast:true}),
   *   or { fallbackToClassic: true } when the hash cannot be resolved.
   */
  async function collectAllViaFetch({ pageLimit = 0, incremental = false, knownOrderNumbers = [] } = {}) {
    const isTest = typeof globalThis !== "undefined" && globalThis.__WIE_TEST_SANDBOX__;
    const seen = new Set();
    const merged = { orderNumbers: [], additionalFields: {}, orderSummaries: {}, pages: 0 };

    // Incremental ("only new orders"): stop paging once a WHOLE page consists
    // of already-stored orders — same rule as the classic crawl. The page
    // itself is still absorbed (refreshes those orders' summaries).
    const knownSet = new Set(knownOrderNumbers || []);
    const pageAllKnown = (snapshot) =>
      Boolean(incremental) &&
      Boolean(snapshot) &&
      snapshot.orderNumbers.length > 0 &&
      snapshot.orderNumbers.every((num) => knownSet.has(num));

    // Tell the panel (via the background) about each page the moment it lands,
    // so the order count, the page number, and the list update live instead of
    // the user staring at a spinner until the whole history is done.
    const reportProgress = (snapshot) => {
      if (isTest || !snapshot) return;
      try {
        chrome.runtime.sendMessage({
          action: CONSTANTS.MESSAGES.FAST_COLLECT_PROGRESS,
          page: merged.pages,
          orderNumbers: snapshot.orderNumbers || [],
          additionalFields: snapshot.additionalFields || {},
          orderSummaries: snapshot.orderSummaries || {},
        });
      } catch (_) {
        // Panel/background not reachable — progress is best-effort; the final
        // COLLECT_ALL_FAST response still carries the complete result.
      }
    };

    const absorb = (snapshot) => {
      if (!snapshot) return null;
      snapshot.orderNumbers.forEach((num) => {
        if (seen.has(num)) return;
        seen.add(num);
        merged.orderNumbers.push(num);
      });
      Object.assign(merged.additionalFields, snapshot.additionalFields);
      Object.assign(merged.orderSummaries, snapshot.orderSummaries);
      merged.pages += 1;
      reportProgress(snapshot);
      return snapshot.nextPageCursor || null; // null => no further page
    };

    const finalize = (incomplete = false) => {
      console.log(
        `[WIE] Fast Collect: ${merged.orderNumbers.length} order(s) across ${merged.pages} page(s) — 1 real request + ${Math.max(0, merged.pages - 2)} replayed.`
      );
      return {
        orderNumbers: merged.orderNumbers,
        additionalFields: merged.additionalFields,
        orderSummaries: merged.orderSummaries,
        pages: merged.pages,
        hasNextPage: incomplete,
        fast: true,
        ...(incomplete ? { fallbackToClassic: true } : {}),
      };
    };

    // Page 1: the server-rendered payload — present on the unfiltered list.
    let firstSnapshot = parseSnapshotFromNextData();

    // Filtered views (?filterIds=…) render page 1 CLIENT-side: __NEXT_DATA__
    // has no purchase history, the page fetches its own PurchaseHistoryV3
    // instead. Wait briefly for the bridge to capture that request — it IS
    // page 1 here (and it carries the real headers replay needs).
    if (!firstSnapshot && !isTest) {
      const deadline = Date.now() + 10000;
      while (!firstSnapshot && Date.now() < deadline) {
        firstSnapshot = getFreshUnconsumedNetworkSnapshot();
        if (!firstSnapshot) await delay(300);
      }
    }

    let cursor = firstSnapshot ? absorb(firstSnapshot) : null;
    if (firstSnapshot && cursor === null) {
      return finalize(); // single page, nothing more to fetch
    }
    if (pageAllKnown(firstSnapshot)) {
      console.log("[WIE] Fast Collect (incremental): page 1 is all known orders — done.");
      return finalize();
    }
    if (pageLimit > 0 && merged.pages >= pageLimit) return finalize();

    // SEED (real runtime): trigger ONE genuine "Next" so the page makes its own
    // PurchaseHistoryV3 request. The main-world bridge captures BOTH page 2's
    // dated payload AND the page's real request headers — and those real
    // headers are the only thing that lets us replay the REST of the pages past
    // Walmart's bot check (a synthesized request gets 429-challenged). This is
    // the one and only click; every remaining page is an instant replay.
    if (!isTest && cursor) {
      const beforeTs = getLatestSnapshotTimestamp();
      const nextButton = findNextPageButton();
      if (nextButton) {
        try {
          nextButton.scrollIntoView({ block: "center", inline: "center" });
          nextButton.click();
        } catch (_) {}
        const deadline = Date.now() + 12000;
        while (getLatestSnapshotTimestamp() <= beforeTs && Date.now() < deadline) {
          await delay(300);
        }
        const page2 = getFreshUnconsumedNetworkSnapshot();
        if (page2) {
          cursor = absorb(page2); // page 2 collected (dated) + advance the cursor
          if (pageAllKnown(page2)) {
            console.log("[WIE] Fast Collect (incremental): page 2 is all known orders — done.");
            return finalize();
          }
        }
      }
    }

    // Replay the remaining pages. In the real runtime fetchPurchaseHistoryPage
    // routes through the main-world bridge (captured real headers → passes);
    // under the test harness it fetches directly (stubbed).
    const hash = capturedHash || (await readCachedHash()) || DEFAULT_HASH;
    let guard = 0;
    let incomplete = false;
    const visitedCursors = new Set();
    while (cursor) {
      if (pageLimit > 0 && merged.pages >= pageLimit) break;
      if (guard++ >= FAST_FETCH_MAX_PAGES || visitedCursors.has(cursor)) {
        incomplete = true;
        break;
      }
      visitedCursors.add(cursor);
      if (!isTest) await delay(humanPacingDelay());
      let purchaseHistory;
      try {
        purchaseHistory = await fetchPurchaseHistoryPage(hash, cursor);
      } catch (error) {
        console.warn(
          `[WIE] Fast Collect stopped after ${merged.pages} page(s):`,
          error && error.message
        );
        incomplete = true;
        break; // keep everything collected so far and request classic rescue
      }
      const snapshot = buildSnapshot(purchaseHistory, "fetch");
      if (!snapshot) {
        incomplete = true;
        break;
      }
      cursor = absorb(snapshot);
      if (pageAllKnown(snapshot)) {
        console.log("[WIE] Fast Collect (incremental): page of all-known orders — stopping.");
        break;
      }
    }

    if (merged.orderNumbers.length === 0) {
      return { fallbackToClassic: true };
    }
    return finalize(incomplete);
  }

  /**
   * Remember the cursor needed to fetch the page AFTER `page` (its
   * nextPageCursor), so classic collection can re-fetch the next page directly
   * if the browser's own request capture is missed.
   */
  function noteCursor(page, nextPageCursor) {
    cursorForPage[Number(page) + 1] = nextPageCursor || null;
  }

  /**
   * Re-fetch one page's purchase-history payload directly (same request the
   * page would make), returning a full dated snapshot — or null if the cursor
   * for this page isn't known yet or the request fails. This is the
   * request-based fallback that keeps classic collection off the DOM: it runs
   * only when the page's OWN pagination request wasn't captured in time.
   * @param {number} page - 1-based page number to fetch
   * @returns {Promise<Object|null>}
   */
  async function replayPage(page) {
    const cursor = cursorForPage[Number(page)];
    if (cursor === undefined) return null; // don't know how to reach this page
    const hash = capturedHash || (await readCachedHash()) || DEFAULT_HASH;
    try {
      const purchaseHistory = await fetchPurchaseHistoryPage(hash, cursor);
      return buildSnapshot(purchaseHistory, "fetch");
    } catch (error) {
      console.warn(`[WIE] replayPage(${page}) failed:`, error && error.message);
      return null;
    }
  }

  return {
    initialize,
    getBestSnapshot,
    getLatestSnapshotTimestamp,
    collectAllViaFetch,
    fetchOrderNodeViaMainWorld,
    noteCursor,
    replayPage,
  };
})();
/**
 * Scrapes order data from an individual order detail page.
 * Extracts product details, pricing, and order metadata from the print view.
 * @returns {Object} Order data including items, totals, and order info
 */
function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeLookupText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[’]/g, "'");
}

function normalizeOrderNumberValue(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function buildProductLinkLookup() {
  const lookup = new Map();
  const itemStacks = document.querySelectorAll(SELECTORS.ITEM_STACK);

  itemStacks.forEach((stack) => {
    const productName = cleanText(
      stack.querySelector('[data-testid="productName"] span')?.textContent ||
      stack.querySelector('[data-testid="productName"]')?.textContent
    );
    const productLink = stack.querySelector(SELECTORS.PRODUCT_LINK)?.href;

    if (!productName || !productLink) {
      return;
    }

    const normalizedName = normalizeLookupText(productName);
    if (!lookup.has(normalizedName)) {
      lookup.set(normalizedName, productLink);
    }
  });

  return lookup;
}

function resolveProductLink(productName, productLinkLookup) {
  const fallback = "N/A";
  if (!productName || !productLinkLookup || productLinkLookup.size === 0) {
    return fallback;
  }

  const normalizedName = normalizeLookupText(productName);
  if (productLinkLookup.has(normalizedName)) {
    return productLinkLookup.get(normalizedName);
  }

  for (const [name, href] of productLinkLookup.entries()) {
    if (name.includes(normalizedName) || normalizedName.includes(name)) {
      return href;
    }
  }

  return fallback;
}

function extractPrintItem(item) {
  const row = item.querySelector('.flex.justify-between');
  const primaryColumn = row?.querySelector(':scope > :first-child');

  const productName = cleanText(
    primaryColumn?.textContent ||
    item.querySelector(SELECTORS.PRINT_ITEM_NAME)?.textContent
  );

  const deliveryStatus = cleanText(
    item.querySelector('.print-bill-type')?.textContent ||
    item.querySelector(SELECTORS.PRINT_BILL_TYPE)?.textContent
  ) || CONSTANTS.TEXT.DELIVERY_LABEL;

  // Walmart renders "Qty 2" — extract the number so quantities compare
  // equal to the payload's numeric quantity in the item merge.
  const quantityText = cleanText(
    item.querySelector('.print-bill-qty')?.textContent ||
    item.querySelector('.print-bill-qty-mobile-view')?.textContent ||
    item.querySelector(SELECTORS.PRINT_BILL_QTY)?.textContent
  );
  const quantityMatch = quantityText.match(/(\d+(?:\.\d+)?)/);
  const quantity = quantityMatch ? quantityMatch[1] : quantityText;

  // Walmart renders "Discount price $6.30$7.72" (label + charged price +
  // struck-through original). The FIRST currency token is the charged price.
  const priceText = cleanText(
    item.querySelector('.print-bill-price')?.textContent ||
    item.querySelector(SELECTORS.PRINT_BILL_PRICE)?.textContent
  );
  const price = extractCurrencyValues(priceText)[0] || '';

  return {
    productName,
    deliveryStatus,
    quantity,
    price,
  };
}

function extractCurrencyValues(value) {
  if (!value) return [];
  const matches = String(value).match(/-?\$[\d,]+(?:\.\d{2})?/g);
  return matches ? matches.map((match) => cleanText(match)) : [];
}

function getLastCurrencyValue(value) {
  const amounts = extractCurrencyValues(value);
  return amounts[amounts.length - 1] || "";
}

function findElementByAriaLabel(fragment, root = document) {
  const searchRoot = root || document;
  const target = normalizeLookupText(fragment);
  return (
    Array.from(searchRoot.querySelectorAll('[aria-label]')).find((el) => {
      const ariaLabel = normalizeLookupText(el.getAttribute('aria-label'));
      return ariaLabel.includes(target);
    }) || null
  );
}

function parseOrderNextDataPayload() {
  try {
    const script = document.querySelector('script#__NEXT_DATA__');
    const payloadText = script?.textContent;
    if (!payloadText) {
      return null;
    }
    return JSON.parse(payloadText);
  } catch (error) {
    console.warn("Unable to parse __NEXT_DATA__ payload for order detail", error);
    return null;
  }
}

function getOrderNodeFromNextDataPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const detail = (
    payload?.props?.pageProps?.initialData?.data?.order ||
    payload?.pageProps?.initialData?.data?.order ||
    payload?.props?.pageProps?.order ||
    payload?.pageProps?.order ||
    payload?.order ||
    null
  );
  if (detail) return detail;

  // The redesigned detail page embeds purchase-history summaries rather than
  // initialData.data.order. Use only the summary for the requested order; its
  // items may have no prices, so the rendered invoice remains the line source.
  const orderNumber = normalizeOrderNumberValue(window.location.pathname?.match(/\/orders\/([\d-]+)/)?.[1]);
  if (!orderNumber) return null;
  const pageProps = payload?.props?.pageProps || payload?.pageProps;
  const orders = pageProps?.phRedesignInitialData?.data?.purchaseHistory?.orders;
  return (Array.isArray(orders) && orders.find((order) =>
    normalizeOrderNumberValue(order?.id || order?.displayId) === orderNumber
  )) || null;
}

function extractRedesignedInvoiceItems() {
  return Array.from(document.querySelectorAll('[data-testid="itemtile-stack"]')).flatMap((tile) => {
    if (!tile.querySelector('.print-item-title')) return [];
    // Unavailable items still have prices and quantities. Their accordion's
    // preceding heading, not the price, identifies them as uncharged.
    for (let node = tile; node && !node.classList.contains('print-bill-group'); node = node.parentElement) {
      const heading = cleanText(node.previousElementSibling?.textContent || '');
      if (/^(?:\d+\s+)?(?:unavailable|cancel(?:ed|led))(?:\s|$)/i.test(heading)) return [];
    }
    const productName = cleanText(tile.querySelector('[data-testid="productName"]')?.textContent || '');
    const quantity = cleanText(tile.querySelector('.bill-item-quantity')?.textContent || '').match(/\d+(?:\.\d+)?/)?.[0] || '';
    const price = getLastCurrencyValue(tile.querySelector('[data-testid="line-price"]')?.textContent || '');
    if (!productName || !quantity || !price) return [];
    const href = tile.querySelector('a[link-identifier="itemClick"]')?.getAttribute('href');
    return [{
      productName, quantity, price,
      productLink: href ? new URL(href, window.location.origin).href : 'N/A',
      deliveryStatus: cleanText(tile.closest('[data-testid="orderInfoCard"]')?.querySelector('h2')?.textContent || ''),
    }];
  });
}

function extractRedesignedInvoiceTotals() {
  const values = {};
  const deliveryFees = new Map();
  const adjustmentEntries = [];
  document.querySelectorAll('.print-bill-payment-section .bill-order-payment-spacing .justify-between').forEach((row) => {
    const visibleLabel = cleanText(row.firstElementChild?.textContent || '');
    const label = normalizeLookupText(visibleLabel);
    // Ignore repeated accessibility descriptions; use the last amount in the
    // actual value columns (delivery can show a crossed-out fee before $0).
    const columns = Array.from(row.children).slice(1).filter((child) => !child.classList.contains('ld_Ec'));
    const amount = getLastCurrencyValue(columns.map((child) => child.textContent).join(' '));
    if (!amount) return;
    adjustmentEntries.push({ label: visibleLabel, amount });
    if (/^items\s*\(/.test(label)) values.subtotalBeforeSavings = amount;
    else if (label === 'savings') values.savings = amount.startsWith('-') ? amount : `-${amount}`;
    else if (label === 'subtotal') values.orderSubtotal = amount;
    else if (label === 'total' || label === 'order total') values.orderTotal = amount;
    else if (/^(?:free )?(?:delivery|express)(?:\s|$)/.test(label)) deliveryFees.set(label, amount);
    else if (label === 'bag fee') values.bagFee = amount;
    else if (label === 'tax' || label === 'taxes') values.tax = amount;
    else if (label === 'driver tip' || label === 'tip') values.tip = amount;
  });
  if (deliveryFees.size === 1) values.deliveryCharges = deliveryFees.values().next().value;
  else if (deliveryFees.size > 1) {
    const cents = Array.from(deliveryFees.values()).reduce((sum, amount) =>
      sum + Math.round(Number(amount.replace(/[^0-9.-]/g, '')) * 100), 0);
    values.deliveryCharges = `$${(cents / 100).toFixed(2)}`;
  }
  return { ...values, ...collectFinancialAdjustments(adjustmentEntries) };
}

function extractTextFromNextData(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return cleanText(value);
  }

  if (Array.isArray(value)) {
    return cleanText(value.map((entry) => extractTextFromNextData(entry)).filter(Boolean).join(' '));
  }

  if (Array.isArray(value.parts)) {
    return cleanText(
      value.parts
        .map((part) => cleanText(part?.text || ''))
        .filter(Boolean)
        .join(' ')
    );
  }

  if (value.message) {
    return extractTextFromNextData(value.message);
  }

  if (value.title) {
    return extractTextFromNextData(value.title);
  }

  if (value.text) {
    return cleanText(value.text);
  }

  return '';
}

function formatOrderDateFromIsoString(value) {
  if (!value) {
    return '';
  }

  // Date-only strings ("2026-07-09") parse as UTC midnight, which renders as
  // the previous day in negative-offset timezones — treat them as local.
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  const parsedDate = dateOnlyMatch
    ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]))
    : new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    return cleanText(value);
  }

  return parsedDate.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });
}

function toAbsoluteWalmartUrl(value) {
  const rawValue = cleanText(value);
  if (!rawValue) {
    return '';
  }

  try {
    return new URL(rawValue, window.location.origin).href;
  } catch (error) {
    return rawValue;
  }
}

function extractNextDataAddressDetails(orderNode) {
  const groups = Array.isArray(orderNode?.groups_2101) ? orderNode.groups_2101 : [];

  const groupWithAddress = groups.find((group) => group?.deliveryAddress?.address) || null;
  const deliveryAddress = groupWithAddress?.deliveryAddress || orderNode?.deliveryAddress || null;

  const addressNode = deliveryAddress?.address || {};
  const recipient = cleanText(
    deliveryAddress?.fullName ||
      [deliveryAddress?.firstName, deliveryAddress?.lastName].filter(Boolean).join(' ') ||
      [orderNode?.customer?.firstName, orderNode?.customer?.lastName].filter(Boolean).join(' ')
  );

  const line = cleanText(
    addressNode?.addressString ||
      [
        addressNode?.addressLineOne,
        addressNode?.addressLineTwo,
        [addressNode?.city, addressNode?.state, addressNode?.postalCode].filter(Boolean).join(' '),
      ]
        .filter(Boolean)
        .join(', ')
  );

  const address = cleanText([recipient, line].filter(Boolean).join(', ')) || line;
  return {
    recipient,
    line,
    address,
  };
}

function extractNextDataPaymentMethods(orderNode) {
  const paymentMethods = Array.isArray(orderNode?.paymentMethods) ? orderNode.paymentMethods : [];

  const details = paymentMethods
    .map((paymentMethod, index) => {
      const brand = cleanText(paymentMethod?.cardType || paymentMethod?.paymentType || '');
      const ending = cleanText(paymentMethod?.description || paymentMethod?.title || '');
      const displayValues = [
        ...(Array.isArray(paymentMethod?.displayValues) ? paymentMethod.displayValues : []),
        ...(Array.isArray(paymentMethod?.detailedDisplayValues) ? paymentMethod.detailedDisplayValues : []),
      ];
      // Keep only amount-shaped entries ("$25.00", "-12.50") — Walmart mixes
      // descriptive strings into these arrays on some orders.
      const amountValues = displayValues
        .map((value) => cleanText(typeof value === 'string'
          ? value
          : value?.displayValue || value?.amount?.displayValue || value?.amount || ''))
        .filter((value) => /^-?\$?\s*[\d,]+(?:\.\d{2})?$/.test(value));
      const amount = amountValues.length > 0 ? amountValues.join(' + ') : '';
      const message = extractTextFromNextData(paymentMethod?.message);

      return {
        cardId: cleanText(paymentMethod?.paymentPreferenceId || `nextdata-card-${index}`),
        brand,
        ending,
        amount,
        message,
      };
    })
    .filter((entry) => entry.brand || entry.ending || entry.amount || entry.message);
  return dedupePaymentMethodDetails(details);
}

function extractNextDataFeeBreakdown(orderNode) {
  const fees = Array.isArray(orderNode?.priceDetails?.fees) ? orderNode.priceDetails.fees : [];

  return fees
    .map((fee) => {
      const label = cleanText(fee?.label || fee?.info?.title || '');
      const amount = cleanText(fee?.displayValue || '');
      const originalAmount = cleanText(fee?.strikeThroughValue || fee?.strikeValue || '');

      return {
        label,
        amount,
        originalAmount,
        rawText: cleanText([label, originalAmount, amount].filter(Boolean).join(' ')),
      };
    })
    .filter((entry) => entry.label || entry.amount || entry.originalAmount);
}

function classifyFinancialAdjustmentLabel(label) {
  const normalized = normalizeLookupText(label).replace(/[‐‑‒–—]/g, '-');
  const isThreeHoursOrLess = /(?:3|three)[\s-]*(?:hours?|hrs?)[\s-]*or[\s-]*(?:less|fewer|under)/i.test(normalized);
  if (isThreeHoursOrLess && /return/i.test(normalized)) return 'returnedThreeHoursOrLessFee';
  if (isThreeHoursOrLess) return 'threeHoursOrLessFee';
  if (/\b(?:promo|promotional|coupon)\b/i.test(normalized)) return 'promoCodeAmount';
  if (/\bdonations?\b/i.test(normalized)) return 'donations';
  if (/\brefund(?:ed)?\b/i.test(normalized)) return 'refund';
  return '';
}

function collectFinancialAdjustments(entries) {
  const result = {
    promoCodeAmount: '',
    threeHoursOrLessFee: '',
    returnedThreeHoursOrLessFee: '',
    donations: '',
    refund: '',
    financialAdjustments: [],
  };
  const standardLabel = /^(?:items?(?:\s*\(\s*\d+\s*\)|\s+\d+\s+items?)?|subtotal(?:\s+\(\s*\d+\s+items?\s*\))?(?:\s+after\s+savings)?|savings|delivery(?:\s+from\s+store|\s+charges?|\s+fee)?|express(?:\s+delivery|\s+fee)?|free\s+(?:delivery|shipping)(?:\s+from\s+store)?(?:\s*,?\s*no\s+order\s+minimum)?|no\s+order\s+minimum|bag\s+fee|tax(?:es)?|driver\s+tip|tip|donations?|total|order\s+total|temporary\s+adjusted\s+total|estimated\s+total)$/i;
  const seen = new Set();

  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const label = cleanText(entry?.label || '');
    const amount = cleanText(entry?.amount || '');
    if (!label || !amount) return;
    const numericAmount = Number(amount.replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(numericAmount) || numericAmount === 0) return;

    const field = classifyFinancialAdjustmentLabel(label);
    if (field) {
      if (!result[field]) result[field] = amount;
      return;
    }
    if (standardLabel.test(label)) return;

    const key = `${normalizeLookupText(label)}|${amount}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.financialAdjustments.push({ label, amount });
  });
  return result;
}

function extractFinancialAdjustments(feeBreakdown) {
  return collectFinancialAdjustments(feeBreakdown);
}

function getDeliveryFeeAmount(feeBreakdown) {
  const matches = (Array.isArray(feeBreakdown) ? feeBreakdown : []).filter((entry) => {
    const label = normalizeLookupText(entry?.label || '');
    return /\b(?:delivery|express)\b/.test(label) &&
      !/\b(?:discount|savings|coupon|promo|original|normally)\b/.test(label);
  });
  if (matches.length === 0) return '';
  const cents = matches.reduce((sum, entry) => {
    const value = Number(String(entry.amount || '').replace(/[^\d.-]/g, ''));
    return sum + (Number.isFinite(value) ? Math.round(value * 100) : 0);
  }, 0);
  return `$${(cents / 100).toFixed(2)}`;
}

function mergeFinancialAdjustments(...sources) {
  const merged = {
    promoCodeAmount: '',
    threeHoursOrLessFee: '',
    returnedThreeHoursOrLessFee: '',
    donations: '',
    refund: '',
    financialAdjustments: [],
  };
  const seen = new Set();
  sources.forEach((source) => {
    if (!source || typeof source !== 'object') return;
    for (const field of ['promoCodeAmount', 'threeHoursOrLessFee', 'returnedThreeHoursOrLessFee', 'donations', 'refund']) {
      if (!merged[field] && source[field] !== '' && source[field] !== null && source[field] !== undefined) {
        merged[field] = cleanText(source[field]);
      }
    }
    (Array.isArray(source.financialAdjustments) ? source.financialAdjustments : []).forEach((entry) => {
      const label = cleanText(entry?.label || '');
      const amount = cleanText(entry?.amount || '');
      if (!label || !amount) return;
      const key = `${normalizeLookupText(label)}|${amount}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.financialAdjustments.push({ label, amount });
    });
  });
  return merged;
}

/**
 * Extract per-shipment metadata (marketplace sellers, fulfillment types,
 * delivered dates, tracking numbers) from the order payload's groups.
 * Payload-only data — the print-view DOM has no reliable equivalent, so
 * these fields stay blank when the payload is unavailable.
 * @param {Object} orderNode - Order node from __NEXT_DATA__
 * @returns {{sellers: string, fulfillmentTypes: string, deliveredDate: string, trackingNumbers: string}}
 */
function extractNextDataShipmentDetails(orderNode) {
  const groups = Array.isArray(orderNode?.groups_2101) && orderNode.groups_2101.length > 0
    ? orderNode.groups_2101
    : Array.isArray(orderNode?.groups)
      ? orderNode.groups
      : [];

  const sellers = [];
  const fulfillmentTypes = [];
  const deliveredDates = [];
  const trackingNumbers = [];

  const pushUnique = (list, value) => {
    const clean = cleanText(value);
    if (clean && !list.includes(clean)) {
      list.push(clean);
    }
  };

  groups.forEach((group) => {
    pushUnique(
      sellers,
      group?.seller?.sellerDisplayName || group?.seller?.displayName || group?.seller?.name || ''
    );
    pushUnique(fulfillmentTypes, group?.fulfillmentType || '');

    const deliveredRaw = group?.deliveredDate || group?.deliveryDate || '';
    // Dates arrive as ISO strings or epoch milliseconds depending on the field.
    const deliveredValue = /^\d{12,}$/.test(String(deliveredRaw)) ? Number(deliveredRaw) : deliveredRaw;
    pushUnique(deliveredDates, formatOrderDateFromIsoString(deliveredValue));

    const packages = [
      group?.shipment,
      ...(Array.isArray(group?.shipment?.multiPackageDetails) ? group.shipment.multiPackageDetails : []),
      ...(Array.isArray(group?.multiPackageDetails) ? group.multiPackageDetails : []),
    ];
    packages.forEach((pkg) => {
      pushUnique(trackingNumbers, pkg?.trackingNumber || pkg?.trackingNo || pkg?.trackingId || '');
    });
  });

  return {
    sellers: sellers.join('; '),
    fulfillmentTypes: fulfillmentTypes.join(', '),
    deliveredDate: deliveredDates.join('; '),
    trackingNumbers: trackingNumbers.join('; '),
  };
}

/**
 * One tender's label, without saying the brand twice.
 *
 * `brand` comes from the row's `img[alt]` and `ending` from its card-description text.
 * For a card those differ usefully ("Visa" + "Ending in 4122"), but for Walmart Cash and
 * gift cards both read "Walmart Cash", so joining them yields "Walmart Cash Walmart Cash".
 * The same happens whenever the description already contains the brand, e.g.
 * "Visa" + "Walmart Visa ending in 8527".
 *
 * Latent until now: paymentSplit was always empty, so nothing ever rendered these labels.
 *
 * @param {string} brand
 * @param {string} ending
 * @returns {string}
 */
function buildTenderLabel(brand, ending) {
  const b = cleanText(brand || '');
  const e = cleanText(ending || '');
  if (!b) return e;
  if (!e) return b;
  const description = e.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '');
  const escapedBrand = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const containsBrand = new RegExp(`(^|[^a-z0-9])${escapedBrand}(?=$|[^a-z0-9])`, 'i').test(description);
  return containsBrand ? e : `${b} ${e}`;
}

function normalizeTenderBrand(value) {
  const normalized = normalizeLookupText(value || '').replace(/[^a-z0-9]/g, '');
  return normalized === 'wmtrc' ? 'walmartcash' : normalized;
}

function sameMoneyAmount(left, right) {
  const toCents = (value) => {
    const text = cleanText(value || '');
    if (!/^-?\$?\s*[\d,]+(?:\.\d{2})?$/.test(text)) return null;
    return Math.round(Number(text.replace(/[$,\s]/g, '')) * 100);
  };
  const a = toCents(left);
  const b = toCents(right);
  return a !== null && a === b;
}

/**
 * Walmart sometimes emits the same tender twice under a specific brand and a
 * generic code (`WMTRC` for Walmart Cash or `OTHER` for a gift card). The
 * masked tender description is the stable identity shared by those records.
 */
function dedupePaymentMethodDetails(details) {
  const result = [];
  (Array.isArray(details) ? details : []).forEach((entry) => {
    const duplicateIndex = result.findIndex((existing) => {
      const brands = [normalizeTenderBrand(existing.brand), normalizeTenderBrand(entry.brand)];
      const wmtrcAliasPair = brands.includes('walmartcash') &&
        [normalizeLookupText(existing.brand), normalizeLookupText(entry.brand)].some((brand) => /\bwmtrc\b/i.test(brand)) &&
        [normalizeLookupText(existing.brand), normalizeLookupText(entry.brand)].some((brand) => /\bwalmart cash\b/i.test(brand));
      const otherAliasPair = brands.includes('other') && brands.some((brand) => brand && brand !== 'other');
      const existingEnding = normalizeLookupText(existing.ending || '');
      const entryEnding = normalizeLookupText(entry.ending || '');
      const bothAmountsMissing = !cleanText(existing.amount || '') && !cleanText(entry.amount || '');
      const sameTender = existingEnding && existingEnding === entryEnding;
      return sameTender && (
        (otherAliasPair && (sameMoneyAmount(existing.amount, entry.amount) || bothAmountsMissing ||
          !cleanText(existing.amount || '') || !cleanText(entry.amount || ''))) ||
        (wmtrcAliasPair && (sameMoneyAmount(existing.amount, entry.amount) || bothAmountsMissing))
      );
    });

    if (duplicateIndex < 0) {
      result.push(entry);
      return;
    }

    const existing = result[duplicateIndex];
    const preferred = normalizeTenderBrand(entry.brand) === 'other'
      ? existing
      : normalizeTenderBrand(existing.brand) === 'other'
        ? entry
        : /\bwalmart cash\b/i.test(normalizeLookupText(entry.brand)) ? entry : existing;
    result[duplicateIndex] = {
      ...existing,
      ...entry,
      ...preferred,
      amount: preferred.amount || existing.amount || entry.amount || '',
      message: existing.message || entry.message || '',
    };
  });
  return result;
}

/**
 * Format the per-card charge split, e.g. "VISA ending in 1234: $10.00; Gift Card: $5.00".
 * Works for both payload- and DOM-sourced payment method details.
 * @param {Array} paymentMethodDetails - Entries with brand/ending/amount
 * @returns {string}
 */
function buildPaymentSplit(paymentMethodDetails) {
  const details = Array.isArray(paymentMethodDetails) ? paymentMethodDetails : [];
  return details
    .map((method) => {
      if (!method?.amount) {
        return '';
      }
      const label = buildTenderLabel(method.brand, method.ending);
      return label ? `${label}: ${method.amount}` : method.amount;
    })
    .filter(Boolean)
    .join('; ');
}

/** Merge DOM tenders with payload tenders, filling DOM-missing amounts safely. */
function mergePaymentMethodDetails(domDetails, payloadDetails) {
  const dom = Array.isArray(domDetails) ? domDetails : [];
  const payload = Array.isArray(payloadDetails) ? payloadDetails : [];
  const normalized = (value) => normalizeLookupText(value || '').replace(/[^a-z0-9]/g, '');
  const usedPayload = new Set();
  const merged = dom.map((entry, index) => {
    const brand = normalized(entry.brand);
    const ending = normalized(entry.ending);
    let candidates = payload.map((candidate, payloadIndex) => ({ candidate, payloadIndex }))
      .filter(({ payloadIndex }) => !usedPayload.has(payloadIndex));
    let matches = candidates.filter(({ candidate }) => {
      const candidateBrand = normalized(candidate.brand);
      const candidateEnding = normalized(candidate.ending);
      return ending && candidateEnding && (ending === candidateEnding || ending.endsWith(candidateEnding) || candidateEnding.endsWith(ending)) &&
        (!brand || !candidateBrand || brand === candidateBrand || brand.includes(candidateBrand) || candidateBrand.includes(brand));
    });
    if (matches.length !== 1 && dom.length === payload.length) {
      const indexed = candidates.find(({ payloadIndex }) => payloadIndex === index);
      if (indexed) {
        const candidateBrand = normalized(indexed.candidate.brand);
        const candidateEnding = normalized(indexed.candidate.ending);
        const endingCompatible = !ending || !candidateEnding || ending === candidateEnding ||
          ending.endsWith(candidateEnding) || candidateEnding.endsWith(ending);
        if (endingCompatible && (!brand || !candidateBrand || brand === candidateBrand || brand.includes(candidateBrand) || candidateBrand.includes(brand))) {
          matches = [indexed];
        }
      }
    }
    const match = matches.length === 1 ? matches[0] : null;
    if (match) usedPayload.add(match.payloadIndex);
    const fallback = match?.candidate || {};
    return {
      ...fallback,
      ...entry,
      brand: entry.brand || fallback.brand || '',
      ending: entry.ending || fallback.ending || '',
      amount: entry.amount || fallback.amount || '',
      message: entry.message || fallback.message || '',
    };
  });
  payload.forEach((entry, index) => {
    if (!usedPayload.has(index)) merged.push(entry);
  });
  return dedupePaymentMethodDetails(merged);
}

function collectItemsFromNextDataGroups(groups, pushItem) {
  if (!Array.isArray(groups)) {
    return false;
  }

  // Reported to the caller so the DOM merge knows the payload is charged
  // truth (see mergeOrderItems): true when any group was read through its
  // categories tree rather than a flat legacy list.
  let usedCategories = false;

  groups.forEach((group) => {
    const groupStatus = extractTextFromNextData(group?.status?.message) || extractTextFromNextData(group?.status);

    // Charged-truth traversal. The flat group.items list is the ORDERED view:
    // it still contains UNAVAILABLE items (listed but never charged), so
    // summing it overstates what the card was charged. The categories tree is
    // what Walmart's own printed invoice renders, and its non-UNAVAILABLE
    // linePrice values sum exactly to priceDetails.subTotal (verified against
    // real invoices to the penny). Note group.subGroups[].categories is a
    // DUPLICATE copy of group.categories on multi-fulfillment orders —
    // traverse exactly one of the two, never both.
    const categories = Array.isArray(group?.categories) && group.categories.length > 0
      ? group.categories
      : (Array.isArray(group?.subGroups) ? group.subGroups : []).flatMap((subGroup) =>
          Array.isArray(subGroup?.categories) ? subGroup.categories : []
        );

    // History summaries may list category types without item arrays. Those
    // are metadata only; the rendered invoice must still supply its lines.
    if (categories.some(category => Array.isArray(category?.items))) {
      usedCategories = true;
      categories.forEach((category) => {
        const categoryType = String(category?.type || '').toUpperCase();
        // UNAVAILABLE / CANCELED lines were never charged; RETURNED lines
        // were charged (the refund is its own transaction), so they stay.
        if (categoryType === 'UNAVAILABLE' || categoryType.indexOf('CANCEL') === 0) {
          return;
        }
        const items = Array.isArray(category?.items) ? category.items : [];
        // Each category line is one charged line — real orders legitimately
        // contain identical duplicate lines (same product, same price, two
        // lines), and item ids are NOT unique across an order, so no
        // dedup key can be trusted here. The either/or traversal above is
        // single-pass, so nothing can be visited twice.
        items.forEach((item) => pushItem(item, groupStatus, { noDedup: true }));
      });
      return;
    }

    if (Array.isArray(group?.items) && group.items.length > 0) {
      group.items.forEach((item) => pushItem(item, groupStatus));
    }
  });

  return usedCategories;
}

function extractItemsFromNextData(orderNode) {
  const items = [];
  const seen = new Set();

  const pushItem = (item, groupStatus = '', opts = null) => {
    const productName = cleanText(item?.productInfo?.name || item?.name || '');
    const quantity = item?.quantity === 0 || item?.quantity
      ? String(item.quantity)
      : '';
    const price = cleanText(
      item?.priceInfo?.linePrice?.displayValue ||
        item?.priceInfo?.itemPrice?.displayValue ||
        item?.linePrice?.displayValue ||
        item?.price?.displayValue ||
        ''
    );

    if (!productName && !quantity && !price) {
      return;
    }

    // The categories traversal is single-pass and its duplicate lines are
    // real (see collectItemsFromNextDataGroups); only the legacy flat-list
    // fallbacks still need the name|quantity|price guard.
    if (!(opts && opts.noDedup)) {
      const key = `${normalizeLookupText(productName)}|${quantity}|${price}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
    }

    const canonicalUrl = cleanText(item?.productInfo?.canonicalUrl || item?.canonicalUrl || '');
    // Walmart dropped canonicalUrl from the order payload (live-verified
    // 2026-07); /ip/<usItemId> is the canonical product URL, so the payload
    // path stays link-complete even when the DOM backfill has nothing.
    const usItemIdForLink = cleanText(item?.productInfo?.usItemId || item?.usItemId || '');
    const productLink = canonicalUrl
      ? toAbsoluteWalmartUrl(canonicalUrl)
      : usItemIdForLink
        ? `https://www.walmart.com/ip/${usItemIdForLink}`
        : 'N/A';
    const thumbnailUrl = cleanText(
      item?.productInfo?.imageInfo?.thumbnailUrl || item?.imageInfo?.thumbnailUrl || ''
    );

    items.push({
      productName,
      productLink,
      deliveryStatus: cleanText(groupStatus) || CONSTANTS.TEXT.DELIVERY_LABEL,
      quantity,
      price,
      thumbnailUrl,
      usItemId: cleanText(item?.productInfo?.usItemId || item?.usItemId || ''),
    });
  };

  let usedCategories = collectItemsFromNextDataGroups(orderNode?.groups_2101, pushItem) === true;

  if (items.length === 0 && !usedCategories) {
    usedCategories = collectItemsFromNextDataGroups(orderNode?.groups, pushItem) === true;
  }

  if (items.length === 0 && !usedCategories && Array.isArray(orderNode?.items)) {
    orderNode.items.forEach((item) => pushItem(item, ''));
    usedCategories = false;
  }

  // Tag (non-index array property; invisible to JSON/iteration) so
  // mergeOrderItems knows these items are the charged-truth set and must
  // not be "completed" with DOM rows the traversal deliberately excluded.
  if (usedCategories) {
    items.fromChargedCategories = true;
  }

  return items;
}

/**
 * A fully canceled order has a charged-categories tree with no charged lines.
 * Mark it, so an honest "nothing was charged" is not mistaken for a failed
 * read (which would be retried forever or reported as a site change).
 * @param {Array} items - result of extractItemsFromNextData
 * @returns {{noChargedItems?: true}}
 */
function noChargedItemsFlag(items) {
  return Array.isArray(items) && items.length === 0 && items.fromChargedCategories === true
    ? { noChargedItems: true }
    : {};
}

function mergeOrderItems(domItems, nextDataItems) {
  const scrapedItems = Array.isArray(domItems) ? domItems : [];
  const payloadItems = Array.isArray(nextDataItems) ? nextDataItems : [];

  // Key by name + quantity ONLY. Including the price made the same item
  // survive twice whenever the DOM scrape got the price wrong (e.g. $0.00),
  // which is exactly when dedup matters most.
  const itemKey = (item) => {
    const productName = normalizeLookupText(item?.productName || '');
    // 'Qty 2', ' 2 ', and 2 must all compare equal.
    const quantity = String(item?.quantity ?? '').replace(/[^\d.]/g, '');
    return `${productName}|${quantity}`;
  };

  if (payloadItems.length === 0 && !nextDataItems?.fromChargedCategories) {
    return scrapedItems;
  }

  // When the payload came from the charged-truth categories traversal it is
  // COMPLETE: a DOM row with no payload match is a row the traversal
  // deliberately excluded (an UNAVAILABLE/CANCELED line the print bill still
  // renders, with a price) or a name-variant duplicate — appending it would
  // resurrect exactly what was excluded. DOM rows then only backfill fields,
  // never add lines. Legacy flat-list payloads keep the historic append.
  const payloadIsChargedTruth = Boolean(nextDataItems && nextDataItems.fromChargedCategories);

  // The payload is the primary source (extraction order: payload → DOM).
  // MULTISET semantics: each payload line absorbs at most ONE matching DOM
  // line, so two genuinely distinct lines with the same name+quantity (e.g.
  // a shipped item plus its re-priced substitution) both survive, while a
  // single DOM garbage copy of a payload item is still discarded.
  const mergedItems = [...payloadItems];
  const remaining = new Map();
  payloadItems.forEach((item) => {
    const key = itemKey(item);
    remaining.set(key, (remaining.get(key) || 0) + 1);
  });
  const scrapedByKey = new Map();

  scrapedItems.forEach((item) => {
    const key = itemKey(item);
    const available = remaining.get(key) || 0;
    if (available > 0) {
      remaining.set(key, available - 1);
      // Remember one DOM copy per key for backfill below.
      if (!scrapedByKey.has(key)) scrapedByKey.set(key, item);
      return;
    }
    if (payloadIsChargedTruth) {
      return;
    }
    mergedItems.push(item);
  });

  // Backfill fields the payload sometimes lacks from the matched DOM copy —
  // including the price, which the payload occasionally omits.
  mergedItems.forEach((item) => {
    const match = scrapedByKey.get(itemKey(item));
    if (!match) return;
    if ((!item.productLink || item.productLink === 'N/A') && match.productLink && match.productLink !== 'N/A') {
      item.productLink = match.productLink;
    }
    if (!item.thumbnailUrl && match.thumbnailUrl) {
      item.thumbnailUrl = match.thumbnailUrl;
    }
    if (!cleanText(String(item.price || '')) && cleanText(String(match.price || ''))) {
      item.price = match.price;
    }
  });

  return mergedItems;
}

function extractOrderDataFromNextData(providedOrderNode) {
  // Normally read from THIS page's __NEXT_DATA__; Fast invoice collection passes
  // an order node fetched from another order's detail HTML (same shape), so the
  // full invoice can be built without opening a tab for that order.
  let orderNode = providedOrderNode || null;
  if (!orderNode) {
    const payload = parseOrderNextDataPayload();
    orderNode = getOrderNodeFromNextDataPayload(payload);
  }
  if (!orderNode) {
    return null;
  }

  const feeBreakdown = extractNextDataFeeBreakdown(orderNode);
  const paymentMethodDetails = extractNextDataPaymentMethods(orderNode);
  const paymentMethods = paymentMethodDetails
    .map((method) => [method.brand, method.ending].filter(Boolean).join(' - '))
    .filter(Boolean)
    .join('; ');
  const paymentMessages = Array.from(
    new Set(paymentMethodDetails.map((method) => method.message).filter(Boolean))
  ).join('; ');

  const priceDetails = orderNode?.priceDetails || {};
  const financialFields = collectFinancialAdjustments(feeBreakdown);
  const deliveryInstructions = cleanText(
    orderNode?.groups_2101?.find((group) => group?.deliveryInstructions)?.deliveryInstructions?.text ||
      orderNode?.deliveryInstructions?.text ||
      ''
  );

  const addressDetails = extractNextDataAddressDetails(orderNode);
  const shipmentDetails = extractNextDataShipmentDetails(orderNode);

  const chargedItems = extractItemsFromNextData(orderNode);

  return {
    // Same schema stamp as scrapeOrderData: WITHOUT it, putInvoice stores the
    // fast-fetched invoice but hasInvoice/the dashboard treat it as a pre-v3
    // record and ignore it — "saved but invisible" (bug fixed 2026-07-19).
    schemaVersion: CONSTANTS.ORDER_SCHEMA_VERSION,
    walmartExtractionVersion: CONSTANTS.WALMART_US_EXTRACTION_VERSION,
    orderNumber: normalizeOrderNumberValue(orderNode?.id || orderNode?.displayId),
    orderDate:
      formatOrderDateFromIsoString(orderNode?.orderDate) ||
      cleanText(orderNode?.shortTitle || orderNode?.title).replace(/order/i, '').trim(),
    orderType: cleanText(orderNode?.type || ''),
    isInStore: Boolean(orderNode?.isInStore),
    orderSubtotal: cleanText(priceDetails?.subTotal?.displayValue || ''),
    subtotalBeforeSavings: cleanText(priceDetails?.strikethroughSubTotal?.displayValue || ''),
    savings: cleanText(priceDetails?.savings?.displayValue || ''),
    orderTotal: cleanText(
      priceDetails?.grandTotalWithTips?.displayValue ||
        priceDetails?.grandTotal?.displayValue ||
        // Purchase-history nodes (and some order-detail SSR payloads) expose the
        // total as priceDetails.orderTotal instead of grandTotal — fall back to
        // it so the fast path never stores an empty total.
        priceDetails?.orderTotal?.displayValue ||
        ''
    ),
    deliveryCharges: getDeliveryFeeAmount(feeBreakdown),
    bagFee: getFeeAmount(feeBreakdown, 'bag fee') || getFeeAmount(feeBreakdown, 'bag') || '',
    tax: cleanText(priceDetails?.taxTotal?.displayValue || ''),
    tip: cleanText(priceDetails?.driverTip?.displayValue || ''),
    promoCodeAmount: cleanText(financialFields.promoCodeAmount || priceDetails?.promoCodeAmount?.displayValue || priceDetails?.promoCode?.displayValue || ''),
    threeHoursOrLessFee: cleanText(financialFields.threeHoursOrLessFee || priceDetails?.threeHoursOrLessFee?.displayValue || ''),
    returnedThreeHoursOrLessFee: cleanText(financialFields.returnedThreeHoursOrLessFee || priceDetails?.returnedThreeHoursOrLessFee?.displayValue || ''),
    refund: cleanText(financialFields.refund || priceDetails?.refund?.displayValue || ''),
    donations: cleanText(financialFields.donations || priceDetails?.donations?.displayValue || ''),
    financialAdjustments: financialFields.financialAdjustments,
    barcodeImageUrl: cleanText(orderNode?.idBarcodeImageUrl || ''),
    sellers: shipmentDetails.sellers,
    fulfillmentTypes: shipmentDetails.fulfillmentTypes,
    deliveredDate: shipmentDetails.deliveredDate,
    trackingNumbers: shipmentDetails.trackingNumbers,
    address: addressDetails.address,
    addressRecipient: addressDetails.recipient,
    addressLine: addressDetails.line,
    deliveryInstructions,
    paymentMethods,
    paymentMethodDetails,
    paymentMessages,
    items: chargedItems,
    ...noChargedItemsFlag(chargedItems),
  };
}

function extractAddressDetailsFromOrderPage() {
  const addressContainers = Array.from(
    document.querySelectorAll('.print-bill-payment-section .flex.flex-column.mid-gray, .print-bill-payment-section [data-sensitivity="severe"]')
  );

  const parts = [];
  const seen = new Set();

  addressContainers.forEach((container) => {
    const lines = Array.from(container.querySelectorAll('[data-sensitivity="medium"], span'))
      .map((el) => cleanText(el.textContent))
      .filter(Boolean);

    lines.forEach((line) => {
      const key = line.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        parts.push(line);
      }
    });
  });

  if (parts.length > 0) {
    const recipient = parts[0] || "";
    const line = parts.slice(1).join(', ');
    const address = parts.slice(0, 2).join(', ');
    return { recipient, line, address };
  }

  const fallbackParts = Array.from(document.querySelectorAll(SELECTORS.ADDRESS))
    .map((el) => cleanText(el.textContent))
    .filter(Boolean);

  const deduped = Array.from(new Set(fallbackParts));
  return {
    recipient: deduped[0] || "",
    line: deduped.slice(1).join(', '),
    address: deduped.slice(0, 2).join(', '),
  };
}

function extractAddressFromOrderPage() {
  return extractAddressDetailsFromOrderPage().address;
}

function extractDeliveryInstructionsFromOrderPage() {
  const heading = Array.from(document.querySelectorAll('.print-bill-payment-section h2'))
    .find((node) => normalizeLookupText(node.textContent).includes('delivery instructions'));
  const toggleButton = document.querySelector('button[data-automation-id="delivery-instruction-hide-show-link"]');
  const expanded = toggleButton?.getAttribute('aria-expanded') === 'true';

  if (!heading) {
    return { instructions: '', expanded };
  }

  const section =
    heading.closest('div.ph3.pv4.pb3-m.ph0-m.pt0-m') ||
    heading.parentElement?.parentElement ||
    heading.parentElement;

  if (!section) {
    return { instructions: '', expanded };
  }

  const clone = section.cloneNode(true);
  clone.querySelectorAll('h1, h2, h3, h4, h5, h6, button').forEach((el) => el.remove());

  const instructions = cleanText(clone.textContent)
    .replace(/show delivery instructions/i, '')
    .replace(/hide delivery instructions/i, '')
    .trim();

  return { instructions, expanded };
}

function extractFeeBreakdownFromOrderPage() {
  const feeRows = Array.from(document.querySelectorAll('.print-bill-payment-section .print-fees-item'));

  return feeRows
    .map((row) => {
      const srText = cleanText(row.querySelector('.ld_FS')?.textContent || '');
      const labelText = cleanText(
        row.querySelector('.pr3 .ld_Ek.ld_Eq.ld_Eo')?.textContent ||
        row.querySelector('.pr3 .ld_Ek.ld_Eq.ld_En')?.textContent ||
        row.querySelector('.pr3 .ld_Ek.ld_Eq')?.textContent
      );

      const visibleAmounts = Array.from(
        row.querySelectorAll('.flex.justify-between.items-end span, .flex.justify-between.items-end .ld_Ek')
      )
        .map((el) => cleanText(el.textContent))
        .filter((value) => /\$/.test(value));

      const srAmounts = extractCurrencyValues(srText);
      const amount = visibleAmounts[visibleAmounts.length - 1] || srAmounts[srAmounts.length - 1] || '';
      const originalAmount = visibleAmounts.length > 1
        ? visibleAmounts[0]
        : (srAmounts.length > 1 ? srAmounts[0] : '');

      let label = labelText;
      if (!label && srText) {
        label = cleanText(srText.replace(/-?\$[\d,]+(?:\.\d{2})?/g, ' '));
      }

      return {
        label,
        amount,
        originalAmount,
        rawText: srText,
      };
    })
    .filter((fee) => fee.label || fee.amount || fee.originalAmount);
}

function getFeeAmount(feeBreakdown, keyword) {
  const normalizedKeyword = normalizeLookupText(keyword);
  const fee = feeBreakdown.find((entry) => {
    const label = normalizeLookupText(entry.label || '');
    const rawText = normalizeLookupText(entry.rawText || '');
    return label.includes(normalizedKeyword) || rawText.includes(normalizedKeyword);
  });

  return fee?.amount || '';
}

/**
 * The amount charged to one payment method, from its row in the payment card.
 *
 * Walmart moved `flex-auto` off the amount and onto the label beside it, so the
 * long-standing `.tr.flex-auto` matches nothing on current order pages. The amount
 * still carries `tr` (right-aligned); it is the sibling label that is now
 * `div.flex.flex-column.flex-auto`:
 *
 *   div.flex.items-center.mb3
 *     div.flex.flex-column.flex-auto  > span…b            "Ending in 8527"
 *     span.ld_Ee.ld_Ek.ld_Eh.tr       > div               "$75.29"
 *
 * Because that selector silently returned nothing, EVERY split-tender order exported
 * with an empty `paymentSplit` — and a split tender is exactly the case where the card
 * is charged less than the order total, so the loss is the figure a bank feed shows.
 *
 * `.tr.flex-auto` is still tried first so older pages keep working, and the fallback is
 * scoped to the row, where `tr` marks the right-aligned money column.
 *
 * @param {Element} row - one `.flex.items-center.mb3` payment row
 * @returns {string} e.g. "$75.29", or '' when the row shows no amount
 */
function readPaymentRowAmount(row) {
  // `.tr` is a utility class (text-align: right), so a different layout could carry one
  // that is not the amount. A candidate is accepted only when its WHOLE text is an
  // amount — anchored, not merely containing a number, so a date ("12.31.25") or a
  // version ("v1.25") cannot slip through. A wrong amount is worse than none, because it
  // would flow into paymentSplit as fact; returning '' instead lets the extraction
  // warning below say so.
  const candidates = [
    row?.querySelector('.tr.flex-auto'),
    ...(row?.querySelectorAll ? Array.from(row.querySelectorAll('.tr')) : []),
  ];
  for (const candidate of candidates) {
    const text = cleanText(candidate?.textContent || '');
    if (/^-?\$?\s*[\d,]+(\.\d{2})?$/.test(text)) {
      return text;
    }
  }
  return '';
}

function readPaymentBrand(row) {
  return cleanText(row?.querySelector('img[alt]')?.alt ||
    row?.querySelector('[data-wie-image-alt]')?.getAttribute('data-wie-image-alt') || '');
}

function extractPaymentDetailsFromOrderPage() {
  const methods = [];
  const seen = new Set();

  const paymentInfo = document.querySelector('.bill-order-payment-info');
  const paymentRows = new Set(document.querySelectorAll('.bill-order-payment-info .flex.items-center.mb3'));
  // Some in-store and receipt layouts keep the accessible card label and
  // amount but change the row utility classes. Walk up from the stable
  // aria-labelledby marker so those rows still contribute their visible split.
  Array.from(document.querySelectorAll(SELECTORS.PAYMENT_METHODS)).forEach((method) => {
    const row = method.closest('.flex.items-center.mb3') ||
      method.closest('.flex.items-center') || method.parentElement;
    if (row && (!paymentInfo || paymentInfo.contains(row))) paymentRows.add(row);
  });

  Array.from(paymentRows).sort((left, right) => {
    const position = left.compareDocumentPosition?.(right) || 0;
    return position & 4 ? -1 : position & 2 ? 1 : 0;
  }).forEach((row) => {
    const endingElement = row.querySelector('[aria-labelledby^="card-description-"]');
    const ending = cleanText(endingElement?.textContent || '');
    const cardId = cleanText(endingElement?.getAttribute('aria-labelledby') || ending);
    if (!cardId && !ending) {
      return;
    }

    const brand = readPaymentBrand(row);
    const amount = readPaymentRowAmount(row);
    const message = cleanText(row.parentElement?.querySelector('.mt3')?.textContent || '');

    const key = `${cardId}|${brand}|${ending}|${amount}|${message}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    methods.push({ cardId, brand, ending, amount, message });
  });

  return methods;
}

function parsePaymentAmountCents(value) {
  const text = cleanText(value || '');
  if (!/^-?\$?\s*[\d,]+(?:\.\d{2})?$/.test(text)) return null;
  const amount = Number(text.replace(/[$,\s]/g, ''));
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function formatPaymentAmountCents(cents) {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function paymentHistorySectionAmount(section) {
  const rows = Array.from(section?.querySelectorAll('li') || []);
  const groupHeadings = Array.from(section?.querySelectorAll('h4') || []);
  const finalRows = rows.filter((row) => {
    if (!groupHeadings.length) return true;
    const previousGroups = groupHeadings.filter((heading) =>
      Boolean(heading.compareDocumentPosition(row) & 4)
    );
    return cleanText(previousGroups.at(-1)?.textContent || '').toLowerCase() === 'final charges';
  });
  const amounts = finalRows.map((row) => ({
    label: cleanText(row.querySelector('h6')?.textContent || ''),
    cents: parsePaymentAmountCents(getLastCurrencyValue(row.textContent || '')),
  })).filter((entry) => entry.cents !== null);
  // Do not confuse an isolated tip or refund with the tender's complete
  // allocation. There must be an order charge in Final charges; when it is
  // present, summing its final transactions also accounts for edits, tips,
  // and refunds that Walmart posts against that same tender.
  if (!amounts.some((entry) => /^(?:final\s+)?order charge$/i.test(entry.label))) return null;
  return amounts.reduce((sum, entry) => sum + entry.cents, 0);
}

function findPaymentMethodIndexForHistory(label, details, usedIndices, fallbackIndex, sectionCount) {
  const normalizedLabel = normalizeLookupText(label || '').replace(/[^a-z0-9]/g, '');
  const candidates = (Array.isArray(details) ? details : []).map((entry, index) => ({ entry, index }))
    .filter(({ index }) => !usedIndices.has(index))
    .filter(({ entry }) => {
      const brand = normalizeTenderBrand(entry.brand);
      const endingDigits = String(entry.ending || '').match(/\d{4}/)?.[0] || '';
      const brandMatches = brand && normalizedLabel.includes(brand);
      const endingMatches = endingDigits && normalizedLabel.includes(endingDigits);
      return (brandMatches && (!endingDigits || endingMatches)) || endingMatches;
    });
  if (candidates.length === 1) return candidates[0].index;
  return details.length === sectionCount && fallbackIndex < details.length && !usedIndices.has(fallbackIndex)
    ? fallbackIndex
    : -1;
}

/**
 * Read the final Order charge transaction per tender from Walmart's Charge
 * history drawer. Current order pages often omit tender amounts from both
 * payment rows and __NEXT_DATA__, while the drawer still shows them.
 */
async function extractPaymentAmountsFromChargeHistory(paymentMethodDetails) {
  const details = Array.isArray(paymentMethodDetails) ? paymentMethodDetails : [];
  if (!details.length) return details;

  const trigger = Array.from(document.querySelectorAll('button,[role="button"]')).find((button) => {
    const label = `${button.getAttribute('aria-label') || ''} ${button.textContent || ''}`;
    return /charge history/i.test(label) && !/information/i.test(label);
  });
  if (!trigger) return details;

  let dialog = null;
  try {
    trigger.click();
    for (let attempt = 0; attempt < 24; attempt++) {
      dialog = document.querySelector('[role="dialog"]');
      if (dialog?.querySelector('section h3')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!dialog) return details;

    const selectorButtons = Array.from(dialog.querySelectorAll('button[aria-label]'))
      .filter((button) => !/close panel|information|temporary holds|previous|next|slide/i.test(
        button.getAttribute('aria-label') || ''
      ));
    // Selecting each tender once makes Walmart populate its per-method history
    // section. The history remains in the drawer DOM after another tender is
    // selected, so all allocations can then be read without network parsing.
    for (const button of selectorButtons) {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 90));
    }

    const usedIndices = new Set();
    const updated = details.map((entry) => ({ ...entry }));
    const sections = Array.from(dialog.querySelectorAll('section')).filter((section) =>
      /^viewing order charge history of\b/i.test(cleanText(section.querySelector('h3')?.textContent || ''))
    );
    sections.forEach((section, sectionIndex) => {
      const title = cleanText(section.querySelector('h3')?.textContent || '')
        .replace(/^viewing order charge history of\s*/i, '');
      const cents = paymentHistorySectionAmount(section);
      if (cents === null) return;
      const index = findPaymentMethodIndexForHistory(
        title, updated, usedIndices, sectionIndex, sections.length
      );
      if (index < 0) return;
      usedIndices.add(index);
      if (!cleanText(updated[index].amount || '')) {
        updated[index].amount = formatPaymentAmountCents(cents);
        updated[index].amountSource = 'charge-history';
      }
    });
    return updated;
  } catch (error) {
    console.warn('Unable to read Walmart charge history for payment split:', error);
    return details;
  } finally {
    const closeButton = dialog?.querySelector('button[aria-label*="close panel" i]');
    if (closeButton) closeButton.click();
  }
}

function inferSingleTenderAmount(paymentMethodDetails, orderTotal) {
  const details = dedupePaymentMethodDetails(paymentMethodDetails);
  if (details.length !== 1) return details;
  const cents = parsePaymentAmountCents(orderTotal);
  if (cents === null) return details;
  // Charge history can include partial authorizations and later adjustments.
  // The invoice total is the authoritative allocation when only one tender is
  // listed, regardless of the payment brand.
  return [{ ...details[0], amount: formatPaymentAmountCents(cents), amountSource: 'order-total' }];
}

/**
 * Reconcile mixed PayPal tenders against the displayed invoice total.
 * Walmart's charge-history drawer reports PayPal transactions across partial
 * charges, edits, refunds, and sometimes fulfillment groups outside the
 * currently displayed invoice. For a mixed payment, the non-PayPal tenders
 * have explicit allocations in their own history; PayPal is the balancing
 * tender and receives the remaining invoice amount. When several PayPal
 * instruments are present, only infer a value when exactly one allocation is
 * missing. Multiple observed PayPal allocations are left intact unless they
 * already reconcile; transaction-history proportions cannot prove an invoice
 * split. Never infer an allocation if a non-PayPal amount is missing or the
 * known amounts already exceed the total.
 */
function reconcilePayPalTenderAmounts(paymentMethodDetails, orderTotal) {
  const details = dedupePaymentMethodDetails(paymentMethodDetails).map((entry) => ({ ...entry }));
  const totalCents = parsePaymentAmountCents(orderTotal);
  if (details.length < 2 || totalCents === null) return details;

  const paypalIndices = details.map((entry, index) =>
    /paypal/i.test(`${entry.brand || ''} ${entry.ending || ''}`) ? index : -1
  ).filter((index) => index >= 0);
  if (!paypalIndices.length) return details;

  const nonPaypal = details.map((entry, index) => ({ entry, index }))
    .filter(({ index }) => !paypalIndices.includes(index));
  const nonPaypalCents = nonPaypal.map(({ entry }) => parsePaymentAmountCents(entry.amount));
  if (nonPaypalCents.some((amount) => amount === null)) return details;

  const remainingCents = totalCents - nonPaypalCents.reduce((sum, amount) => sum + amount, 0);
  if (remainingCents < 0) return details;

  if (paypalIndices.length === 1) {
    const index = paypalIndices[0];
    details[index] = {
      ...details[index],
      amount: formatPaymentAmountCents(remainingCents),
      amountSource: 'order-total-remainder',
    };
    return details;
  }

  const paypalAmounts = paypalIndices.map((index) => parsePaymentAmountCents(details[index].amount));
  const missingPaypal = paypalAmounts.map((amount, position) => amount === null ? position : -1)
    .filter((position) => position >= 0);
  if (missingPaypal.length === 1) {
    const knownPaypalCents = paypalAmounts.reduce((sum, amount) => sum + (amount === null ? 0 : amount), 0);
    const residual = remainingCents - knownPaypalCents;
    if (residual < 0) return details;
    const index = paypalIndices[missingPaypal[0]];
    details[index] = {
      ...details[index],
      amount: formatPaymentAmountCents(residual),
      amountSource: 'order-total-remainder',
    };
    return details;
  }
  if (paypalAmounts.some((amount) => amount === null || amount < 0)) return details;
  return details;
}

function inferOneMissingTenderAmount(paymentMethodDetails, orderTotal) {
  const details = dedupePaymentMethodDetails(paymentMethodDetails);
  const missingIndices = details.map((entry, index) =>
    cleanText(entry?.amount || '') ? -1 : index
  ).filter((index) => index >= 0);
  if (details.length < 2 || missingIndices.length !== 1 ||
      !details.some((entry) => entry?.amountSource === 'charge-history')) return details;
  const totalCents = parsePaymentAmountCents(orderTotal);
  if (totalCents === null) return details;
  if (details.some((entry, index) => index !== missingIndices[0] && parsePaymentAmountCents(entry.amount) === null)) {
    return details;
  }
  const knownCents = details.reduce((sum, entry, index) => {
    if (index === missingIndices[0]) return sum;
    const cents = parsePaymentAmountCents(entry.amount);
    return cents === null ? sum : sum + cents;
  }, 0);
  if (knownCents > totalCents) return details;
  return details.map((entry, index) => index === missingIndices[0]
    ? { ...entry, amount: formatPaymentAmountCents(totalCents - knownCents), amountSource: 'order-total-remainder' }
    : entry);
}

function scrapeOrderData() {
  const orderItems = [];
  const productLinkLookup = buildProductLinkLookup();
  const nextDataOrder = extractOrderDataFromNextData();

  // Query the hidden print items list which contains reliable product data
  // This list is always present in the DOM (hidden via .dn class) and is populated on page load.
  // It provides a cleaner data structure compared to the complex interactive UI.
  const printItemsList = document.querySelectorAll(SELECTORS.PRINT_ITEMS);

  printItemsList.forEach((item) => {
    const { productName, deliveryStatus, quantity, price } = extractPrintItem(item);
    if (!productName && !quantity && !price) {
      return;
    }

    const productLink = resolveProductLink(productName, productLinkLookup);

    orderItems.push({
      productName,
      productLink,
      deliveryStatus,
      quantity,
      price,
    });
  });
  if (printItemsList.length === 0) orderItems.push(...extractRedesignedInvoiceItems());

  /**
   * Finds order number using fallback selectors.
   * Tries multiple locations where order number might appear.
   */
  function findOrderNumber() {
    const selectors = [
      SELECTORS.ORDER_NUMBER_BAR,
      SELECTORS.ORDER_INFO_CARD,
      SELECTORS.ORDER_NUMBER_HEADING,
      SELECTORS.PRINT_BILL_ID,
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        const text = element.textContent;
        const match = text.match(CONSTANTS.ORDER_NUMBER_REGEX);
        if (match) {
          const normalized = normalizeOrderNumberValue(match[1]);
          if (normalized) {
            return normalized;
          }
        }
      }
    }

    const pathMatch = window.location.pathname.match(/\/orders\/([\d-]+)/);
    if (pathMatch?.[1]) {
      const normalized = normalizeOrderNumberValue(pathMatch[1]);
      if (normalized) {
        return normalized;
      }
    }

    console.log("Order number not found with current selectors");
    return null;
  }

  // Extract order metadata
  const orderNumber = findOrderNumber() || nextDataOrder?.orderNumber || null;
  let orderDate = document.querySelector(SELECTORS.ORDER_DATE)?.innerText || '';
  orderDate = orderDate.replace("order", "").trim();
  if (!orderDate) {
    orderDate = cleanText(nextDataOrder?.orderDate || '');
  }

  // ----- Extract order totals and fee breakdown -----
  const paymentSection = document.querySelector('.print-bill-payment-section') || document;
  const subtotalAfterSavingsNode = findElementByAriaLabel('subtotal after savings', paymentSection);
  let orderSubtotal = getLastCurrencyValue(
    subtotalAfterSavingsNode?.getAttribute('aria-label') || subtotalAfterSavingsNode?.textContent
  );

  // Fallback for layouts that do not expose subtotal-after-savings aria labels.
  if (!orderSubtotal) {
    const subtotalEl = document.querySelector(SELECTORS.ORDER_SUBTOTAL);
    if (subtotalEl) {
      const spans = subtotalEl.querySelectorAll('span');
      if (spans.length > 0) {
        orderSubtotal = cleanText(spans[spans.length - 1].innerText);
      }
      if (!orderSubtotal) {
        orderSubtotal = cleanText(subtotalEl.innerText);
      }
    }
  }

  if (!orderSubtotal && nextDataOrder?.orderSubtotal) {
    orderSubtotal = cleanText(nextDataOrder.orderSubtotal);
  }

  const subtotalBeforeSavingsNode = findElementByAriaLabel('subtotal was', paymentSection);
  let subtotalBeforeSavings = getLastCurrencyValue(
    subtotalBeforeSavingsNode?.getAttribute('aria-label') || subtotalBeforeSavingsNode?.textContent
  );
  if (!subtotalBeforeSavings && nextDataOrder?.subtotalBeforeSavings) {
    subtotalBeforeSavings = cleanText(nextDataOrder.subtotalBeforeSavings);
  }

  let savings = '';
  const savingsNode = findElementByAriaLabel('savings', paymentSection);
  if (savingsNode) {
    const savingsText = savingsNode.getAttribute('aria-label') || savingsNode.textContent || '';
    const savingsAmount = getLastCurrencyValue(savingsText);
    if (savingsAmount) {
      savings = savingsAmount.startsWith('-') ? savingsAmount : `-${savingsAmount.replace(/^-/, '')}`;
    }
  }

  if (!savings) {
    const savingsBadgeText = cleanText(document.querySelector('.bill-order-payment-spacing .Tag_tag__9ThK9')?.textContent || '');
    const savingsAmount = getLastCurrencyValue(savingsBadgeText);
    if (savingsAmount) {
      savings = savingsAmount.startsWith('-') ? savingsAmount : `-${savingsAmount.replace(/^-/, '')}`;
    }
  }

  if (!savings && nextDataOrder?.savings) {
    savings = cleanText(nextDataOrder.savings);
  }

  let orderTotal = '';
  const totalEl = document.querySelector(SELECTORS.ORDER_TOTAL);
  if (totalEl) {
    const spans = totalEl.querySelectorAll('span');
    if (spans.length > 0) {
      orderTotal = cleanText(spans[spans.length - 1].innerText);
    }
    if (!orderTotal) {
      orderTotal = cleanText(totalEl.innerText);
    }
  }

  if (!orderTotal && nextDataOrder?.orderTotal) {
    orderTotal = cleanText(nextDataOrder.orderTotal);
  }

  let feeBreakdown = extractFeeBreakdownFromOrderPage();

  let deliveryCharges = getDeliveryFeeAmount(feeBreakdown) || '$0.00';
  let bagFee = getFeeAmount(feeBreakdown, 'bag fee') || getFeeAmount(feeBreakdown, 'bag') || '$0.00';
  let tax = getFeeAmount(feeBreakdown, 'tax') || '$0.00';

  // Additional fallbacks from screen-reader labels when line-item parsing misses.
  if (!tax || tax === '$0.00') {
    const taxFromLabel = getLastCurrencyValue(
      Array.from(document.querySelectorAll(SELECTORS.FEE_LABEL))
        .map((el) => cleanText(el.textContent))
        .find((text) => normalizeLookupText(text).includes('tax'))
    );
    tax = taxFromLabel || '$0.00';
  }

  if (!bagFee || bagFee === '$0.00') {
    const bagFromLabel = getLastCurrencyValue(
      Array.from(document.querySelectorAll(SELECTORS.FEE_LABEL))
        .map((el) => cleanText(el.textContent))
        .find((text) => normalizeLookupText(text).includes('bag fee'))
    );
    bagFee = bagFromLabel || '$0.00';
  }

  if ((!deliveryCharges || deliveryCharges === '$0.00') && nextDataOrder?.deliveryCharges) {
    deliveryCharges = cleanText(nextDataOrder.deliveryCharges);
  }

  if ((!bagFee || bagFee === '$0.00') && nextDataOrder?.bagFee) {
    bagFee = cleanText(nextDataOrder.bagFee);
  }

  if ((!tax || tax === '$0.00') && nextDataOrder?.tax) {
    tax = cleanText(nextDataOrder.tax);
  }

  // Tip: look for "Driver tip" or "Tip" in a flex justify-between row
  let tip = '$0.00';
  const tipRows = document.querySelectorAll(SELECTORS.TIP + ', .print-bill-payment-section .flex.justify-between');
  for (const row of tipRows) {
    const rowText = cleanText(row.textContent || '');
    if (normalizeLookupText(rowText).includes('tip')) {
      const parsedTip = getLastCurrencyValue(rowText);
      if (parsedTip) {
        tip = parsedTip;
      }
      if (tip !== '$0.00') break;
    }
  }

  if ((!tip || tip === '$0.00') && nextDataOrder?.tip) {
    tip = cleanText(nextDataOrder.tip);
  }

  // Current Walmart pages removed the old bill-order-total-payment/subtotal
  // classes and fee aria labels. Prefer their explicitly labelled live rows.
  const redesignedTotals = extractRedesignedInvoiceTotals();
  orderSubtotal = redesignedTotals.orderSubtotal || orderSubtotal;
  subtotalBeforeSavings = redesignedTotals.subtotalBeforeSavings || subtotalBeforeSavings;
  savings = redesignedTotals.savings || savings;
  orderTotal = redesignedTotals.orderTotal || orderTotal;
  deliveryCharges = redesignedTotals.deliveryCharges || deliveryCharges;
  bagFee = redesignedTotals.bagFee || bagFee;
  tax = redesignedTotals.tax || tax;
  tip = redesignedTotals.tip || tip;

  const paymentMethodDetails = mergePaymentMethodDetails(
    extractPaymentDetailsFromOrderPage(),
    nextDataOrder?.paymentMethodDetails
  );

  const paymentMethods = paymentMethodDetails
    .map((method) => [method.brand, method.ending].filter(Boolean).join(' - '))
    .filter(Boolean);
  let paymentMessages = Array.from(new Set(
    paymentMethodDetails.map((method) => method.message).filter(Boolean)
  ));
  if (paymentMessages.length === 0 && nextDataOrder?.paymentMessages) {
    paymentMessages = cleanText(nextDataOrder.paymentMessages)
      .split(';')
      .map((value) => cleanText(value))
      .filter(Boolean);
  }

  let addressDetails = extractAddressDetailsFromOrderPage();
  if (!addressDetails.address && (nextDataOrder?.address || nextDataOrder?.addressRecipient)) {
    addressDetails = {
      recipient: cleanText(nextDataOrder?.addressRecipient || ''),
      line: cleanText(nextDataOrder?.addressLine || nextDataOrder?.address || ''),
      address: cleanText(nextDataOrder?.address || ''),
    };
  }

  const address =
    addressDetails.address ||
    cleanText(nextDataOrder?.address || '') ||
    extractAddressFromOrderPage();

  let { instructions: deliveryInstructions, expanded: deliveryInstructionsExpanded } =
    extractDeliveryInstructionsFromOrderPage();
  if (!deliveryInstructions && nextDataOrder?.deliveryInstructions) {
    deliveryInstructions = cleanText(nextDataOrder.deliveryInstructions);
  }

  const items = mergeOrderItems(orderItems, nextDataOrder?.items || []);
  const financialFields = mergeFinancialAdjustments(
    extractFinancialAdjustments(feeBreakdown),
    redesignedTotals,
    nextDataOrder
  );
  const resolvedOrderNumber = orderNumber || nextDataOrder?.orderNumber || null;
  const resolvedOrderDate = orderDate || cleanText(nextDataOrder?.orderDate || '');

  return {
    schemaVersion: CONSTANTS.ORDER_SCHEMA_VERSION,
    walmartExtractionVersion: CONSTANTS.WALMART_US_EXTRACTION_VERSION,
    orderNumber: resolvedOrderNumber,
    orderDate: resolvedOrderDate,
    orderType: cleanText(nextDataOrder?.orderType || ''),
    isInStore: Boolean(nextDataOrder?.isInStore),
    orderSubtotal,
    subtotalBeforeSavings,
    savings,
    orderTotal,
    deliveryCharges,
    bagFee,
    tax,
    tip,
    promoCodeAmount: financialFields.promoCodeAmount,
    threeHoursOrLessFee: financialFields.threeHoursOrLessFee,
    returnedThreeHoursOrLessFee: financialFields.returnedThreeHoursOrLessFee,
    refund: financialFields.refund,
    financialAdjustments: financialFields.financialAdjustments,
    donations: financialFields.donations,
    barcodeImageUrl: cleanText(nextDataOrder?.barcodeImageUrl || ''),
    sellers: cleanText(nextDataOrder?.sellers || ''),
    fulfillmentTypes: cleanText(nextDataOrder?.fulfillmentTypes || ''),
    deliveredDate: cleanText(nextDataOrder?.deliveredDate || ''),
    trackingNumbers: cleanText(nextDataOrder?.trackingNumbers || ''),
    paymentSplit: buildPaymentSplit(paymentMethodDetails),
    address,
    addressRecipient: addressDetails.recipient,
    addressLine: addressDetails.line,
    deliveryInstructions,
    deliveryInstructionsExpanded,
    paymentMethods: paymentMethods.join('; ') || cleanText(nextDataOrder?.paymentMethods || ''),
    paymentMethodDetails,
    paymentMessages: paymentMessages.join('; '),
    items,
    ...(nextDataOrder?.noChargedItems === true && items.length === 0 ? { noChargedItems: true } : {}),
  };
}

/**
 * Validates a scraped order-detail data object and returns human-readable
 * warnings for fields that came back empty — a tripwire signal that Walmart
 * may have changed their DOM or payload structure.
 * Cheap and non-throwing by design: validation must NEVER break extraction.
 * @param {object} data - Order data assembled by scrapeOrderData().
 * @returns {string[]} Warning messages (empty array when data looks healthy).
 */
function computeExtractionWarnings(data) {
  const warnings = [];

  try {
    const items = Array.isArray(data?.items) ? data.items : [];

    if (items.length === 0 && data?.noChargedItems === true) {
      // Fully canceled: Walmart charged no lines, so there is nothing to read.
    } else if (items.length === 0) {
      warnings.push("No items were extracted for this order");
    } else if (items.every((item) => !cleanText(item?.productName || ""))) {
      warnings.push("All extracted items have a blank product name");
    }

    if (!cleanText(data?.orderTotal || "")) {
      warnings.push("Order total came back empty");
    }

    // A line price wildly above the order's own total means the price
    // extraction grabbed the wrong text (seen with legacy DOM scraping).
    const totalValue = Number(String(data?.orderTotal || "").replace(/[^0-9.-]+/g, "")) || 0;
    if (totalValue > 0) {
      const implausible = items.some((item) => {
        const price = Number(String(item?.price || "").replace(/[^0-9.-]+/g, "")) || 0;
        return price > totalValue * 2;
      });
      if (implausible) {
        warnings.push("An item price exceeds the order total — price extraction looks wrong");
      }
    }

    if (!data?.orderNumber) {
      warnings.push("Order number is missing");
    }

    // Any missing split allocation is actionable: the live scraper checks
    // payment rows, Next.js payloads, and Walmart's charge-history drawer
    // before warning, so a partial split must not be presented as complete.
    const paymentMethods = Array.isArray(data?.paymentMethodDetails)
      ? data.paymentMethodDetails
      : [];
    const missingPaymentAmounts = paymentMethods.filter((method) => !cleanText(method?.amount || '')).length;
    if (paymentMethods.length > 1 && missingPaymentAmounts > 0) {
      warnings.push(
        `Split tender across ${paymentMethods.length} payment methods, but ` +
          `${missingPaymentAmounts} per-tender amount${missingPaymentAmounts === 1 ? ' was' : 's were'} ` +
          'unavailable after checking the order page and charge history'
      );
    } else if (paymentMethods.length > 1 && cleanText(data?.orderTotal) &&
      paymentMethods.some((method) => method?.amountSource === 'charge-history')) {
      const tenderCents = paymentMethods.map((method) => parsePaymentAmountCents(method?.amount));
      const orderCents = parsePaymentAmountCents(data?.orderTotal);
      if (orderCents !== null && tenderCents.every((amount) => amount !== null)) {
        const splitCents = tenderCents.reduce((sum, amount) => sum + amount, 0);
        if (splitCents !== orderCents) {
          warnings.push(
            `Payment split totals ${formatPaymentAmountCents(splitCents)}, which does not match ` +
              `the order total ${formatPaymentAmountCents(orderCents)}`
          );
        }
      }
    }
  } catch (error) {
    // Validation is best-effort; never let it interfere with extraction.
    console.warn("Extraction validation failed (ignored):", error);
  }

  return warnings;
}

function extractOrderNumberFromText(text) {
  if (!text) return null;

  // A card can contain unrelated long identifiers (tracking references,
  // fulfillment IDs, etc.). Only accept a number tied to an explicit order
  // label or hash marker; treating the first long digit run as an order ID
  // corrupts both the CSV's order number and the neighboring date/status
  // fields on cards whose layout differs from the standard one (#22).
  const match = String(text).match(/(?:\border(?:\s*(?:number|no\.?))?\s*[:#]?\s*|#\s*)([\d][\d-]{9,})/i);
  return match?.[1] || null;
}

function getOrderCardTitle(card) {
  const titleSelectors = [
    "h2",
    "h3",
    "[data-testid*='title']",
    "[class*='title']",
    "button[data-automation-id^='view-order-details-link-']",
  ];

  for (const selector of titleSelectors) {
    const element = card.querySelector(selector);
    const text = element?.textContent?.trim();
    if (text) {
      return text;
    }
  }

  return card.textContent?.trim() || "";
}

function extractOrderNumberFromButton(button, fallbackContainer = null) {
  const automationId = button?.getAttribute?.("data-automation-id") || "";
  const automationMatch = automationId.match(/view-order-details-link-([\d-]+)/);
  if (automationMatch?.[1]) {
    return automationMatch[1];
  }

  const buttonText = button?.textContent?.trim();
  const buttonFallback = extractOrderNumberFromText(buttonText);
  if (buttonFallback) {
    return buttonFallback;
  }

  if (fallbackContainer) {
    return extractOrderNumberFromText(fallbackContainer.textContent || "");
  }

  return null;
}

/**
 * Handles order number collection from order history page.
 * Waits for page elements to load, then extracts order data.
 */
async function handleCollectOrderNumbers(request = {}) {
  const currentPage = Number(request.currentPage || 1);

  try {
    // Page 1 can use server-hydrated HTML payload; later pages should rely on
    // network snapshots or updated DOM after pagination.
    const readinessSelectors = currentPage <= 1
      ? [
          'script#__NEXT_DATA__',
          SELECTORS.ORDER_CARDS,
          'button[data-automation-id^="view-order-details-link-"]',
          SELECTORS.MAIN_HEADING,
        ]
      : [
          SELECTORS.ORDER_CARDS,
          'button[data-automation-id^="view-order-details-link-"]',
          SELECTORS.MAIN_HEADING,
        ];

    await waitForAnyElement(readinessSelectors);

    // The REQUEST payload is authoritative and fully dated. Page 1 is
    // server-rendered into __NEXT_DATA__; page 2+ comes from the page's OWN
    // pagination request, captured by the main-world bridge as you (or the
    // crawl) click "Next". We deliberately do NOT fire our own API request
    // here — a self-made request is exactly what Walmart can bot-challenge (and
    // could flag your session). If the page's own request wasn't captured in
    // time, we fall back to the DOM. Give the capture a moment to arrive.
    const snapshotDeadline = Date.now() + (currentPage <= 1 ? 6000 : 8000);
    let sourceSnapshot = PurchaseHistoryDataSource.getBestSnapshot({ currentPage });
    while (!sourceSnapshot && Date.now() < snapshotDeadline) {
      await delay(300);
      sourceSnapshot = PurchaseHistoryDataSource.getBestSnapshot({ currentPage });
    }

    if (sourceSnapshot) {
      console.log(
        `Collected ${sourceSnapshot.orderNumbers.length} order numbers from ${sourceSnapshot.source} on page ${currentPage}. Has next page: ${sourceSnapshot.hasNextPage}`
      );
      return {
        orderNumbers: sourceSnapshot.orderNumbers,
        additionalFields: sourceSnapshot.additionalFields,
        orderSummaries: sourceSnapshot.orderSummaries || {},
        hasNextPage: sourceSnapshot.hasNextPage,
      };
    }

    // Genuine last resort: no payload anywhere (offline API + no capture).
    // Order numbers still come through so the crawl isn't lost, but this is
    // the only path that can lack dates — and it should be rare.
    const { orderNumbers, additionalFields, orderSummaries } = extractOrderNumbers();
    const hasNextPage = await checkForNextPage();
    console.warn(
      `Payload unavailable for page ${currentPage}; fell back to DOM scraping (${orderNumbers.length} orders, dates may be missing).`
    );
    return { orderNumbers, additionalFields, orderSummaries: orderSummaries || {}, hasNextPage };
  } catch (error) {
    console.error("Error during collection:", error);
    // Selector timeouts mean the orders list truly is not on this page
    // (empty history) — report end-of-orders. Anything else is an ERROR the
    // background must retry, never a successful empty page.
    if (
      error.message.includes("not found after") ||
      error.message.includes("None of the selectors matched")
    ) {
      console.log("No order cards found. Assuming end of orders.");
      return { orderNumbers: [], additionalFields: {}, orderSummaries: {}, hasNextPage: false, endOfOrders: true };
    }
    return { orderNumbers: [], additionalFields: {}, orderSummaries: {}, hasNextPage: false, collectionError: true };
  }
}

/**
 * Handles pagination by clicking the next page button.
 * @returns {Object} Success status of the click operation
 */
async function handleClickNextButton() {
  try {
    await waitForAnyElement([
      SELECTORS.NEXT_BUTTON,
      'button[aria-label*="Next"]',
      'button[data-automation-id*="next-pages-button"]',
    ]);

    const nextButton = findNextPageButton();
    if (!nextButton) {
      console.warn("Next page button not found or is disabled");
      return { success: false };
    }

    const previousSignature = getOrderListSignature();
    const previousUrl = window.location.href;
    const previousSnapshotTimestamp = PurchaseHistoryDataSource.getLatestSnapshotTimestamp();

    nextButton.scrollIntoView({ block: "center", inline: "center" });
    nextButton.click();

    const pageChanged = await waitForOrdersListTransition(
      previousSignature,
      previousUrl,
      previousSnapshotTimestamp
    );
    if (!pageChanged) {
      console.warn("Next page click did not trigger a visible page transition");
      return { success: false };
    }

    return { success: true };
  } catch (error) {
    console.error("Error clicking next button:", error);
    return { success: false };
  }
}

function isButtonDisabled(button) {
  if (!button) return true;
  return (
    button.disabled ||
    button.hasAttribute("disabled") ||
    button.getAttribute("aria-disabled") === "true"
  );
}

function isElementVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findNextPageButton() {
  const selectors = [
    SELECTORS.NEXT_BUTTON,
    'button[data-automation-id="next-pages-button"]',
    'button[data-automation-id*="next-pages-button"]',
    'button[aria-label*="Next page"]',
    'button[aria-label*="Next"]',
  ];

  for (const selector of selectors) {
    const buttons = Array.from(document.querySelectorAll(selector));
    const candidate = buttons.find((button) => !isButtonDisabled(button) && isElementVisible(button));
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function getOrderListSignature() {
  const detailButtonIds = Array.from(
    document.querySelectorAll('button[data-automation-id^="view-order-details-link-"]')
  )
    .slice(0, 3)
    .map((button) => button.getAttribute("data-automation-id"))
    .filter(Boolean);

  if (detailButtonIds.length > 0) {
    return detailButtonIds.join("|");
  }

  const cards = Array.from(document.querySelectorAll(SELECTORS.ORDER_CARDS)).slice(0, 2);
  const fallback = cards
    .map((card) => {
      const keyNode = card.querySelector("[id^='caption-'], h2, h3");
      const text = keyNode?.textContent || card.textContent || "";
      return text.replace(/\s+/g, " ").trim().slice(0, 120);
    })
    .filter(Boolean);

  return fallback.join("|");
}

async function waitForOrdersListTransition(
  previousSignature,
  previousUrl,
  previousSnapshotTimestamp = 0,
  timeout = CONSTANTS.TIMING.COLLECTION_TIMEOUT,
  pollInterval = CONSTANTS.TIMING.ELEMENT_POLL_INTERVAL
) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const latestSnapshotTimestamp = PurchaseHistoryDataSource.getLatestSnapshotTimestamp();
    const currentUrl = window.location.href;
    const currentSignature = getOrderListSignature();

    if (latestSnapshotTimestamp > previousSnapshotTimestamp) {
      return true;
    }

    if (currentUrl !== previousUrl) {
      return true;
    }

    if (currentSignature && previousSignature && currentSignature !== previousSignature) {
      return true;
    }

    if (currentSignature && !previousSignature) {
      return true;
    }

    await delay(pollInterval);
  }

  return false;
}

/**
 * Single-pass order extraction using efficient DOM traversal.
 * Queries order cards once, then finds child elements within each card.
 * @returns {Object} Object containing orderNumbers array and additionalFields map
 */
/**
 * Best-effort Quick Export summary scraped from an order card's visible text.
 * The payload path is far richer; this keeps Quick Export usable (date, total,
 * item count, status) even when a page had to be collected from the DOM.
 * @param {Element} card - The order card element
 * @param {string} orderNumber - Digits-only order number
 * @returns {Object} Summary object shaped like buildOrderSummary's output
 */
function buildDomOrderSummary(card, orderNumber, title = '') {
  const cardText = cleanText(card?.textContent || '');

  // Only trust a date found in the card TITLE (usually "July 1, 2026 order");
  // the card body carries delivery/arrival dates (some WITH a year, e.g. a
  // "Delivery estimate Jul 15, 2026") that are NOT the order date — a wrong
  // date sorts worse than a blank one. The reliable order date past page 1
  // comes from the network payload (classic) or the direct API (Fast Collect),
  // not the DOM.
  const dateMatch = cleanText(title).match(/\b([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})\b/);
  const totalMatch =
    cardText.match(/(\$[\d,]+(?:\.\d{2})?)\s*total/i) ||
    cardText.match(/total[^$]{0,20}(\$[\d,]+(?:\.\d{2})?)/i);
  const itemCountMatch = cardText.match(/\b(\d+)\s+items?\b/i);

  const statusKeywords = [
    'Out for delivery', 'Delivered', 'Canceled', 'Cancelled', 'Shipped',
    'Arrives', 'Picked up', 'Ready for pickup', 'Returned', 'Refunded', 'In progress',
  ];
  const lowerText = cardText.toLowerCase();
  const status = statusKeywords.find((keyword) => lowerText.includes(keyword.toLowerCase())) || '';

  return {
    source: 'dom',
    orderNumber,
    orderDate: dateMatch ? dateMatch[1] : '',
    itemCount: itemCountMatch ? Number(itemCountMatch[1]) : '',
    orderTotal: totalMatch ? cleanText(totalMatch[1]) : '',
    subTotal: '',
    driverTip: '',
    status,
    fulfillmentTypes: '',
    orderType: '',
    isInStore: false,
    items: [],
  };
}

function extractOrderNumbers() {
  const orderNumbers = [];
  const additionalFields = {};
  const orderSummaries = {};
  const seenOrderNumbers = new Set();

  // Prefer the current card wrapper, but fall back to the order details button
  // when Walmart reshuffles the surrounding DOM structure.
  const orderCards = Array.from(document.querySelectorAll(SELECTORS.ORDER_CARDS));
  const detailButtons = Array.from(
    document.querySelectorAll('button[data-automation-id^="view-order-details-link-"]')
  );

  const cardSources = orderCards.length > 0
    ? orderCards
    : detailButtons.map((button) => button.closest('[data-testid^="order-"], article, section, li, div') || button);

  if (cardSources.length === 0) {
    console.warn("No order cards or order detail buttons found on the page");
    return { orderNumbers, additionalFields, orderSummaries };
  }

  // Single-pass traversal: query within each card to avoid redundant global queries
  cardSources.forEach((card, index) => {
    try {
      const button = card.querySelector('button[data-automation-id^="view-order-details-link-"]')
        || (card.matches?.('button[data-automation-id^="view-order-details-link-"]') ? card : null)
        || detailButtons[index]
        || null;
      const title = getOrderCardTitle(card);
      const orderNumber = extractOrderNumberFromButton(button, card);

      if (orderNumber && !seenOrderNumbers.has(orderNumber)) {
        seenOrderNumbers.add(orderNumber);
        orderNumbers.push(orderNumber);
        additionalFields[orderNumber] = title;
        orderSummaries[orderNumber] = buildDomOrderSummary(card, orderNumber, title);
      }
    } catch (e) {
      console.error(`Error processing order card ${index}:`, e);
    }
  });

  return { orderNumbers, additionalFields, orderSummaries };
}

/**
 * Checks if a next page button exists for pagination.
 * @returns {boolean} True if more pages are available
 */
async function checkForNextPage() {
  try {
    return !!findNextPageButton();
  } catch (error) {
    console.error("Error checking for next page:", error);
    return false;
  }
}

  // ==========================================================================
  // Interface methods (see providers/base.js). `ctx` is built by content.js.
  // ==========================================================================

  /**
   * Prime the page snapshot cache and install the in-page fetch/XHR bridge.
   * Must be called once on content-script load, in the page context.
   * @param {ProviderContentCtx} ctx
   */
  function initContent(ctx) {
    PurchaseHistoryDataSource.initialize();
  }

  /**
   * Collect the order numbers (and Quick Export summaries) for one list page.
   * @param {ProviderContentCtx} ctx - carries ctx.currentPage (1-based)
   * @returns {Promise<{orderNumbers:string[], additionalFields:Object,
   *   orderSummaries:Object, hasNextPage:boolean, endOfOrders?:boolean,
   *   collectionError?:boolean}>}
   */
  async function collectOrderNumbers(ctx) {
    return handleCollectOrderNumbers({ currentPage: (ctx && ctx.currentPage) || 1 });
  }

  /**
   * Scrape one order-detail page into the normalized order shape consumed by
   * the export code. Includes a best-effort `extractionWarnings` array.
   * @param {ProviderContentCtx} ctx
   * @returns {Object} normalized order
   */
  async function scrapeOrder(ctx) {
    const data = scrapeOrderData();
    if (data.paymentMethodDetails.length > 0) {
      if (data.paymentMethodDetails.some((method) => !cleanText(method?.amount || ''))) {
        data.paymentMethodDetails = await extractPaymentAmountsFromChargeHistory(data.paymentMethodDetails);
        const containsPayPal = data.paymentMethodDetails.some((method) =>
          /paypal/i.test(`${method.brand || ''} ${method.ending || ''}`)
        );
        if (!containsPayPal) {
          data.paymentMethodDetails = inferOneMissingTenderAmount(data.paymentMethodDetails, data.orderTotal);
        }
      }
      data.paymentMethodDetails = inferSingleTenderAmount(data.paymentMethodDetails, data.orderTotal);
      data.paymentMethodDetails = reconcilePayPalTenderAmounts(data.paymentMethodDetails, data.orderTotal);
      data.paymentMethods = data.paymentMethodDetails
        .map((method) => [method.brand, method.ending].filter(Boolean).join(' - '))
        .filter(Boolean)
        .join('; ') || data.paymentMethods;
      data.paymentSplit = buildPaymentSplit(data.paymentMethodDetails);
    }
    data.extractionWarnings = computeExtractionWarnings(data);
    return data;
  }

  /**
   * Fast invoice: build one order's full invoice by fetching its detail HTML
   * directly (via the main-world bridge) and parsing its __NEXT_DATA__ order
   * node — no tab navigation. Returns the same normalized shape as scrapeOrder,
   * or null if the order couldn't be fetched (caller falls back to opening the
   * order page). Used only when the fast setting is on.
   * @param {ProviderContentCtx & {orderNumber?: string}} ctx
   * @returns {Promise<Object|null>}
   */
  async function scrapeOrderById(ctx) {
    const orderNumber = String((ctx && ctx.orderNumber) || "").replace(/[^\d]/g, "");
    if (!orderNumber) return null;
    const orderNode = await PurchaseHistoryDataSource.fetchOrderNodeViaMainWorld(orderNumber);
    if (!orderNode) return null;
    const data = extractOrderDataFromNextData(orderNode);
    if (!data) return null;
    if (data.paymentMethodDetails.length > 1 &&
      data.paymentMethodDetails.some((method) => !cleanText(method?.amount || ''))) {
      // The lightweight HTML path has no DOM for Walmart's charge-history
      // drawer. Fall back to the order page, where per-tender transactions can
      // be read interactively instead of returning an incomplete split.
      return null;
    }
    data.paymentMethodDetails = inferSingleTenderAmount(data.paymentMethodDetails, data.orderTotal);
    data.paymentMethodDetails = reconcilePayPalTenderAmounts(data.paymentMethodDetails, data.orderTotal);
    data.paymentMethods = data.paymentMethodDetails
      .map((method) => [method.brand, method.ending].filter(Boolean).join(' - '))
      .filter(Boolean)
      .join('; ') || data.paymentMethods;
    data.paymentSplit = buildPaymentSplit(data.paymentMethodDetails);
    data.extractionWarnings = computeExtractionWarnings(data);
    return data;
  }

  /**
   * Advance the list to the next page (Walmart paginates by clicking "next").
   * @param {ProviderContentCtx} ctx
   * @returns {Promise<{success:boolean}>}
   */
  async function clickNextPage(ctx) {
    return handleClickNextButton();
  }

  /**
   * Optional Fast Collect entry point (used only when the `fastFetch` setting
   * is on). Collects the WHOLE history in one call via direct in-page fetch of
   * Walmart's own PurchaseHistoryV3 endpoint. Returns the merged result, or
   * { fallbackToClassic: true } to tell the background loop to run the normal
   * click-through crawl instead.
   * @param {ProviderContentCtx} ctx - carries ctx.pageLimit (0 = all)
   */
  async function collectAllFast(ctx) {
    return PurchaseHistoryDataSource.collectAllViaFetch({
      pageLimit: Number((ctx && ctx.pageLimit) || 0),
      incremental: Boolean(ctx && ctx.incremental),
      knownOrderNumbers: (ctx && ctx.knownOrderNumbers) || [],
    });
  }

  // Test-only visibility: before the multi-provider refactor these helpers
  // lived at content.js top level (i.e. were globals), and the unit-test
  // sandbox still reaches them by bare name. Re-expose them ONLY when the
  // test harness (tests/helpers/sandbox.js) has set __WIE_TEST_SANDBOX__ —
  // the real content-script / service-worker / side-panel runtimes never set
  // it, so they see zero new globals and behavior is byte-for-byte identical.
  if (typeof globalThis !== 'undefined' && globalThis.__WIE_TEST_SANDBOX__ === true) {
    Object.assign(globalThis, {
      extractOrderDataFromNextData,
      scrapeOrderData,
      readPaymentRowAmount,
      mergeOrderItems,
      extractPrintItem,
      extractOrderNumberFromText,
      extractOrderNumberFromButton,
      computeExtractionWarnings,
      formatOrderDateFromIsoString,
      buildPaymentSplit,
      mergePaymentMethodDetails,
      inferSingleTenderAmount,
      inferOneMissingTenderAmount,
      reconcilePayPalTenderAmounts,
      extractPaymentAmountsFromChargeHistory,
      buildTenderLabel,
      buildDomOrderSummary,
      PurchaseHistoryDataSource,
    });
  }

  return {
    id: 'WALMART_US',
    label: 'Walmart.com',
    flag: 'provider.walmart_us',
    defaultEnabled: true,
    hostPermissions: ['https://www.walmart.com/*'],
    contentMatches: ['https://www.walmart.com/orders*'],
    ordersListUrl: 'https://www.walmart.com/orders',
    locale: 'en-US',
    currency: 'USD',
    // Fast Collect (direct in-page API replay) is available for this provider;
    // it runs only when the user turns on the `fastFetch` setting.
    supportsFastFetch: true,
    SELECTORS,
    isOrdersListUrl,
    initContent,
    collectOrderNumbers,
    scrapeOrder,
    scrapeOrderById,
    clickNextPage,
    collectAllFast,
    readPaymentRowAmount,
    buildTenderLabel,
    extractItemsFromNextData,
    mergeOrderItems,
    computeExtractionWarnings,
    // Fast invoice fetching (HTML-fetch + __NEXT_DATA__ parse, no tab per order)
    // is available for this provider; used only when the fast setting is on.
    supportsFastInvoice: true,
  };
})();

// Register with the shared registry. registry.js loads before this file in
// every context (importScripts order + content_scripts order + script tags),
// so ProviderRegistry is defined; the guard is a belt-and-suspenders no-op.
if (typeof ProviderRegistry !== 'undefined' && ProviderRegistry.register) {
  ProviderRegistry.register(WalmartUsProvider);
}
