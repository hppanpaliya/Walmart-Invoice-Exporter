/**
 * providers/samsclub.js — Sam's Club (SAMSCLUB) provider adapter.
 *
 * ###########################################################################
 * ##  REFERENCE-ONLY / UNVERIFIED  ##########################################
 * ###########################################################################
 * This adapter was reverse-engineered from the OrderPro bundle
 * (`SamsClubProvider`) and the docs/recon-findings.md "Sam's Club — REFERENCE
 * ONLY" section. NONE of it has been exercised against a live Sam's Club
 * account. Every endpoint, persisted-query hash, header, request-variable
 * shape, and response field path below is "last known" and MUST be re-confirmed
 * against a live session before this provider is enabled. See the
 * `REVERIFY` markers throughout and the checklist in the accompanying notes.
 *
 * Because nothing is confirmed, the code is written defensively: every field
 * access is guarded, every network step is wrapped, and extraction emits
 * generous `extractionWarnings` so a mis-mapped field surfaces loudly instead
 * of silently producing blank/garbage rows.
 *
 * Sam's Club is in the Walmart "Orchestra" GraphQL family (same in-page model
 * as providers/walmart-us.js). Two things differ from Walmart:
 *   1. AUTH — Sam's uses a *client-readable* bearer token (`authToken`, read
 *      from a JS store such as localStorage) sent in an `authorization` header,
 *      on top of the cookie session. An in-page fetch can attach it directly,
 *      so NO webRequest capture is needed.
 *   2. DATA SOURCE — it is the most app-like of the family; order data is NOT
 *      reliably in __NEXT_DATA__. We fetch the Orchestra GraphQL endpoints
 *      (PurchaseHistoryV2 for the list, getOrder for detail) from page context,
 *      reusing the same fetch/XHR-patch bridge technique walmart-us.js uses —
 *      here the bridge's job is to (a) observe the page's OWN PurchaseHistoryV2
 *      request so we can lift the persisted-query <queryHash>, the request
 *      header set, and the exact `variables` template, and (b) opportunistically
 *      cache getOrder responses the page itself fetches.
 *
 * Loadable and safe at load time in all three contexts (service worker via
 * importScripts, content script, side panel). Nothing here touches the DOM or
 * the network at module load — the fetch engine only runs when a content
 * method (initContent / collectOrderNumbers / scrapeOrder / clickNextPage) is
 * invoked, which only ever happens inside a samsclub.com page.
 *
 * Depends (like walmart-us.js) on globals from utils.js loaded first:
 * `CONSTANTS` (ORDER_SCHEMA_VERSION, TIMING) and `delay(ms)`.
 */
const SamsClubProvider = (() => {
  "use strict";

  // ==========================================================================
  // Config — REVERIFY the host, paths, and header constants against a live acct.
  // ==========================================================================
  const ORIGIN = "https://www.samsclub.com";
  // REVERIFY: CA uses samsclub.ca + `/en/orders` + `x-o-bu: SAMS-CA`. This
  // adapter targets US only; a CA variant would be a sibling adapter.
  const ORDERS_LIST_URL = `${ORIGIN}/orders`;

  // REVERIFY: Orchestra GraphQL base paths (list vs. detail live on different
  // sub-services per recon). Hashes are appended at request time.
  const LIST_PATH = "/orchestra/cph/graphql/PurchaseHistoryV2/"; // + <queryHash>
  const DETAIL_PATH = "/orchestra/orders/graphql/getOrder/";      // + <hash>

  // REVERIFY: the static Orchestra header set. `authorization`,
  // `device_profile_ref_id`, and `x-o-gql-query` are lifted live from the
  // page's own request (see the bridge); the rest are believed constant.
  const STATIC_HEADERS_LIST = {
    "x-apollo-operation-name": "PurchaseHistoryV2",
    "x-o-bu": "SAMS-US",
    "x-o-mart": "B2C",
    "x-o-platform": "rweb",
    "x-o-segment": "oaoh",
  };
  const STATIC_HEADERS_DETAIL = {
    "x-apollo-operation-name": "getOrder",
    "x-o-bu": "SAMS-US",
    "x-o-mart": "B2C",
    "x-o-platform": "rweb",
    "x-o-segment": "oaoh",
  };

  // Pace network requests so a full crawl does not hammer the endpoint.
  const REQUEST_PACING_MS = 600;
  const CAPTURE_TIMEOUT_MS = 12000; // how long to wait for the bridge to lift
                                    // the queryHash + auth from the page.

  // ==========================================================================
  // Small shared helpers (safe in any context).
  // ==========================================================================
  function cleanText(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function normalizeOrderNumber(value) {
    // Sam's order ids can exceed 17 chars and are not always pure digits; keep
    // alnum. REVERIFY: confirm whether ids are digits-only or alphanumeric.
    return String(value == null ? "" : value).replace(/[^A-Za-z0-9]/g, "");
  }

  function num(value) {
    const n = Number(String(value == null ? "" : value).replace(/[^0-9.-]+/g, ""));
    return Number.isFinite(n) ? n : 0;
  }

  function toCurrency(value) {
    if (value == null || value === "") return "";
    if (typeof value === "string") return cleanText(value);
    const n = Number(value);
    return Number.isFinite(n) ? `$${n.toFixed(2)}` : cleanText(value);
  }

  function safe(fn, fallback) {
    try {
      const v = fn();
      return v == null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }

  /** The orders LIST page — an order-detail URL like /orders/123 must be false. */
  function isOrdersListUrl(url) {
    // REVERIFY: confirm the exact list path (US `/orders`, CA `/en/orders`).
    return /^https:\/\/www\.samsclub\.com\/(?:en\/)?orders\/?($|\?)/i.test(
      String(url || "")
    );
  }

  function orderIdFromDetailUrl(url) {
    const m = String(url || "").match(/\/orders\/([^/?#]+)/i);
    return m && m[1] ? decodeURIComponent(m[1]) : "";
  }

  // ==========================================================================
  // In-page bridge — captures the persisted-query hash, the live auth/device
  // headers, and page-fetched getOrder responses. Mirrors the walmart-us.js
  // fetch/XHR-patch technique. Runs ONLY inside a samsclub.com page.
  // ==========================================================================
  const OrchestraBridge = (() => {
    const MESSAGE_SOURCE = "WIE_SAMS_ORCHESTRA_BRIDGE";
    const TYPE_META = "SAMS_ORCHESTRA_META";     // hash + headers + list variables
    const TYPE_DETAIL = "SAMS_ORCHESTRA_DETAIL"; // a getOrder response
    const TYPE_LIST = "SAMS_ORCHESTRA_LIST";     // a PurchaseHistoryV2 response

    // Captured session material (from the page's own requests / storage).
    let listQueryHash = null;      // persisted-query hash for PurchaseHistoryV2
    let capturedHeaders = null;    // { authorization, device_profile_ref_id, x-o-gql-query, ... }
    let listVariablesTemplate = null; // the exact `variables` object the page used
    let latestListResponse = null; // { payload, timestamp }
    const detailByOrderId = new Map(); // orderId -> { payload, timestamp }
    let listenerAttached = false;

    function updateMeta(meta) {
      if (!meta || typeof meta !== "object") return;
      if (meta.listQueryHash) listQueryHash = meta.listQueryHash;
      if (meta.headers && typeof meta.headers === "object") {
        capturedHeaders = { ...(capturedHeaders || {}), ...meta.headers };
      }
      if (meta.listVariables && typeof meta.listVariables === "object") {
        listVariablesTemplate = meta.listVariables;
      }
    }

    function handleBridgeMessage(event) {
      if (event.source !== window) return;
      const message = event.data;
      if (!message || message.source !== MESSAGE_SOURCE) return;

      if (message.type === TYPE_META) {
        updateMeta(message.meta);
        return;
      }
      if (message.type === TYPE_LIST && message.payload) {
        latestListResponse = { payload: message.payload, timestamp: Date.now() };
        return;
      }
      if (message.type === TYPE_DETAIL && message.payload) {
        const id = normalizeOrderNumber(message.orderId || "");
        if (id) detailByOrderId.set(id, { payload: message.payload, timestamp: Date.now() });
      }
    }

    function attachListener() {
      if (listenerAttached) return;
      window.addEventListener("message", handleBridgeMessage);
      listenerAttached = true;
    }

    function injectPageScript() {
      if (
        !document.documentElement ||
        document.documentElement.dataset.wieSamsBridgeInjected === "true"
      ) {
        return;
      }
      document.documentElement.dataset.wieSamsBridgeInjected = "true";

      const script = document.createElement("script");
      script.setAttribute("data-wie-bridge", "sams-orchestra");
      script.textContent = `(() => {
        const SOURCE = ${JSON.stringify(MESSAGE_SOURCE)};
        const TYPE_META = ${JSON.stringify(TYPE_META)};
        const TYPE_DETAIL = ${JSON.stringify(TYPE_DETAIL)};
        const TYPE_LIST = ${JSON.stringify(TYPE_LIST)};
        // REVERIFY: these substrings identify the Orchestra requests in-page.
        const LIST_MARK = "PurchaseHistoryV2";
        const DETAIL_MARK = "getOrder";

        if (window.__wieSamsOrchestraBridgeInstalled) return;
        window.__wieSamsOrchestraBridgeInstalled = true;

        const post = (msg) => { try { window.postMessage(Object.assign({ source: SOURCE }, msg), "*"); } catch (_) {} };

        // Best-effort direct read of the client bearer token from a JS store.
        // REVERIFY: the exact storage key/shape holding \`authToken\`.
        const readAuthTokenFromStore = () => {
          try {
            const direct = window.localStorage.getItem("authToken");
            if (direct) return direct;
            for (let i = 0; i < window.localStorage.length; i++) {
              const k = window.localStorage.key(i);
              if (!k) continue;
              if (/auth.?token|bearer|access.?token/i.test(k)) {
                const v = window.localStorage.getItem(k);
                if (v && v.length > 20) return v;
              }
            }
          } catch (_) {}
          return null;
        };

        const headerObjToPlain = (headers) => {
          const out = {};
          try {
            if (!headers) return out;
            if (typeof headers.forEach === "function" && !Array.isArray(headers)) {
              headers.forEach((val, key) => { out[String(key).toLowerCase()] = val; });
            } else if (Array.isArray(headers)) {
              headers.forEach((pair) => { if (pair && pair.length === 2) out[String(pair[0]).toLowerCase()] = pair[1]; });
            } else if (typeof headers === "object") {
              Object.keys(headers).forEach((k) => { out[k.toLowerCase()] = headers[k]; });
            }
          } catch (_) {}
          return out;
        };

        const hashFromUrl = (url) => {
          try {
            // .../PurchaseHistoryV2/<hash>?variables=...
            const m = String(url).match(/PurchaseHistoryV2\\/([^/?#]+)/);
            return m && m[1] ? m[1] : null;
          } catch (_) { return null; }
        };

        const variablesFromUrl = (url) => {
          try {
            const u = new URL(url, window.location.origin);
            const raw = u.searchParams.get("variables");
            if (!raw) return null;
            return JSON.parse(raw);
          } catch (_) { return null; }
        };

        const orderIdFromDetailUrl = (url) => {
          try {
            const vars = variablesFromUrl(url);
            if (vars && vars.orderId) return String(vars.orderId);
          } catch (_) {}
          return null;
        };

        const captureRequestMeta = (url, init, requestObj) => {
          try {
            const s = String(url);
            if (s.indexOf(LIST_MARK) === -1) return;
            const hdrs = headerObjToPlain(
              (init && init.headers) || (requestObj && requestObj.headers) || null
            );
            const meta = { headers: {} };
            // Keep only the live/opaque headers we can't hardcode.
            ["authorization", "device_profile_ref_id", "x-o-gql-query"].forEach((k) => {
              if (hdrs[k]) meta.headers[k] = hdrs[k];
            });
            if (!meta.headers.authorization) {
              const tok = readAuthTokenFromStore();
              if (tok) meta.headers.authorization = tok;
            }
            const h = hashFromUrl(s);
            if (h) meta.listQueryHash = h;
            const v = variablesFromUrl(s);
            if (v) meta.listVariables = v;
            post({ type: TYPE_META, meta: meta });
          } catch (_) {}
        };

        const maybeEmitResponseText = (url, text) => {
          if (!text || typeof text !== "string") return;
          const s = String(url);
          try {
            if (s.indexOf(LIST_MARK) !== -1) {
              post({ type: TYPE_LIST, payload: JSON.parse(text) });
            } else if (s.indexOf(DETAIL_MARK) !== -1) {
              post({ type: TYPE_DETAIL, orderId: orderIdFromDetailUrl(s), payload: JSON.parse(text) });
            }
          } catch (_) {}
        };

        // Patch fetch.
        if (typeof window.fetch === "function" && !window.fetch.__wieSamsWrapped) {
          const orig = window.fetch.bind(window);
          const wrapped = (input, init) => {
            let url = typeof input === "string" ? input : (input && input.url) || "";
            captureRequestMeta(url, init, typeof input === "object" ? input : null);
            return orig(input, init).then((response) => {
              try {
                const cloned = response.clone();
                cloned.text().then((t) => maybeEmitResponseText(url, t)).catch(() => {});
              } catch (_) {}
              return response;
            });
          };
          wrapped.__wieSamsWrapped = true;
          window.fetch = wrapped;
        }

        // Patch XHR.
        if (!XMLHttpRequest.prototype.__wieSamsWrapped) {
          const origOpen = XMLHttpRequest.prototype.open;
          const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
          const origSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function (method, url) {
            this.__wieUrl = url;
            this.__wieHeaders = {};
            return origOpen.apply(this, arguments);
          };
          XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
            try { (this.__wieHeaders = this.__wieHeaders || {})[String(k).toLowerCase()] = v; } catch (_) {}
            return origSetHeader.apply(this, arguments);
          };
          XMLHttpRequest.prototype.send = function () {
            try { captureRequestMeta(this.__wieUrl, { headers: this.__wieHeaders }, null); } catch (_) {}
            this.addEventListener("load", function () {
              try {
                if (this.responseType && this.responseType !== "" && this.responseType !== "text") return;
                maybeEmitResponseText(this.__wieUrl, this.responseText);
              } catch (_) {}
            }, { once: true });
            return origSend.apply(this, arguments);
          };
          XMLHttpRequest.prototype.__wieSamsWrapped = true;
        }

        // Eagerly try to surface the token so collectOrderNumbers has auth even
        // before the page issues its own PurchaseHistoryV2 request.
        const tok = readAuthTokenFromStore();
        if (tok) post({ type: TYPE_META, meta: { headers: { authorization: tok } } });
      })();`;

      (document.head || document.documentElement).appendChild(script);
      script.remove();
    }

    function initialize() {
      attachListener();
      injectPageScript();
    }

    async function waitForSession(timeoutMs = CAPTURE_TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (listQueryHash && capturedHeaders && capturedHeaders.authorization) {
          return true;
        }
        await delay(300);
      }
      return Boolean(listQueryHash && capturedHeaders && capturedHeaders.authorization);
    }

    return {
      initialize,
      waitForSession,
      getListQueryHash: () => listQueryHash,
      getHeaders: () => (capturedHeaders ? { ...capturedHeaders } : null),
      getListVariablesTemplate: () => (listVariablesTemplate ? { ...listVariablesTemplate } : null),
      getLatestListResponse: () => latestListResponse,
      getDetailForOrder: (orderId) => detailByOrderId.get(normalizeOrderNumber(orderId)) || null,
    };
  })();

  // ==========================================================================
  // List (PurchaseHistoryV2) — one page per collectOrderNumbers() call.
  // Pagination state is keyed by page number; background drives currentPage and
  // clickNextPage(), so we only advance a cursor when a page is fetched.
  // ==========================================================================

  // page number -> cursor/token to fetch THAT page. Page 1 needs no cursor.
  const cursorByPage = new Map();
  let listExhausted = false;

  function extractPurchaseHistoryNode(payload) {
    // REVERIFY: the exact response envelope for PurchaseHistoryV2.
    return safe(
      () =>
        payload.data.purchaseHistoryV2 ||
        payload.data.purchaseHistory ||
        payload.purchaseHistoryV2 ||
        payload.purchaseHistory ||
        null,
      null
    );
  }

  function extractOrdersArray(historyNode) {
    return safe(
      () =>
        (Array.isArray(historyNode.orders) && historyNode.orders) ||
        (Array.isArray(historyNode.results) && historyNode.results) ||
        (Array.isArray(historyNode.orderList) && historyNode.orderList) ||
        [],
      []
    );
  }

  function extractNextCursor(historyNode) {
    // REVERIFY: pagination shape (cursor vs. page-number vs. hasMore flag).
    return safe(
      () =>
        historyNode.pageInfo?.nextPageCursor ||
        historyNode.pageInfo?.endCursor ||
        historyNode.nextCursor ||
        (historyNode.pageInfo?.hasNextPage ? "__HAS_NEXT__" : null) ||
        null,
      null
    );
  }

  function buildListVariables(pageNumber) {
    // Start from the exact template the page used, then overlay pagination so
    // we don't guess unknown required fields. REVERIFY the pagination keys.
    const template = OrchestraBridge.getListVariablesTemplate() || {};
    const vars = { ...template };
    const cursor = cursorByPage.get(pageNumber) || null;

    // Try the common Orchestra pagination shapes; harmless extras are ignored
    // server-side, and the template already carries whatever is truly required.
    if (cursor && cursor !== "__HAS_NEXT__") {
      vars.cursor = cursor;
      vars.pageCursor = cursor;
    }
    if (typeof vars.pageNumber === "number" || "pageNumber" in template) {
      vars.pageNumber = pageNumber;
    }
    if (typeof vars.page === "number" || "page" in template) {
      vars.page = pageNumber;
    }
    return vars;
  }

  function buildOrderSummary(order, normalizedOrderNumber) {
    // REVERIFY every path below against a live PurchaseHistoryV2 order node.
    const groups = safe(() => (Array.isArray(order.groups) ? order.groups : []), []);
    const trackingNumbers = [];
    const fulfillmentTypes = [];
    groups.forEach((g) => {
      const tn = cleanText(safe(() => g.shipment.trackingNumber, ""));
      if (tn && !trackingNumbers.includes(tn)) trackingNumbers.push(tn);
      const ft = cleanText(safe(() => g.fulfillmentType || g.type, ""));
      if (ft && !fulfillmentTypes.includes(ft)) fulfillmentTypes.push(ft);
    });

    return {
      source: "payload",
      orderNumber: normalizedOrderNumber,
      orderDate: cleanText(safe(() => order.orderDate || order.deliveredDate, "")),
      orderType: cleanText(safe(() => order.type, "")),
      isInStore:
        safe(() => order.type === "IN_STORE", false) ||
        String(normalizedOrderNumber).length > 17,
      itemCount: safe(() => order.itemCount, ""),
      orderTotal: cleanText(safe(() => order.priceDetails.grandTotal.displayValue, "")),
      subTotal: cleanText(safe(() => order.priceDetails.subTotal.displayValue, "")),
      driverTip: "",
      status: cleanText(safe(() => order.status.statusType, "")),
      fulfillmentTypes: fulfillmentTypes.join(", "),
      trackingNumbers: trackingNumbers.join("; "),
      items: [],
    };
  }

  function buildListPageResult(payload, warnings) {
    const historyNode = extractPurchaseHistoryNode(payload);
    if (!historyNode) {
      warnings.push("PurchaseHistoryV2 response did not contain a recognizable history node (REVERIFY envelope)");
      return null;
    }
    const orders = extractOrdersArray(historyNode);
    if (orders.length === 0) {
      return { orderNumbers: [], additionalFields: {}, orderSummaries: {}, hasNextPage: false, endOfOrders: true };
    }

    const orderNumbers = [];
    const additionalFields = {};
    const orderSummaries = {};
    const seen = new Set();

    orders.forEach((order) => {
      const raw = safe(() => order.orderId || order.id, "");
      const normalized = normalizeOrderNumber(raw);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      orderNumbers.push(normalized);
      additionalFields[normalized] = cleanText(
        safe(() => order.orderDate || order.deliveredDate || order.status.statusType, "")
      );
      orderSummaries[normalized] = buildOrderSummary(order, normalized);
    });

    const nextCursor = extractNextCursor(historyNode);
    return {
      orderNumbers,
      additionalFields,
      orderSummaries,
      hasNextPage: Boolean(nextCursor),
      nextCursor,
    };
  }

  async function fetchListPage(pageNumber, warnings) {
    const hash = OrchestraBridge.getListQueryHash();
    const headers = OrchestraBridge.getHeaders();
    if (!hash || !headers || !headers.authorization) {
      warnings.push("Missing captured queryHash or authToken — cannot fetch PurchaseHistoryV2 (REVERIFY bridge capture)");
      return null;
    }

    const variables = buildListVariables(pageNumber);
    const url = `${ORIGIN}${LIST_PATH}${encodeURIComponent(hash)}?variables=${encodeURIComponent(
      JSON.stringify(variables)
    )}`;

    const requestHeaders = { ...STATIC_HEADERS_LIST };
    if (headers.authorization) requestHeaders["authorization"] = headers.authorization;
    if (headers["device_profile_ref_id"]) requestHeaders["device_profile_ref_id"] = headers["device_profile_ref_id"];
    if (headers["x-o-gql-query"]) requestHeaders["x-o-gql-query"] = headers["x-o-gql-query"];

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: requestHeaders,
        credentials: "include", // cookie session rides along with the bearer token
      });
      if (!response.ok) {
        warnings.push(`PurchaseHistoryV2 returned HTTP ${response.status} (REVERIFY endpoint/headers)`);
        return null;
      }
      return await response.json();
    } catch (error) {
      warnings.push(`PurchaseHistoryV2 fetch failed: ${cleanText(error && error.message)}`);
      return null;
    }
  }

  async function handleCollectOrderNumbers(currentPage) {
    const warnings = [];
    try {
      if (listExhausted) {
        return emptyCollectResult(true);
      }

      const ready = await OrchestraBridge.waitForSession();
      if (!ready) {
        // Could not lift session material — a transient/setup failure the
        // background loop should retry, NOT a genuine end-of-orders.
        return { ...emptyCollectResult(false), collectionError: true };
      }

      let payload = await fetchListPage(currentPage, warnings);

      // Fallback: if our own fetch failed but the page already fetched page 1,
      // reuse its captured response so page 1 is not lost.
      if (!payload && currentPage <= 1) {
        const cached = OrchestraBridge.getLatestListResponse();
        if (cached) payload = cached.payload;
      }

      if (!payload) {
        return { ...emptyCollectResult(false), collectionError: true };
      }

      await delay(REQUEST_PACING_MS);

      const result = buildListPageResult(payload, warnings);
      if (!result) {
        return { ...emptyCollectResult(false), collectionError: true };
      }
      if (result.endOfOrders) {
        listExhausted = true;
        return emptyCollectResult(true);
      }

      // Remember the cursor so clickNextPage()/the next collect can advance.
      if (result.hasNextPage && result.nextCursor) {
        cursorByPage.set(currentPage + 1, result.nextCursor);
      } else {
        listExhausted = true;
      }

      if (warnings.length) {
        console.warn("Sam's Club (REFERENCE-ONLY) list warnings:", warnings);
      }

      return {
        orderNumbers: result.orderNumbers,
        additionalFields: result.additionalFields,
        orderSummaries: result.orderSummaries,
        hasNextPage: Boolean(result.hasNextPage),
      };
    } catch (error) {
      console.error("Sam's Club collectOrderNumbers failed:", error);
      return { ...emptyCollectResult(false), collectionError: true };
    }
  }

  function emptyCollectResult(endOfOrders) {
    return {
      orderNumbers: [],
      additionalFields: {},
      orderSummaries: {},
      hasNextPage: false,
      endOfOrders: Boolean(endOfOrders),
    };
  }

  // ==========================================================================
  // Detail (getOrder) — scrape one order into the normalized order shape.
  // ==========================================================================

  function extractOrderNode(payload) {
    // REVERIFY: the exact getOrder response envelope.
    return safe(
      () => payload.data.getOrder || payload.data.order || payload.getOrder || payload.order || null,
      null
    );
  }

  function mapStatus(statusType) {
    // REVERIFY status vocabulary. Provided as guidance from recon.
    const s = cleanText(statusType).toUpperCase();
    if (s === "DELIVERED") return "Delivered";
    if (s === "CANCELED" || s === "CANCELLED") return "Canceled";
    if (s === "RETURN_COMPLETED") return "Refunded";
    if (s === "IN_STORE" || s === "PICKED_UP") return "Picked up";
    if (["PREPARING", "PLACED", "ON_THE_WAY", "DELAYED"].includes(s)) return cleanText(statusType);
    return cleanText(statusType);
  }

  function extractItems(orderNode) {
    // Items are grouped under groups[].categories[].items[] per recon.
    const items = [];
    const seen = new Set();
    const groups = safe(() => (Array.isArray(orderNode.groups) ? orderNode.groups : []), []);

    const pushItem = (item, groupStatus) => {
      const productName = cleanText(safe(() => item.productInfo.name || item.name, ""));
      const usItemId = cleanText(safe(() => item.productInfo.usItemId, ""));
      const quantity = safe(
        () => (item.quantity === 0 || item.quantity ? String(item.quantity) : ""),
        ""
      );
      // price = priceInfo.linePrice.value; discount = strikethroughPrice.value
      const price = toCurrency(safe(() => item.priceInfo.linePrice.value, ""));
      const originalPrice = toCurrency(safe(() => item.priceInfo.strikethroughPrice.value, ""));
      const thumbnailUrl = cleanText(safe(() => item.productInfo.imageInfo.thumbnailUrl, ""));

      if (!productName && !quantity && !price) return;
      const key = `${productName.toLowerCase()}|${quantity}|${price}`;
      if (seen.has(key)) return;
      seen.add(key);

      items.push({
        productName,
        productLink: usItemId ? `${ORIGIN}/ip/${usItemId}` : "N/A",
        deliveryStatus: cleanText(groupStatus) || "",
        quantity,
        price,
        originalPrice,
        thumbnailUrl,
        usItemId,
      });
    };

    groups.forEach((group) => {
      const groupStatus = mapStatus(safe(() => group.status.statusType, ""));
      const categories = safe(() => (Array.isArray(group.categories) ? group.categories : []), []);
      categories.forEach((category) => {
        const catItems = safe(() => (Array.isArray(category.items) ? category.items : []), []);
        catItems.forEach((item) => pushItem(item, groupStatus));
      });
      // Fallback: some nodes may carry items directly on the group.
      if (categories.length === 0) {
        const direct = safe(() => (Array.isArray(group.items) ? group.items : []), []);
        direct.forEach((item) => pushItem(item, groupStatus));
      }
    });

    return items;
  }

  function extractShipment(orderNode) {
    const groups = safe(() => (Array.isArray(orderNode.groups) ? orderNode.groups : []), []);
    const trackingNumbers = [];
    const trackingUrls = [];
    const fulfillmentTypes = [];
    const deliveredDates = [];
    groups.forEach((g) => {
      const tn = cleanText(safe(() => g.shipment.trackingNumber, ""));
      if (tn && !trackingNumbers.includes(tn)) trackingNumbers.push(tn);
      const tu = cleanText(safe(() => g.shipment.trackingUrl, ""));
      if (tu && !trackingUrls.includes(tu)) trackingUrls.push(tu);
      const ft = cleanText(safe(() => g.fulfillmentType || g.type, ""));
      if (ft && !fulfillmentTypes.includes(ft)) fulfillmentTypes.push(ft);
      const dd = cleanText(safe(() => g.deliveredDate || g.deliveryDate, ""));
      if (dd && !deliveredDates.includes(dd)) deliveredDates.push(dd);
    });
    return {
      trackingNumbers: trackingNumbers.join("; "),
      trackingUrls: trackingUrls.join("; "),
      fulfillmentTypes: fulfillmentTypes.join(", "),
      deliveredDate: deliveredDates.join("; "),
    };
  }

  function mapOrderNode(orderNode) {
    const priceDetails = safe(() => orderNode.priceDetails, {}) || {};
    const orderNumber = normalizeOrderNumber(safe(() => orderNode.orderId || orderNode.id, ""));
    const shipment = extractShipment(orderNode);
    const items = extractItems(orderNode);
    const statusType = cleanText(safe(() => orderNode.status.statusType, ""));

    return {
      schemaVersion: safe(() => CONSTANTS.ORDER_SCHEMA_VERSION, 3),
      orderNumber,
      orderDate: cleanText(safe(() => orderNode.orderDate || orderNode.deliveredDate, "")),
      orderType: cleanText(safe(() => orderNode.type, "")),
      isInStore: safe(() => orderNode.type === "IN_STORE", false) || String(orderNumber).length > 17,
      // Payment-summary labels per recon: Subtotal, Shipping, Tax, Savings,
      // discount (coupon), Total (grand total), Refund. REVERIFY each path.
      orderSubtotal: cleanText(safe(() => priceDetails.subTotal.displayValue, "")),
      subtotalBeforeSavings: cleanText(safe(() => priceDetails.strikethroughSubTotal.displayValue, "")),
      savings: cleanText(
        safe(() => priceDetails.savings.displayValue || priceDetails.promotion.displayValue, "")
      ),
      orderTotal: cleanText(safe(() => priceDetails.grandTotal.displayValue, "")),
      deliveryCharges: cleanText(safe(() => priceDetails.shipping.displayValue, "")),
      bagFee: "",
      tax: cleanText(safe(() => priceDetails.tax.displayValue || priceDetails.taxTotal.displayValue, "")),
      tip: "",
      refund: cleanText(safe(() => priceDetails.refund.displayValue, "")),
      donations: "",
      barcodeImageUrl: "",
      sellers: "",
      fulfillmentTypes: shipment.fulfillmentTypes,
      deliveredDate: shipment.deliveredDate,
      trackingNumbers: shipment.trackingNumbers,
      trackingUrls: shipment.trackingUrls,
      paymentSplit: "",
      address: "",
      addressRecipient: "",
      addressLine: "",
      deliveryInstructions: "",
      deliveryInstructionsExpanded: false,
      paymentMethods: "",
      paymentMethodDetails: [],
      paymentMessages: "",
      status: mapStatus(statusType),
      items,
    };
  }

  function computeExtractionWarnings(data, extra) {
    const warnings = Array.isArray(extra) ? [...extra] : [];
    // Standing reminder that this whole provider is unconfirmed.
    warnings.push("Sam's Club provider is REFERENCE-ONLY / unverified — confirm every field against a live account");
    try {
      const items = Array.isArray(data && data.items) ? data.items : [];
      if (!data || !data.orderNumber) warnings.push("Order number is missing");
      if (items.length === 0) warnings.push("No items were extracted for this order");
      else if (items.every((i) => !cleanText(i && i.productName))) {
        warnings.push("All extracted items have a blank product name");
      }
      if (!cleanText(data && data.orderTotal)) warnings.push("Order total came back empty");
      if (!cleanText(data && data.orderDate)) warnings.push("Order date came back empty");

      const totalValue = num(data && data.orderTotal);
      if (totalValue > 0) {
        const implausible = items.some((i) => num(i && i.price) > totalValue * 2);
        if (implausible) warnings.push("An item price exceeds the order total — price mapping looks wrong");
      }
    } catch (error) {
      console.warn("Sam's Club validation failed (ignored):", error);
    }
    return warnings;
  }

  async function fetchOrderDetail(orderId, isInStore, warnings) {
    const headers = OrchestraBridge.getHeaders();
    // getOrder lives on a different sub-service; it does NOT need the list
    // persisted-query hash, but DOES need the same auth headers. REVERIFY
    // whether getOrder also uses a persisted-query hash in the path.
    const hash = ""; // REVERIFY: getOrder persisted-query hash source.
    if (!headers || !headers.authorization) {
      warnings.push("Missing authToken — cannot fetch getOrder (REVERIFY auth capture)");
      return null;
    }

    const variables = {
      orderId: orderId,
      orderIsInStore: Boolean(isInStore),
      clickThroughGroupId: "",
      enableIsWcpOrder: true,
    };
    const url = `${ORIGIN}${DETAIL_PATH}${encodeURIComponent(hash)}?variables=${encodeURIComponent(
      JSON.stringify(variables)
    )}`;

    const requestHeaders = { ...STATIC_HEADERS_DETAIL };
    requestHeaders["authorization"] = headers.authorization;
    if (headers["device_profile_ref_id"]) requestHeaders["device_profile_ref_id"] = headers["device_profile_ref_id"];
    if (headers["x-o-gql-query"]) requestHeaders["x-o-gql-query"] = headers["x-o-gql-query"];

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: requestHeaders,
        credentials: "include",
      });
      if (!response.ok) {
        warnings.push(`getOrder returned HTTP ${response.status} (REVERIFY endpoint/hash/headers)`);
        return null;
      }
      return await response.json();
    } catch (error) {
      warnings.push(`getOrder fetch failed: ${cleanText(error && error.message)}`);
      return null;
    }
  }

  async function handleScrapeOrder(ctx) {
    const warnings = [];
    const loc = (ctx && ctx.location) || (typeof location !== "undefined" ? location : null);
    const orderId = orderIdFromDetailUrl(loc && loc.href);

    if (!orderId) {
      warnings.push("Could not read order id from the detail URL");
    }

    // Prefer a getOrder response the page itself already fetched (captured by
    // the bridge) — avoids an extra round trip and matches page fidelity.
    let payload = null;
    const cached = orderId ? OrchestraBridge.getDetailForOrder(orderId) : null;
    if (cached) {
      payload = cached.payload;
    } else if (orderId) {
      await OrchestraBridge.waitForSession();
      payload = await fetchOrderDetail(orderId, String(orderId).length > 17, warnings);
      await delay(REQUEST_PACING_MS);
    }

    let data;
    if (payload) {
      const orderNode = extractOrderNode(payload);
      if (orderNode) {
        data = mapOrderNode(orderNode);
      } else {
        warnings.push("getOrder response had no recognizable order node (REVERIFY envelope)");
      }
    }

    if (!data) {
      data = {
        schemaVersion: safe(() => CONSTANTS.ORDER_SCHEMA_VERSION, 3),
        orderNumber: normalizeOrderNumber(orderId) || null,
        orderDate: "",
        orderTotal: "",
        items: [],
      };
    }

    data.extractionWarnings = computeExtractionWarnings(data, warnings);
    return data;
  }

  // ==========================================================================
  // Interface methods (see providers/base.js). `ctx` is built by content.js.
  // ==========================================================================

  function initContent(ctx) {
    OrchestraBridge.initialize();
  }

  async function collectOrderNumbers(ctx) {
    return handleCollectOrderNumbers((ctx && ctx.currentPage) || 1);
  }

  /**
   * NOTE: returns a Promise because a Sam's order detail requires a getOrder
   * fetch (there is no reliable __NEXT_DATA__ payload). base.js permits
   * scrapeOrder to return `Promise<Object>`; the shared content.js GET_ORDER_DATA
   * handler must AWAIT it (see integration notes — Wave-1 content.js currently
   * assumes Walmart's synchronous scrapeOrder).
   */
  function scrapeOrder(ctx) {
    return handleScrapeOrder(ctx);
  }

  /**
   * Fetch-based pagination: no DOM to click. The next page's cursor was stored
   * by the preceding collectOrderNumbers() call. Resolve success when another
   * page is known to follow.
   */
  async function clickNextPage(ctx) {
    if (listExhausted) return { success: false };
    const current = (ctx && ctx.currentPage) || 1;
    // A cursor for current+1 means collectOrderNumbers saw a next page.
    return { success: cursorByPage.has(current + 1) };
  }

  return {
    id: "SAMSCLUB",
    label: "Sam's Club",
    flag: "provider.samsclub",
    defaultEnabled: false,
    hostPermissions: ["https://www.samsclub.com/*"],
    contentMatches: ["https://www.samsclub.com/orders*"],
    ordersListUrl: ORDERS_LIST_URL,
    locale: "en-US",
    currency: "USD",
    isOrdersListUrl,
    initContent,
    collectOrderNumbers,
    scrapeOrder,
    clickNextPage,
  };
})();

// Register with the shared registry (guarded — registry.js loads first in every
// context, so this is belt-and-suspenders).
if (typeof ProviderRegistry !== "undefined" && ProviderRegistry.register) {
  ProviderRegistry.register(SamsClubProvider);
}
