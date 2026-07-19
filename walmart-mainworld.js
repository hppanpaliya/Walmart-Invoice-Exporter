/**
 * walmart-mainworld.js — MAIN-world capture bridge (Walmart.com / Walmart.ca).
 *
 * Declared in manifest content_scripts with "world": "MAIN" and
 * "run_at": "document_start", so the browser injects it into the PAGE's own
 * JavaScript world BEFORE any of Walmart's scripts run. That timing is the
 * whole point: it wraps window.fetch / XMLHttpRequest first, so it sees every
 * PurchaseHistoryV3 response the page fetches as you paginate — including the
 * exact order dates — and relays them (via window.postMessage) to the
 * extension's isolated-world content script (providers/walmart-us.js).
 *
 * Why main-world instead of the old inline-injected bridge:
 *   - Guaranteed to run at document_start (no injection-timing race where the
 *     page has already captured its own fetch reference).
 *   - It reads only what the page ITSELF requests while you browse/paginate —
 *     Walmart does not challenge its own requests, so the dates come through
 *     reliably. We never fabricate or replay a request here.
 *   - No new permissions: "world": "MAIN" is declarative, not chrome.scripting;
 *     no webRequest, no token capture, nothing sent off-device.
 *
 * This file must stay dependency-free and side-effect-only (it runs in the
 * page's global scope). The SOURCE/TYPE strings MUST match the constants in
 * providers/walmart-us.js's PurchaseHistoryDataSource.
 */
(() => {
  "use strict";

  const SOURCE = "WIE_PURCHASE_HISTORY_BRIDGE";
  const TYPE = "PURCHASE_HISTORY_SNAPSHOT";
  // Fast Collect replay protocol (isolated world ⇄ this main-world script).
  const REPLAY_REQ = "WIE_REPLAY_REQUEST";
  const REPLAY_RES = "WIE_REPLAY_RESULT";
  // Fast invoice protocol: fetch an order-detail page's HTML in the page's own
  // world and return its __NEXT_DATA__ order node (the full invoice), so the
  // panel can build invoices without opening a tab per order.
  const ORDER_REQ = "WIE_FETCH_ORDER";
  const ORDER_RES = "WIE_FETCH_ORDER_RESULT";

  // Guard against double-install (e.g. SPA soft-navigations re-running scripts).
  if (window.__wiePurchaseHistoryBridgeInstalled) return;
  window.__wiePurchaseHistoryBridgeInstalled = true;

  // The full header set from the page's OWN most recent PurchaseHistoryV3
  // request. This is the piece Fast Collect needs: Walmart's bot detection
  // accepts the page's real, sensor-signed headers but 429-challenges a request
  // built from synthesized headers. We reuse EXACTLY what the page just sent.
  let lastRequestHeaders = null;

  const captureHeaders = (input, init) => {
    const headers = {};
    try {
      if (
        input &&
        typeof input === "object" &&
        input.headers &&
        typeof input.headers.entries === "function"
      ) {
        for (const [k, v] of input.headers.entries()) headers[k] = v;
      }
      const ih = init && init.headers;
      if (ih) {
        if (typeof ih.entries === "function") {
          for (const [k, v] of ih.entries()) headers[k] = v;
        } else if (Array.isArray(ih)) {
          ih.forEach((pair) => {
            if (pair && pair.length === 2) headers[pair[0]] = pair[1];
          });
        } else {
          Object.assign(headers, ih);
        }
      }
    } catch (_) {}
    return headers;
  };

  const extractPurchaseHistoryNode = (payload) => {
    if (!payload || typeof payload !== "object") return null;
    return (
      payload.purchaseHistory ||
      (payload.data && payload.data.purchaseHistory) ||
      (payload.props &&
        payload.props.pageProps &&
        payload.props.pageProps.phRedesignInitialData &&
        payload.props.pageProps.phRedesignInitialData.data &&
        payload.props.pageProps.phRedesignInitialData.data.purchaseHistory) ||
      (payload.pageProps &&
        payload.pageProps.phRedesignInitialData &&
        payload.pageProps.phRedesignInitialData.data &&
        payload.pageProps.phRedesignInitialData.data.purchaseHistory) ||
      null
    );
  };

  const emit = (purchaseHistory, requestUrl) => {
    if (
      !purchaseHistory ||
      !Array.isArray(purchaseHistory.orders) ||
      purchaseHistory.orders.length === 0
    ) {
      return;
    }
    window.postMessage(
      {
        source: SOURCE,
        type: TYPE,
        requestUrl: requestUrl || "",
        payload: {
          purchaseHistory: {
            orders: purchaseHistory.orders,
            pageInfo: purchaseHistory.pageInfo || null,
          },
        },
      },
      "*"
    );
  };

  const handlePayload = (payload, requestUrl) => {
    const purchaseHistory = extractPurchaseHistoryNode(payload);
    if (purchaseHistory) emit(purchaseHistory, requestUrl);
  };

  const maybeParseJsonText = (text, requestUrl) => {
    if (!text || typeof text !== "string") return;
    if (text.indexOf("purchaseHistory") === -1) return;
    try {
      handlePayload(JSON.parse(text), requestUrl);
    } catch (_) {
      // Not a JSON payload we care about.
    }
  };

  const urlOf = (input) => {
    try {
      if (typeof input === "string") return input;
      if (input && typeof input.url === "string") return input.url;
    } catch (_) {}
    return "";
  };

  const patchFetch = () => {
    if (typeof window.fetch !== "function" || window.fetch.__wiePurchaseHistoryWrapped) {
      return;
    }
    const originalFetch = window.fetch.bind(window);
    const wrappedFetch = (...args) => {
      const requestUrl = urlOf(args[0]);
      // Remember the real headers of the page's own PurchaseHistoryV3 request,
      // so Fast Collect can replay later pages with the SAME (accepted) headers.
      if (requestUrl.indexOf("PurchaseHistoryV3") > -1) {
        const captured = captureHeaders(args[0], args[1]);
        if (captured && Object.keys(captured).length) lastRequestHeaders = captured;
      }
      return originalFetch(...args).then((response) => {
        try {
          response
            .clone()
            .text()
            .then((t) => maybeParseJsonText(t, requestUrl))
            .catch(() => {});
        } catch (_) {}
        return response;
      });
    };
    wrappedFetch.__wiePurchaseHistoryWrapped = true;
    window.fetch = wrappedFetch;
  };

  const patchXHR = () => {
    if (XMLHttpRequest.prototype.__wiePurchaseHistoryWrapped) return;

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        this.__wieRequestUrl = url;
      } catch (_) {}
      return originalOpen.call(this, method, url, ...rest);
    };

    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      const self = this;
      this.addEventListener(
        "load",
        function () {
          try {
            if (self.responseType && self.responseType !== "" && self.responseType !== "text") {
              return;
            }
            maybeParseJsonText(self.responseText, self.__wieRequestUrl || "");
          } catch (_) {}
        },
        { once: true }
      );
      return originalSend.apply(this, args);
    };

    XMLHttpRequest.prototype.__wiePurchaseHistoryWrapped = true;
  };

  patchFetch();
  patchXHR();

  // Fast Collect replay proxy. The isolated-world adapter asks us to fetch a
  // purchase-history page; we run the request HERE, in the page's own world,
  // reusing the real captured headers — so it is indistinguishable from the
  // page's own request and passes Walmart's bot check (a synthesized request
  // gets 429-challenged). We post the raw JSON payload back. We never fabricate
  // a request the page didn't already prove it can make: without captured
  // headers we decline (the caller then seeds by triggering one real request).
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== SOURCE || !msg.reqId) return;

    // --- Fast Collect: replay a purchase-history GraphQL page ---
    if (msg.type === REPLAY_REQ) {
      const reply = (body) =>
        window.postMessage({ source: SOURCE, type: REPLAY_RES, reqId: msg.reqId, ...body }, "*");
      if (!lastRequestHeaders) {
        reply({ ok: false, reason: "no-headers" });
        return;
      }
      if (!msg.url || typeof msg.url !== "string" || msg.url.indexOf("/orchestra/") !== 0) {
        reply({ ok: false, reason: "bad-url" });
        return;
      }
      fetch(msg.url, { credentials: "include", headers: lastRequestHeaders })
        .then(async (r) => {
          let payload = null;
          if (r.ok) {
            try {
              payload = await r.json();
            } catch (_) {}
          }
          reply({ ok: r.ok, status: r.status, payload });
        })
        .catch((err) => reply({ ok: false, reason: String(err && err.message) }));
      return;
    }

    // --- Fast invoice: fetch one order's detail HTML, return its order node ---
    if (msg.type === ORDER_REQ) {
      const reply = (body) =>
        window.postMessage({ source: SOURCE, type: ORDER_RES, reqId: msg.reqId, ...body }, "*");
      const orderNumber = String(msg.orderNumber || "").replace(/[^\d]/g, "");
      if (!orderNumber) {
        reply({ ok: false, reason: "bad-order" });
        return;
      }
      fetch(`/orders/${orderNumber}`, { credentials: "include", headers: { accept: "text/html" } })
        .then(async (r) => {
          if (!r.ok) {
            reply({ ok: false, status: r.status });
            return;
          }
          const html = await r.text();
          const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
          if (!m) {
            reply({ ok: false, reason: "no-next-data", status: r.status });
            return;
          }
          let order = null;
          try {
            const nd = JSON.parse(m[1]);
            const pp = nd && nd.props && nd.props.pageProps;
            order =
              (pp && pp.initialData && pp.initialData.data && pp.initialData.data.order) ||
              (pp && pp.order) ||
              null;
          } catch (_) {}
          if (!order) {
            reply({ ok: false, reason: "no-order-node", status: r.status });
            return;
          }
          reply({ ok: true, status: r.status, order });
        })
        .catch((err) => reply({ ok: false, reason: String(err && err.message) }));
      return;
    }
  });
})();
