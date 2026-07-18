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

  // Guard against double-install (e.g. SPA soft-navigations re-running scripts).
  if (window.__wiePurchaseHistoryBridgeInstalled) return;
  window.__wiePurchaseHistoryBridgeInstalled = true;

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
})();
