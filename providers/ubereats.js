/**
 * providers/ubereats.js — Uber Eats (UBEREATS) provider adapter.
 *
 * A wave-2, FETCH-BASED provider. Unlike the Walmart adapter (which scrapes the
 * server-rendered order-detail DOM), Uber Eats exposes a clean same-origin JSON
 * API that is cookie-authenticated. The ONLY non-standard requirement is a
 * static CSRF header (`x-csrf-token: x` — Uber accepts the literal string "x",
 * so there is NO token to capture). See docs/recon-findings.md, the
 * "Uber Eats — CONFIRMED" section, for the live-verified reconnaissance.
 *
 * Data path (all POST https://www.ubereats.com/_p/api/…):
 *   - getPastOrdersV1   — the order LIST, cursor-paginated. Response:
 *                         { ordersMap, orderUuids, paginationData, meta }.
 *   - getOrderEntitiesV1 — per-order detail (items / fares / store), by UUID.
 *   - getInvoiceStatusV1 — invoice availability for an order (best-effort).
 *
 * Because the requests must ride the page's own cookie session and Uber's
 * anti-abuse checks are happiest with a genuine page-origin fetch, every API
 * call is executed FROM THE PAGE CONTEXT via a tiny injected bridge (mirrors the
 * Walmart adapter's fetch bridge) and the JSON is postMessage'd back to the
 * content script. Nothing below touches the DOM or issues a request at module
 * load — the engine only invokes the content methods inside a ubereats.com page.
 *
 * Loadable in all three extension contexts and safe at load time everywhere
 * (service worker importScripts, content_scripts, side panel). Only the identity
 * config + isOrdersListUrl are read outside a page; the fetch/mapping engine
 * runs solely when a content-context method is called.
 */
const UbereatsProvider = (() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Identity / config (safe to read in ANY context — no DOM, no network).
  // ---------------------------------------------------------------------------
  const API_BASE = "https://www.ubereats.com/_p/api";
  const ORDERS_LIST_URL = "https://www.ubereats.com/orders";

  const ENDPOINTS = {
    PAST_ORDERS: "getPastOrdersV1",
    ORDER_ENTITIES: "getOrderEntitiesV1",
    INVOICE_STATUS: "getInvoiceStatusV1",
  };

  // Uber accepts the literal string "x" — this is NOT a captured secret.
  const CSRF_TOKEN = "x";

  // Politeness pacing between API calls so an automated crawl does not hammer
  // the endpoint (matches the spirit of the Walmart page-load delays).
  const REQUEST_PACING_MS = 600;
  // How many orders to request per getPastOrdersV1 page. Uber's own UI uses a
  // small page size; keep it modest and follow the cursor to exhaustion.
  const PAGE_LIMIT = 10;
  // Safety cap so a broken/looping cursor can never spin forever.
  const MAX_LIST_PAGES = 200;

  /**
   * The orders LIST page. An order-DETAIL URL like /orders/<uuid> must NOT
   * match, so the trailing segment guard mirrors the Walmart predicate.
   */
  function isOrdersListUrl(url) {
    return /^https:\/\/www\.ubereats\.com\/orders\/?($|\?)/i.test(String(url || ""));
  }

  // ==========================================================================
  // Content-context engine — runs ONLY inside a ubereats.com page.
  // Everything below references window/document and must never execute at
  // module load in a service worker.
  // ==========================================================================

  const BRIDGE_SOURCE = "WIE_UBEREATS_BRIDGE";
  const BRIDGE_REQUEST = "UBEREATS_API_REQUEST";
  const BRIDGE_RESPONSE = "UBEREATS_API_RESPONSE";

  const clean = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // In-page fetch RPC ---------------------------------------------------------
  // The content script cannot always issue a request that Uber treats as a
  // first-party page fetch, so we inject a script into the PAGE world that owns
  // the real fetch + cookies and relay the JSON back over window.postMessage.
  const ApiBridge = (() => {
    let installed = false;
    let listenerAttached = false;
    let seq = 0;
    const pending = new Map();

    function handleMessage(event) {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || msg.source !== BRIDGE_SOURCE || msg.type !== BRIDGE_RESPONSE) return;
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve({ ok: true, status: msg.status, data: msg.data });
      } else {
        entry.resolve({ ok: false, status: msg.status || 0, error: msg.error || "request failed", data: null });
      }
    }

    function inject() {
      if (installed) return;
      installed = true;

      if (!listenerAttached) {
        window.addEventListener("message", handleMessage);
        listenerAttached = true;
      }

      if (document.documentElement && document.documentElement.dataset.wieUeBridgeInjected === "true") {
        return;
      }
      if (document.documentElement) {
        document.documentElement.dataset.wieUeBridgeInjected = "true";
      }

      const script = document.createElement("script");
      script.setAttribute("data-wie-bridge", "ubereats-api");
      script.textContent = `(() => {
        const SOURCE = ${JSON.stringify(BRIDGE_SOURCE)};
        const REQ = ${JSON.stringify(BRIDGE_REQUEST)};
        const RES = ${JSON.stringify(BRIDGE_RESPONSE)};
        const API_BASE = ${JSON.stringify(API_BASE)};
        const CSRF = ${JSON.stringify(CSRF_TOKEN)};

        if (window.__wieUbereatsBridgeInstalled) return;
        window.__wieUbereatsBridgeInstalled = true;

        window.addEventListener("message", (event) => {
          if (event.source !== window) return;
          const msg = event.data;
          if (!msg || msg.source !== SOURCE || msg.type !== REQ) return;

          const reply = (payload) => window.postMessage(
            Object.assign({ source: SOURCE, type: RES, id: msg.id }, payload),
            "*"
          );

          let url = API_BASE + "/" + String(msg.endpoint || "").replace(/^\\/+/, "");
          fetch(url, {
            method: "POST",
            credentials: "include",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": CSRF,
              "accept": "application/json",
            },
            body: JSON.stringify(msg.body || {}),
          })
            .then((response) =>
              response
                .text()
                .then((text) => {
                  let data = null;
                  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
                  reply({ ok: response.ok, status: response.status, data });
                })
                .catch((err) => reply({ ok: false, status: response.status, error: String(err) }))
            )
            .catch((err) => reply({ ok: false, status: 0, error: String(err) }));
        });
      })();`;

      (document.head || document.documentElement).appendChild(script);
      script.remove();
    }

    /**
     * POST an endpoint from the page context and resolve its parsed JSON.
     * Never throws: resolves { ok:false } on any transport/parse error.
     */
    function post(endpoint, body, { timeoutMs = 20000 } = {}) {
      inject();
      const id = `ue-${Date.now()}-${seq++}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            resolve({ ok: false, status: 0, error: "timeout", data: null });
          }
        }, timeoutMs);

        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
        });

        window.postMessage({ source: BRIDGE_SOURCE, type: BRIDGE_REQUEST, id, endpoint, body }, "*");
      });
    }

    return { inject, post };
  })();

  // Small module-scoped cache of the raw order objects seen while collecting,
  // keyed by UUID. Lets scrapeOrder reuse the list payload when it runs on the
  // same page instance; on a fresh detail page it falls back to a fetch.
  const orderCache = new Map();

  // Generic deep-first-match helpers ------------------------------------------
  // The recon captured KEY NAMES, not exact nesting, so mapping stays defensive:
  // we search a small set of candidate keys, then fall back to a bounded deep
  // scan. This keeps extraction resilient if Uber reshuffles nesting.
  function firstDefined(obj, keys) {
    if (!obj || typeof obj !== "object") return undefined;
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
        return obj[key];
      }
    }
    return undefined;
  }

  function deepFind(root, predicate, maxDepth = 6) {
    const stack = [{ node: root, depth: 0 }];
    const seen = new Set();
    while (stack.length) {
      const { node, depth } = stack.pop();
      if (!node || typeof node !== "object" || depth > maxDepth || seen.has(node)) continue;
      seen.add(node);
      const hit = predicate(node);
      if (hit !== undefined) return hit;
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") {
          stack.push({ node: value, depth: depth + 1 });
        }
      }
    }
    return undefined;
  }

  // Map an ISO-4217 currency code to a display prefix. Uber's live payloads for
  // this account are USD; keep "$" as the default and fall back to the raw code
  // (e.g. "CA$", "€", "£") so non-USD orders are still legible.
  const CURRENCY_SYMBOLS = { USD: "$", CAD: "CA$", GBP: "£", EUR: "€", AUD: "A$", MXN: "MX$" };
  function currencyPrefix(code) {
    const key = clean(code).toUpperCase();
    if (!key) return "$";
    if (CURRENCY_SYMBOLS[key]) return CURRENCY_SYMBOLS[key];
    return `${key} `;
  }

  // Uber money is usually { amountE5 } / { unitAmount } / a formatted string, or
  // a minor-units integer on fareInfo. Return a display string like "$12.34"
  // using whatever shape is present. `currency` is the ISO code from the order
  // (baseEaterOrder.shoppingCart.currencyCode) so the prefix matches the order.
  function moneyToDisplay(value, currency) {
    if (value == null) return "";
    if (typeof value === "string") return clean(value);
    if (typeof value === "number") return formatCurrencyNumber(value, currency);
    if (typeof value === "object") {
      const formatted = firstDefined(value, [
        "formattedAmount",
        "formatted",
        "displayValue",
        "text",
        "label",
      ]);
      if (formatted) return clean(formatted);
      const code = firstDefined(value, ["currencyCode", "currency"]) || currency;
      // Uber often stores amounts scaled by 1e5 or 1e2 (minor units).
      if (value.amountE5 != null) return formatCurrencyNumber(Number(value.amountE5) / 1e5, code);
      if (value.amountE2 != null) return formatCurrencyNumber(Number(value.amountE2) / 1e2, code);
      const raw = firstDefined(value, ["amount", "unitAmount", "value", "highPrice", "price"]);
      if (raw != null) {
        const num = Number(raw);
        // Heuristic: large integers are minor units (cents).
        if (Number.isFinite(num)) {
          return num >= 1000 && Number.isInteger(num)
            ? formatCurrencyNumber(num / 100, code)
            : formatCurrencyNumber(num, code);
        }
      }
    }
    return "";
  }

  function formatCurrencyNumber(num, currency) {
    if (!Number.isFinite(num)) return "";
    return `${currencyPrefix(currency)}${num.toFixed(2)}`;
  }

  function epochToDate(value) {
    if (value == null || value === "") return "";
    let ms = null;
    if (typeof value === "number") {
      ms = value < 1e12 ? value * 1000 : value; // seconds vs milliseconds
    } else if (/^\d+$/.test(String(value))) {
      const num = Number(value);
      ms = num < 1e12 ? num * 1000 : num;
    } else {
      const parsed = Date.parse(String(value));
      if (!Number.isNaN(parsed)) ms = parsed;
    }
    if (ms == null) return clean(value);
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return clean(value);
    return date.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
  }

  // ---- Order LIST (collectOrderNumbers) -------------------------------------

  function buildListBody(nextCursor) {
    // Live-verified body keys: { limit, orderUuids, startTimeMs }. The exact
    // cursor parameter name is the main unknown — send the cursor under the
    // most likely keys so whichever Uber honors is present. See ASSUMPTIONS.
    const body = { limit: PAGE_LIMIT, orderUuids: [], startTimeMs: null };
    if (nextCursor) {
      body.nextCursor = nextCursor;
      body.cursor = nextCursor;
      body.paginationData = { nextCursor };
    }
    return body;
  }

  // Live-verified: the ISO currency code lives on the shopping cart, with the
  // base order as a fallback (baseEaterOrder.shoppingCart.currencyCode /
  // baseEaterOrder.currencyCode).
  function orderCurrency(order) {
    const base = order?.baseEaterOrder || order || {};
    const cart = base.shoppingCart || {};
    return clean(
      firstDefined(cart, ["currencyCode", "currency"]) ||
        firstDefined(base, ["currencyCode", "currency"]) ||
        ""
    );
  }

  function summarizeOrder(uuid, order) {
    const base = order?.baseEaterOrder || order || {};
    const store = order?.storeInfo || {};
    const fare = order?.fareInfo || {};
    const currency = orderCurrency(order);

    const storeName = clean(
      firstDefined(store, ["title", "name", "storeName"]) ||
        deepFind(store, (n) => (typeof n.title === "string" ? n.title : undefined)) ||
        ""
    );

    // Live-verified: date = baseEaterOrder.completedAt (fall back lastStateChangeAt).
    const orderDate = epochToDate(
      firstDefined(base, ["completedAt", "lastStateChangeAt"]) ||
        firstDefined(base, ["orderTimeMs", "createdTimeMs", "placedTimeMs", "orderTime", "timestamp"])
    );

    const total = moneyToDisplay(
      firstDefined(fare, ["total", "grandTotal", "totalPrice", "totalCharge"]) ||
        deepFind(fare, (n) => (n.total != null ? n.total : undefined)),
      currency
    );

    const status = clean(
      firstDefined(order, ["orderStateTitle", "statusText", "state"]) ||
        firstDefined(base, ["orderStateTitle", "statusText", "state"]) ||
        ""
    );

    // Live-verified: item count = baseEaterOrder.numItems.
    const numItems = firstDefined(base, ["numItems", "itemCount"]);

    return {
      source: "ubereats-api",
      orderNumber: uuid,
      orderDate,
      orderTotal: total,
      subTotal: "",
      driverTip: "",
      status,
      merchant: storeName,
      fulfillmentTypes: "Delivery",
      itemCount: numItems == null ? "" : String(numItems),
      isInStore: false,
      items: [],
    };
  }

  async function handleCollectOrderNumbers() {
    ApiBridge.inject();

    const orderNumbers = [];
    const additionalFields = {};
    const orderSummaries = {};
    const seen = new Set();

    let nextCursor = null;
    let pages = 0;
    let anyResponse = false;

    do {
      const result = await ApiBridge.post(ENDPOINTS.PAST_ORDERS, buildListBody(nextCursor));
      if (!result.ok || !result.data) {
        // A hard transport error on the FIRST page is a retryable failure; once
        // we already have orders, treat it as the end of the list.
        if (!anyResponse) {
          return { orderNumbers: [], additionalFields: {}, orderSummaries: {}, hasNextPage: false, collectionError: true };
        }
        break;
      }
      anyResponse = true;

      const payload = result.data;
      const ordersMap = payload.ordersMap || payload.data?.ordersMap || {};
      const uuids = Array.isArray(payload.orderUuids)
        ? payload.orderUuids
        : Array.isArray(payload.data?.orderUuids)
          ? payload.data.orderUuids
          : Object.keys(ordersMap);

      uuids.forEach((uuid) => {
        const key = clean(uuid);
        if (!key || seen.has(key)) return;
        seen.add(key);
        const order = ordersMap[uuid] || ordersMap[key] || {};
        orderCache.set(key, order);
        orderNumbers.push(key);
        const summary = summarizeOrder(key, order);
        additionalFields[key] = summary.merchant
          ? `${summary.merchant}${summary.orderDate ? " — " + summary.orderDate : ""}`
          : summary.orderDate || key;
        orderSummaries[key] = summary;
      });

      const pagination = payload.paginationData || payload.data?.paginationData || {};
      nextCursor = pagination.nextCursor || pagination.cursor || null;
      pages += 1;
    } while (nextCursor && pages < MAX_LIST_PAGES && (await wait(REQUEST_PACING_MS), true));

    if (orderNumbers.length === 0) {
      // No orders at all — a genuinely empty history, not a retryable error.
      return { orderNumbers: [], additionalFields: {}, orderSummaries: {}, hasNextPage: false, endOfOrders: true };
    }

    // The cursor was drained internally, so the engine never needs another
    // list page. clickNextPage is a formality that resolves { success:true }.
    return { orderNumbers, additionalFields, orderSummaries, hasNextPage: false };
  }

  // ---- Order DETAIL (scrapeOrder) -------------------------------------------

  function extractUuidFromLocation(loc) {
    const path = String(loc?.pathname || "");
    const match = path.match(/\/orders\/([^/?#]+)/i);
    if (match && match[1] && !/^$/.test(match[1])) {
      return decodeURIComponent(match[1]);
    }
    return "";
  }

  function mapItems(order, entities, currency) {
    const items = [];
    const seen = new Set();

    const push = (raw) => {
      if (!raw || typeof raw !== "object") return;
      const productName = clean(
        firstDefined(raw, ["title", "name", "itemName", "displayName"]) || ""
      );
      const quantityRaw = firstDefined(raw, ["quantity", "count", "qty"]);
      const quantity = quantityRaw == null ? "" : String(quantityRaw);
      const priceRaw = firstDefined(raw, ["price", "totalPrice", "itemPrice", "unitPrice", "charge", "fare"]);
      // LIVE-VERIFIED: Uber Eats cart-item prices are integer MINOR units (cents),
      // e.g. 1299 = $12.99 — unlike fareInfo.checkoutInfo rawValues, which are
      // dollar-decimals. Scale integer item prices; defer other shapes to moneyToDisplay.
      const price =
        typeof priceRaw === "number" && Number.isInteger(priceRaw)
          ? formatCurrencyNumber(priceRaw / 100, currency)
          : moneyToDisplay(priceRaw, currency);
      if (!productName && !quantity && !price) return;
      const key = `${productName}|${quantity}|${price}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({
        productName,
        productLink: "N/A",
        deliveryStatus: "Delivered",
        quantity,
        price,
        thumbnailUrl: clean(
          firstDefined(raw, ["imageUrl", "imageURL", "thumbnailUrl", "photoUrl"]) || ""
        ),
      });
    };

    // Live-verified primary source: baseEaterOrder.shoppingCart.items[], with
    // baseEaterOrder.userGroupedItems[].items as the secondary shape. Collect
    // both explicitly before falling back to a defensive deep scan (which also
    // covers the optional getOrderEntitiesV1 detail payload).
    const base = order?.baseEaterOrder || order || {};

    const cartItems = base.shoppingCart && base.shoppingCart.items;
    if (Array.isArray(cartItems)) cartItems.forEach(push);

    const grouped = base.userGroupedItems;
    if (Array.isArray(grouped)) {
      grouped.forEach((group) => {
        if (group && Array.isArray(group.items)) group.items.forEach(push);
      });
    }

    // Fallback deep scan only if the verified paths yielded nothing.
    if (items.length === 0) {
      const roots = [order?.baseEaterOrder, order, entities].filter(Boolean);
      roots.forEach((root) => {
        const collection =
          deepFind(root, (n) => (Array.isArray(n.items) ? n.items : undefined)) ||
          deepFind(root, (n) => (Array.isArray(n.shoppingCartItems) ? n.shoppingCartItems : undefined)) ||
          deepFind(root, (n) => (Array.isArray(n.orderItems) ? n.orderItems : undefined));
        if (Array.isArray(collection)) collection.forEach(push);
      });
    }

    return items;
  }

  function mapFare(fare, currency) {
    const pick = (keys) => moneyToDisplay(firstDefined(fare || {}, keys), currency);
    // LIVE-VERIFIED: Uber Eats puts the fare breakdown in `fareInfo.checkoutInfo[]`
    // as `{ label, key, type, rawValue }` line items (rawValue is a dollar-decimal),
    // NOT a `charges`/`fareBreakdown` list keyed on `amount`. Keep the older keys as
    // fallbacks for other deployments.
    const chargesList =
      (fare && (fare.checkoutInfo || fare.charges || fare.fareBreakdown || fare.items)) || [];

    const labelOf = (c) => clean(firstDefined(c, ["label", "name", "title", "key", "type"]) || "").toLowerCase();
    const amountOf = (c) => moneyToDisplay(firstDefined(c, ["rawValue", "amount", "price", "value", "total"]), currency);

    // Match exact label first, then startsWith, then includes — so "Tax" wins over
    // "Tax on Delivery Fees" and "Delivery Fee" over "Delivery Fee Adjustment".
    const findCharge = (needles) => {
      const list = Array.isArray(chargesList) ? chargesList : [];
      const wants = Array.isArray(needles) ? needles : [needles];
      const tests = [
        (label, n) => label === n,
        (label, n) => label.startsWith(n),
        (label, n) => label.includes(n),
      ];
      for (const test of tests) {
        const entry = list.find((c) => wants.some((n) => test(labelOf(c), n)));
        if (entry) return amountOf(entry);
      }
      return "";
    };

    return {
      orderTotal: pick(["total", "grandTotal", "totalPrice", "totalCharge"]) || findCharge(["total", "order total"]),
      orderSubtotal: pick(["subtotal", "subTotal"]) || findCharge(["subtotal"]),
      tax: pick(["tax", "taxTotal"]) || findCharge(["tax"]),
      tip: pick(["tip", "tipTotal", "courierTip"]) || findCharge(["tip", "tips", "courier tip"]),
      deliveryCharges: pick(["deliveryFee", "deliveryCharge"]) || findCharge(["delivery fee", "delivery"]),
      serviceFee: pick(["serviceFee"]) || findCharge(["service fee and other fees", "service fee", "service"]),
    };
  }

  async function handleScrapeOrder(ctx) {
    ApiBridge.inject();
    const loc = ctx?.location || (typeof window !== "undefined" ? window.location : null);
    const uuid = extractUuidFromLocation(loc);

    // Start from any cached list order (same-page instance), then enrich with a
    // per-order fetch so line items / full fares are never missed.
    let order = uuid ? orderCache.get(uuid) || null : null;
    let entities = null;

    if (uuid) {
      const detail = await ApiBridge.post(ENDPOINTS.ORDER_ENTITIES, { orderUuid: uuid, orderUUID: uuid });
      if (detail.ok && detail.data) {
        entities = detail.data;
        // Some deployments echo the order object under ordersMap keyed by uuid.
        const echoed =
          detail.data.ordersMap?.[uuid] ||
          detail.data.order ||
          detail.data.data?.order ||
          null;
        if (echoed) order = echoed;
      }
      await wait(REQUEST_PACING_MS);
      // Invoice availability is best-effort metadata; failures are ignored.
      await ApiBridge.post(ENDPOINTS.INVOICE_STATUS, { orderUuid: uuid, orderUUID: uuid });
    }

    order = order || {};
    const base = order.baseEaterOrder || order;
    const store = order.storeInfo || deepFind(entities || {}, (n) => (n.storeInfo ? n.storeInfo : undefined)) || {};
    const fare = order.fareInfo || deepFind(entities || {}, (n) => (n.fareInfo ? n.fareInfo : undefined)) || {};
    const currency = orderCurrency(order);

    // Live-verified: merchant = storeInfo.title.
    const merchant = clean(firstDefined(store, ["title", "name", "storeName"]) || "");
    // Live-verified: date = baseEaterOrder.completedAt (fall back lastStateChangeAt).
    const orderDate = epochToDate(
      firstDefined(base, ["completedAt", "lastStateChangeAt"]) ||
        firstDefined(base, ["orderTimeMs", "createdTimeMs", "placedTimeMs", "orderTime", "timestamp"])
    );
    const fares = mapFare(fare, currency);
    const items = mapItems(order, entities, currency);

    // Live-verified store address: storeInfo.location.address.{address1,city,
    // region,postalCode,country}. Compose a single line; fall back to any
    // formatted-address string found in either payload.
    const storeAddr =
      (store.location && store.location.address) ||
      deepFind(store, (n) => (n.address1 != null || n.postalCode != null ? n : undefined)) ||
      null;
    let addressLine = "";
    if (storeAddr && typeof storeAddr === "object") {
      addressLine = clean(
        [
          firstDefined(storeAddr, ["address1", "street", "line1"]),
          firstDefined(storeAddr, ["city", "locality"]),
          firstDefined(storeAddr, ["region", "state"]),
          firstDefined(storeAddr, ["postalCode", "zip", "postcode"]),
          firstDefined(storeAddr, ["country", "countryCode"]),
        ]
          .filter((part) => part != null && String(part) !== "")
          .join(", ")
      );
    }
    if (!addressLine) {
      addressLine = clean(
        deepFind(order, (n) => (typeof n.formattedAddress === "string" ? n.formattedAddress : undefined)) ||
          deepFind(order, (n) => (typeof n.address === "string" ? n.address : undefined)) ||
          deepFind(entities || {}, (n) => (typeof n.formattedAddress === "string" ? n.formattedAddress : undefined)) ||
          ""
      );
    }

    const data = {
      schemaVersion: typeof CONSTANTS !== "undefined" ? CONSTANTS.ORDER_SCHEMA_VERSION : undefined,
      orderNumber:
        uuid ||
        clean(firstDefined(base, ["uuid", "orderUuid", "id"]) || "") ||
        clean(firstDefined(order, ["uuid", "orderUuid", "id"]) || ""),
      orderDate,
      orderType: "Delivery",
      isInStore: false,
      orderSubtotal: fares.orderSubtotal,
      subtotalBeforeSavings: "",
      savings: "",
      orderTotal: fares.orderTotal,
      deliveryCharges: fares.deliveryCharges,
      bagFee: "",
      tax: fares.tax,
      tip: fares.tip,
      refund: "",
      donations: "",
      barcodeImageUrl: "",
      sellers: merchant,
      fulfillmentTypes: "Delivery",
      deliveredDate: orderDate,
      trackingNumbers: "",
      paymentSplit: "",
      address: addressLine,
      addressRecipient: "",
      addressLine,
      deliveryInstructions: "",
      deliveryInstructionsExpanded: false,
      paymentMethods: "",
      paymentMethodDetails: [],
      paymentMessages: fares.serviceFee ? `Service fee: ${fares.serviceFee}` : "",
      items,
    };

    data.extractionWarnings = computeExtractionWarnings(data);
    return data;
  }

  /**
   * Best-effort tripwire warnings for empty expected fields (mirrors the
   * Walmart adapter's contract). Never throws.
   */
  function computeExtractionWarnings(data) {
    const warnings = [];
    try {
      const items = Array.isArray(data?.items) ? data.items : [];
      if (items.length === 0) {
        warnings.push("No items were extracted for this order");
      } else if (items.every((item) => !clean(item?.productName))) {
        warnings.push("All extracted items have a blank product name");
      }
      if (!clean(data?.orderTotal)) {
        warnings.push("Order total came back empty");
      }
      if (!clean(data?.orderDate)) {
        warnings.push("Order date came back empty");
      }
      if (!clean(data?.sellers)) {
        warnings.push("Merchant / store name came back empty");
      }
      if (!data?.orderNumber) {
        warnings.push("Order number is missing");
      }
    } catch (error) {
      console.warn("Uber Eats extraction validation failed (ignored):", error);
    }
    return warnings;
  }

  // ==========================================================================
  // Interface methods (see providers/base.js). `ctx` is built by content.js.
  // ==========================================================================

  function initContent(ctx) {
    // Install the page-context fetch bridge as early as possible so the first
    // collectOrderNumbers call already has a working request channel.
    try {
      ApiBridge.inject();
    } catch (error) {
      console.warn("Uber Eats bridge injection failed:", error);
    }
  }

  async function collectOrderNumbers(ctx) {
    try {
      return await handleCollectOrderNumbers();
    } catch (error) {
      console.error("Uber Eats collectOrderNumbers failed:", error);
      return { orderNumbers: [], additionalFields: {}, orderSummaries: {}, hasNextPage: false, collectionError: true };
    }
  }

  async function scrapeOrder(ctx) {
    try {
      return await handleScrapeOrder(ctx);
    } catch (error) {
      console.error("Uber Eats scrapeOrder failed:", error);
      return {
        schemaVersion: typeof CONSTANTS !== "undefined" ? CONSTANTS.ORDER_SCHEMA_VERSION : undefined,
        orderNumber: extractUuidFromLocation(ctx?.location || (typeof window !== "undefined" ? window.location : null)),
        orderDate: "",
        orderTotal: "",
        items: [],
        extractionWarnings: ["Uber Eats order extraction threw: " + (error && error.message)],
      };
    }
  }

  // Cursor pagination is drained inside collectOrderNumbers, so advancing the
  // list is a no-op that simply reports success.
  async function clickNextPage(ctx) {
    return { success: true };
  }

  return {
    id: "UBEREATS",
    label: "Uber Eats",
    flag: "provider.ubereats",
    defaultEnabled: false,
    hostPermissions: ["https://www.ubereats.com/*"],
    contentMatches: ["https://www.ubereats.com/orders*"],
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

// Register with the shared registry. registry.js loads before this file in
// every context; the guard keeps the file inert if it is ever loaded alone.
if (typeof ProviderRegistry !== "undefined" && ProviderRegistry.register) {
  ProviderRegistry.register(UbereatsProvider);
}
