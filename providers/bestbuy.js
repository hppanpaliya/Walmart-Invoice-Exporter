/**
 * providers/bestbuy.js — Best Buy (BESTBUY) provider adapter.
 *
 * Best Buy runs on Next.js with the APP ROUTER, so there is no `__NEXT_DATA__`
 * blob like Walmart's. Instead the server streams React Server Component (RSC)
 * output into `window.__next_f` — an array of chunks the framework `push()`es as
 * the page hydrates. The order records are embedded in that flight stream AND
 * mirrored into DOM "order cards". This adapter reads the RSC payload first and
 * falls back to scraping the cards.
 *
 * ANTI-BOT NOTE: bestbuy.com is behind Akamai Bot Manager (obfuscated beacon
 * POSTs, challengeable automated navigation). This adapter therefore:
 *  - never fabricates navigation or hammers endpoints — it only reads whatever
 *    the real, user-visited page already rendered, at human pace;
 *  - never tries to defeat a challenge/captcha — if the page looks challenged
 *    or blocked it returns { collectionError: true } so the background loop
 *    retries/aborts gracefully instead of looking like a bot.
 *
 * Loadable in all three extension contexts and safe at load time everywhere:
 * nothing below touches the DOM/window at module load — the content engine only
 * runs when a content-script method is invoked, which only happens in a page.
 * `CONSTANTS` and `delay` come from utils.js (loaded before this file in every
 * context); everything else is self-contained in this IIFE.
 *
 * RSC field paths and the pagination-control selector are BRITTLE and flagged
 * for live re-verification (see the header of multi-provider recon notes and the
 * "LIVE RE-VERIFY" comments below). Parsing is deliberately defensive and
 * populates extractionWarnings generously.
 */
const BestBuyProvider = (() => {
  "use strict";

  const ORIGIN = "https://www.bestbuy.com";

  // NOTE (LIVE RE-VERIFY): all selectors below are best-effort guesses against
  // the App Router markup and MUST be confirmed against a live logged-in
  // purchase-history page. They are written broadly (multiple fallbacks) so a
  // partial match still yields data.
  const SELECTORS = {
    // Order cards on https://www.bestbuy.com/purchasehistory/purchases
    ORDER_CARDS: [
      '[data-testid*="order-card"]',
      '[class*="order-card"]',
      '[class*="OrderCard"]',
      'section[class*="order"]',
      'article[class*="order"]',
      'li[class*="order"]',
    ].join(", "),
    // A link/anchor to the order-detail view — the digits become the order #.
    ORDER_DETAIL_LINK: 'a[href*="/order"], a[href*="orderId="], a[href*="/purchasehistory/"]',
    // Pagination control on the list page (page-based UI).
    NEXT_BUTTON: [
      'button[aria-label*="Next" i]:not([disabled])',
      'a[aria-label*="Next" i]',
      'button[data-testid*="next" i]:not([disabled])',
      '[class*="pagination"] button:not([disabled])[class*="next" i]',
      'nav[aria-label*="pagination" i] a[rel="next"]',
    ].join(", "),
    // Challenge / block detection (Akamai). If any is present we bail out.
    CHALLENGE: [
      '#challenge-running',
      '[id*="akamai"]',
      'iframe[src*="challenge"]',
      'form[action*="validate"]',
    ].join(", "),
    // Order-detail page anchors for scrapeOrder's DOM fallback.
    DETAIL_ITEM_ROWS: '[data-testid*="line-item"], [class*="lineItem"], [class*="line-item"], [class*="item-row"]',
  };

  // ==========================================================================
  // Self-contained helpers (kept local so this file has NO dependency on the
  // Walmart adapter's private scope).
  // ==========================================================================

  function cleanText(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function normalizeOrderNumber(value) {
    return String(value == null ? "" : value).replace(/[^\d]/g, "");
  }

  function extractCurrencyValues(value) {
    if (!value) return [];
    const matches = String(value).match(/-?\$[\d,]+(?:\.\d{2})?/g);
    return matches ? matches.map((m) => cleanText(m)) : [];
  }

  function toAbsoluteUrl(value) {
    const raw = cleanText(value);
    if (!raw) return "";
    try {
      return new URL(raw, ORIGIN).href;
    } catch (_) {
      return raw;
    }
  }

  function pageLooksChallenged() {
    try {
      if (document.querySelector(SELECTORS.CHALLENGE)) return true;
      // Akamai interstitials render a near-empty shell — no order UI at all.
      const title = cleanText(document.title).toLowerCase();
      if (title.includes("access denied") || title.includes("blocked") || title.includes("robot")) {
        return true;
      }
      const bodyText = cleanText(document.body?.textContent || "").toLowerCase();
      if (
        bodyText.length < 40 &&
        (bodyText.includes("verify") || bodyText.includes("denied") || bodyText === "")
      ) {
        // Only treat an essentially-empty body as challenged; a normal page has
        // far more text than this.
        return document.querySelectorAll("*").length < 25;
      }
    } catch (_) {
      // If we cannot even inspect the page, treat as challenged/unsafe.
      return true;
    }
    return false;
  }

  async function waitForAny(selectors, timeout, pollInterval) {
    const to = timeout || CONSTANTS.TIMING.COLLECTION_TIMEOUT;
    const poll = pollInterval || CONSTANTS.TIMING.ELEMENT_POLL_INTERVAL;
    const start = Date.now();
    while (Date.now() - start < to) {
      for (const selector of selectors) {
        if (selector && document.querySelector(selector)) return true;
      }
      await delay(poll);
    }
    return false;
  }

  /** The orders LIST page (a detail URL like /purchasehistory/purchases/<id> is NOT it). */
  function isOrdersListUrl(url) {
    return /^https:\/\/www\.bestbuy\.com\/purchasehistory\/purchases\/?($|\?)/.test(String(url || ""));
  }

  // ==========================================================================
  // RSC (__next_f) parsing — PRIMARY extraction path.
  //
  // window.__next_f is an array whose entries are pushed by the framework. Each
  // entry is typically [tag, payloadString]; concatenating the string payloads
  // reconstructs the flight stream. That stream is a sequence of `id:JSON` lines
  // where the JSON encodes the server component tree, with order records nested
  // somewhere inside. Because the exact shape/paths are unknown and change, we:
  //   1. concatenate all string chunks;
  //   2. try to parse the many embedded JSON fragments;
  //   3. deep-walk every parsed object to find "order-like" nodes;
  //   4. as a last resort, regex the raw text for orderNumber tokens.
  // ==========================================================================

  function readNextFlightChunks() {
    try {
      const arr = window.__next_f;
      if (!Array.isArray(arr)) return "";
      const parts = [];
      for (const entry of arr) {
        if (typeof entry === "string") {
          parts.push(entry);
        } else if (Array.isArray(entry)) {
          // [tag, payload] — keep only string payloads.
          for (const piece of entry) {
            if (typeof piece === "string") parts.push(piece);
          }
        }
      }
      return parts.join("");
    } catch (_) {
      return "";
    }
  }

  /**
   * Pull every parseable JSON value out of the flight text. The stream is not a
   * single JSON document, so we brace-scan for balanced `{...}` / `[...]` spans
   * and JSON.parse each. Cheap and defensive; failures are skipped silently.
   * @param {string} text
   * @returns {Object[]} parsed JSON values (objects/arrays)
   */
  function parseJsonFragments(text) {
    const results = [];
    if (!text) return results;
    const openers = { "{": "}", "[": "]" };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch !== "{" && ch !== "[") continue;
      // Cheap pre-filter: only attempt spans that mention an order-ish token,
      // so we do not brace-scan the whole (huge) UI tree.
      const close = openers[ch];
      let depth = 0;
      let inStr = false;
      let esc = false;
      let end = -1;
      for (let j = i; j < text.length; j++) {
        const c = text[j];
        if (inStr) {
          if (esc) esc = false;
          else if (c === "\\") esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") {
          depth--;
          if (depth === 0) { end = j; break; }
        }
        // Guard against pathological spans.
        if (j - i > 400000) break;
      }
      if (end === -1) continue;
      const span = text.slice(i, end + 1);
      if (span.indexOf("order") === -1 && span.indexOf("Order") === -1) {
        // Skip spans with no order tokens; advance past this opener.
        continue;
      }
      try {
        results.push(JSON.parse(span));
        i = end; // Skip past the consumed span.
      } catch (_) {
        // Not valid JSON on its own; leave i to advance normally.
      }
    }
    return results;
  }

  const ORDER_NUMBER_KEYS = ["orderNumber", "orderId", "orderNo", "number", "id", "displayNumber"];

  function looksLikeOrderNode(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return false;
    const hasNumber = ORDER_NUMBER_KEYS.some((k) => {
      const v = node[k];
      return v != null && normalizeOrderNumber(v).length >= 6;
    });
    if (!hasNumber) return false;
    // Require at least one other order-ish signal to avoid random {id:...} nodes.
    const orderSignals = [
      "orderDate", "orderTotal", "total", "lineItems", "items", "products",
      "orderState", "status", "orderStatus", "grandTotal", "purchaseDate",
    ];
    return orderSignals.some((k) => node[k] != null);
  }

  function deepCollectOrders(root, sink, seen) {
    if (!root || typeof root !== "object") return;
    if (seen.has(root)) return;
    seen.add(root);
    if (Array.isArray(root)) {
      for (const el of root) deepCollectOrders(el, sink, seen);
      return;
    }
    if (looksLikeOrderNode(root)) sink.push(root);
    for (const key of Object.keys(root)) {
      const val = root[key];
      if (val && typeof val === "object") deepCollectOrders(val, sink, seen);
    }
  }

  function firstDefined(node, keys) {
    for (const k of keys) {
      if (node && node[k] != null && node[k] !== "") return node[k];
    }
    return "";
  }

  function displayValueOf(value) {
    if (value == null) return "";
    if (typeof value === "string" || typeof value === "number") return cleanText(value);
    // Common money-object shapes.
    return cleanText(
      value.displayValue ||
      value.formatted ||
      value.formattedValue ||
      value.amount ||
      value.value ||
      ""
    );
  }

  /**
   * Map a raw RSC order node into a Quick Export summary. Every path is a guess
   * (LIVE RE-VERIFY) with an empty-string fallback, so a shape change degrades
   * to partial data rather than throwing.
   */
  function buildOrderSummaryFromNode(node, normalizedOrderNumber) {
    const rawItems =
      (Array.isArray(node.lineItems) && node.lineItems) ||
      (Array.isArray(node.items) && node.items) ||
      (Array.isArray(node.products) && node.products) ||
      [];

    const items = rawItems.map((it) => ({
      name: cleanText(firstDefined(it, ["name", "productName", "title", "description"])),
      quantity: firstDefined(it, ["quantity", "qty", "itemQuantity"]) || "",
      statusCode: cleanText(firstDefined(it, ["status", "lineItemStatus", "itemStatus"])),
      thumbnailUrl: toAbsoluteUrl(
        firstDefined(it, ["imageUrl", "thumbnailUrl", "image", "imageLink"]) ||
        (it.images && (it.images.thumbnail || it.images[0])) ||
        ""
      ),
    }));

    return {
      source: "rsc",
      orderNumber: normalizedOrderNumber,
      orderDate: cleanText(firstDefined(node, ["orderDate", "purchaseDate", "orderPlacedDate", "date"])),
      deliveredDate: cleanText(firstDefined(node, ["deliveredDate", "deliveryDate", "estimatedDeliveryDate"])),
      orderType: cleanText(firstDefined(node, ["orderType", "type", "fulfillmentType"])),
      isInStore: /store|pickup|in-?store/i.test(cleanText(firstDefined(node, ["orderType", "fulfillmentType", "type"]))),
      itemCount: rawItems.length || firstDefined(node, ["itemCount", "totalItems"]) || "",
      orderTotal: displayValueOf(firstDefined(node, ["orderTotal", "grandTotal", "total", "totalPrice"])),
      subTotal: displayValueOf(firstDefined(node, ["subTotal", "subtotal"])),
      driverTip: "",
      status: cleanText(displayValueOf(firstDefined(node, ["orderState", "orderStatus", "status"]))),
      fulfillmentTypes: cleanText(firstDefined(node, ["fulfillmentType", "shippingMethod"])),
      items,
    };
  }

  /**
   * Build the CollectResult snapshot from the RSC flight stream.
   * @returns {Object|null} { orderNumbers, additionalFields, orderSummaries, warnings } or null
   */
  function buildSnapshotFromRsc() {
    const warnings = [];
    const text = readNextFlightChunks();
    if (!text) {
      return { empty: true, warnings: ["RSC flight stream (window.__next_f) was empty or unavailable"] };
    }

    const fragments = parseJsonFragments(text);
    const orderNodes = [];
    const seen = new Set();
    fragments.forEach((frag) => deepCollectOrders(frag, orderNodes, seen));

    const orderNumbers = [];
    const additionalFields = {};
    const orderSummaries = {};
    const dedup = new Set();

    orderNodes.forEach((node) => {
      const raw = firstDefined(node, ORDER_NUMBER_KEYS);
      const normalized = normalizeOrderNumber(raw);
      if (!normalized || normalized.length < 6 || dedup.has(normalized)) return;
      dedup.add(normalized);
      orderNumbers.push(normalized);
      additionalFields[normalized] = cleanText(
        firstDefined(node, ["title", "orderDate", "purchaseDate"]) || `Order ${normalized}`
      );
      orderSummaries[normalized] = buildOrderSummaryFromNode(node, normalized);
    });

    if (orderNumbers.length === 0) {
      // Last-resort regex sweep — the deep-walk found nothing order-shaped, but
      // the raw stream may still carry order numbers we can hand to the detail
      // scraper. Very brittle; warn loudly.
      const re = /"order(?:Number|Id|No)"\s*:\s*"?(\d[\d-]{5,})"?/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const normalized = normalizeOrderNumber(m[1]);
        if (normalized && normalized.length >= 6 && !dedup.has(normalized)) {
          dedup.add(normalized);
          orderNumbers.push(normalized);
          additionalFields[normalized] = `Order ${normalized}`;
        }
      }
      if (orderNumbers.length > 0) {
        warnings.push("RSC order objects not found; recovered order numbers via raw text regex only (no summaries)");
      }
    }

    if (orderNumbers.length === 0) {
      return { empty: true, warnings: warnings.concat(["No order nodes or order numbers found in the RSC stream"]) };
    }

    return { orderNumbers, additionalFields, orderSummaries, warnings };
  }

  // ==========================================================================
  // DOM scraping — FALLBACK for the list, and the primary source for the
  // per-order detail scrape (RSC detail paths are even less known than list).
  // ==========================================================================

  function extractOrderNumberFromCard(card) {
    const link = card.querySelector(SELECTORS.ORDER_DETAIL_LINK);
    if (link) {
      const href = link.getAttribute("href") || "";
      const idParam = /[?&]orderId=([\d-]+)/i.exec(href) || /\/(?:order|purchasehistory)\/[^/]*?(\d[\d-]{5,})/i.exec(href);
      if (idParam && normalizeOrderNumber(idParam[1]).length >= 6) {
        return normalizeOrderNumber(idParam[1]);
      }
    }
    const text = cleanText(card.textContent || "");
    const labelled = /order\s*#?\s*[:.]?\s*(\d[\d-]{5,})/i.exec(text);
    if (labelled) return normalizeOrderNumber(labelled[1]);
    return null;
  }

  function buildDomOrderSummary(card, orderNumber) {
    const cardText = cleanText(card.textContent || "");
    const totalMatch =
      cardText.match(/total[^$]{0,20}(\$[\d,]+(?:\.\d{2})?)/i) ||
      cardText.match(/(\$[\d,]+(?:\.\d{2})?)\s*total/i);
    const dateMatch = cardText.match(/\b([A-Z][a-z]{2,8}\.? \d{1,2}, \d{4})\b/);
    const statusKeywords = [
      "Delivered", "Shipped", "Preparing", "Ready for pickup", "Picked up",
      "Canceled", "Cancelled", "Returned", "Refunded", "In transit", "Arriving",
    ];
    const lower = cardText.toLowerCase();
    const status = statusKeywords.find((k) => lower.includes(k.toLowerCase())) || "";

    return {
      source: "dom",
      orderNumber,
      orderDate: dateMatch ? dateMatch[1] : "",
      deliveredDate: "",
      orderType: "",
      isInStore: /in-?store|pickup/i.test(cardText),
      itemCount: (cardText.match(/\b(\d+)\s+items?\b/i) || [])[1] || "",
      orderTotal: totalMatch ? cleanText(totalMatch[1]) : "",
      subTotal: "",
      driverTip: "",
      status,
      fulfillmentTypes: "",
      items: [],
    };
  }

  function extractOrderNumbersFromDom() {
    const orderNumbers = [];
    const additionalFields = {};
    const orderSummaries = {};
    const seen = new Set();

    const cards = Array.from(document.querySelectorAll(SELECTORS.ORDER_CARDS));
    cards.forEach((card, index) => {
      try {
        const orderNumber = extractOrderNumberFromCard(card);
        if (!orderNumber || seen.has(orderNumber)) return;
        seen.add(orderNumber);
        orderNumbers.push(orderNumber);
        additionalFields[orderNumber] = cleanText(
          card.querySelector("h2, h3, [class*='title']")?.textContent || `Order ${orderNumber}`
        );
        orderSummaries[orderNumber] = buildDomOrderSummary(card, orderNumber);
      } catch (e) {
        console.error(`Best Buy: error processing order card ${index}`, e);
      }
    });

    return { orderNumbers, additionalFields, orderSummaries };
  }

  function hasNextPageInDom() {
    const btn = document.querySelector(SELECTORS.NEXT_BUTTON);
    if (!btn) return false;
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
    const rect = btn.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ---- Order-detail scrape (DOM-first; RSC node used to enrich if present) ----

  function findDetailOrderNode() {
    // Reuse the list parser to find the single order whose number matches the URL.
    const urlMatch = /(\d[\d-]{5,})/.exec(window.location.pathname + window.location.search);
    const wantNumber = urlMatch ? normalizeOrderNumber(urlMatch[1]) : "";
    const text = readNextFlightChunks();
    if (!text) return null;
    const fragments = parseJsonFragments(text);
    const nodes = [];
    const seen = new Set();
    fragments.forEach((frag) => deepCollectOrders(frag, nodes, seen));
    if (nodes.length === 0) return null;
    if (wantNumber) {
      const match = nodes.find(
        (n) => normalizeOrderNumber(firstDefined(n, ORDER_NUMBER_KEYS)) === wantNumber
      );
      if (match) return match;
    }
    return nodes[0];
  }

  function itemsFromDetailNode(node) {
    const rawItems =
      (Array.isArray(node.lineItems) && node.lineItems) ||
      (Array.isArray(node.items) && node.items) ||
      (Array.isArray(node.products) && node.products) ||
      [];
    return rawItems.map((it) => ({
      productName: cleanText(firstDefined(it, ["name", "productName", "title", "description"])),
      productLink: toAbsoluteUrl(
        firstDefined(it, ["productUrl", "url", "pdpUrl", "link"]) ||
        (it.sku ? `/site/-/${it.sku}.p` : "")
      ) || "N/A",
      deliveryStatus: cleanText(firstDefined(it, ["status", "lineItemStatus", "itemStatus"])) || CONSTANTS.TEXT.DELIVERY_LABEL,
      quantity: String(firstDefined(it, ["quantity", "qty", "itemQuantity"]) || ""),
      price: displayValueOf(firstDefined(it, ["unitPrice", "price", "linePrice", "totalPrice", "amount"])),
      thumbnailUrl: toAbsoluteUrl(
        firstDefined(it, ["imageUrl", "thumbnailUrl", "image", "imageLink"]) ||
        (it.images && (it.images.thumbnail || it.images[0])) || ""
      ),
    }));
  }

  function itemsFromDetailDom() {
    const rows = Array.from(document.querySelectorAll(SELECTORS.DETAIL_ITEM_ROWS));
    const items = [];
    const seen = new Set();
    rows.forEach((row) => {
      const productName = cleanText(
        row.querySelector("h2, h3, [class*='name'], [class*='title'], a")?.textContent || ""
      );
      const priceText = cleanText(row.textContent || "");
      const price = extractCurrencyValues(priceText)[0] || "";
      const qtyMatch = priceText.match(/qty\s*:?\s*(\d+)/i) || priceText.match(/\bx\s*(\d+)\b/i);
      const link = row.querySelector("a[href]")?.getAttribute("href") || "";
      if (!productName && !price) return;
      const key = `${productName}|${price}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({
        productName,
        productLink: link ? toAbsoluteUrl(link) : "N/A",
        deliveryStatus: CONSTANTS.TEXT.DELIVERY_LABEL,
        quantity: qtyMatch ? qtyMatch[1] : "",
        price,
        thumbnailUrl: toAbsoluteUrl(row.querySelector("img")?.getAttribute("src") || ""),
      });
    });
    return items;
  }

  function scrapeOrderData() {
    const node = findDetailOrderNode();

    let orderNumber =
      (node && normalizeOrderNumber(firstDefined(node, ORDER_NUMBER_KEYS))) || "";
    if (!orderNumber) {
      const urlMatch = /(\d[\d-]{5,})/.exec(window.location.pathname + window.location.search);
      orderNumber = urlMatch ? normalizeOrderNumber(urlMatch[1]) : "";
    }
    if (!orderNumber) {
      const bodyMatch = /order\s*#?\s*[:.]?\s*(\d[\d-]{5,})/i.exec(cleanText(document.body?.textContent || ""));
      orderNumber = bodyMatch ? normalizeOrderNumber(bodyMatch[1]) : "";
    }

    const nodeItems = node ? itemsFromDetailNode(node) : [];
    const items = nodeItems.length > 0 ? nodeItems : itemsFromDetailDom();

    const orderTotal =
      (node && displayValueOf(firstDefined(node, ["orderTotal", "grandTotal", "total", "totalPrice"]))) ||
      (extractCurrencyValues(
        cleanText(
          Array.from(document.querySelectorAll("[class*='total'], [data-testid*='total']"))
            .map((el) => el.textContent)
            .join(" ")
        )
      ).pop() || "");

    const orderSubtotal = node ? displayValueOf(firstDefined(node, ["subTotal", "subtotal"])) : "";
    const tax = node ? displayValueOf(firstDefined(node, ["tax", "taxTotal", "salesTax"])) : "";
    const shipping = node ? displayValueOf(firstDefined(node, ["shipping", "shippingTotal", "deliveryTotal"])) : "";
    const orderDate = node ? cleanText(firstDefined(node, ["orderDate", "purchaseDate", "date"])) : "";

    return {
      schemaVersion: CONSTANTS.ORDER_SCHEMA_VERSION,
      orderNumber: orderNumber || null,
      orderDate,
      orderType: node ? cleanText(firstDefined(node, ["orderType", "type", "fulfillmentType"])) : "",
      isInStore: node
        ? /store|pickup|in-?store/i.test(cleanText(firstDefined(node, ["orderType", "fulfillmentType", "type"])))
        : false,
      orderSubtotal,
      subtotalBeforeSavings: "",
      savings: node ? displayValueOf(firstDefined(node, ["savings", "totalSavings", "discount"])) : "",
      orderTotal,
      deliveryCharges: shipping,
      bagFee: "",
      tax,
      tip: "",
      refund: node ? displayValueOf(firstDefined(node, ["refund", "refundTotal"])) : "",
      donations: "",
      barcodeImageUrl: "",
      sellers: node ? cleanText(firstDefined(node, ["seller", "soldBy", "sellerName"])) : "",
      fulfillmentTypes: node ? cleanText(firstDefined(node, ["fulfillmentType", "shippingMethod"])) : "",
      deliveredDate: node ? cleanText(firstDefined(node, ["deliveredDate", "deliveryDate"])) : "",
      trackingNumbers: node ? cleanText(firstDefined(node, ["trackingNumber", "trackingNumbers"])) : "",
      paymentSplit: "",
      address: node ? cleanText(displayValueOf(firstDefined(node, ["shippingAddress", "address", "deliveryAddress"]))) : "",
      addressRecipient: "",
      addressLine: "",
      deliveryInstructions: "",
      deliveryInstructionsExpanded: false,
      paymentMethods: node ? cleanText(displayValueOf(firstDefined(node, ["paymentMethod", "payment"]))) : "",
      paymentMethodDetails: [],
      paymentMessages: "",
      items,
    };
  }

  function computeExtractionWarnings(data, extra) {
    const warnings = Array.isArray(extra) ? extra.slice() : [];
    try {
      const items = Array.isArray(data?.items) ? data.items : [];
      if (items.length === 0) {
        warnings.push("No items were extracted for this Best Buy order (RSC paths unverified)");
      } else if (items.every((it) => !cleanText(it?.productName || ""))) {
        warnings.push("All extracted items have a blank product name");
      }
      if (!cleanText(data?.orderTotal || "")) {
        warnings.push("Order total came back empty");
      }
      if (!data?.orderNumber) {
        warnings.push("Order number is missing");
      }
      if (!cleanText(data?.orderDate || "")) {
        warnings.push("Order date came back empty");
      }
    } catch (error) {
      console.warn("Best Buy extraction validation failed (ignored):", error);
    }
    return warnings;
  }

  // ==========================================================================
  // Interface methods (see providers/base.js). `ctx` is built by content.js.
  // ==========================================================================

  function initContent(_ctx) {
    // App Router streams the RSC payload into window.__next_f as the page loads;
    // there is nothing to prime or inject here. No fetch/XHR bridge is installed
    // on Best Buy — under Akamia we deliberately do NOT replay or intercept
    // network calls; we only read what the user's own page already rendered.
  }

  async function collectOrderNumbers(ctx) {
    const currentPage = Number((ctx && ctx.currentPage) || 1);
    try {
      if (pageLooksChallenged()) {
        console.warn("Best Buy: page appears challenged/blocked (Akamai). Aborting collection.");
        return { orderNumbers: [], additionalFields: {}, orderSummaries: {}, hasNextPage: false, collectionError: true };
      }

      // Wait — at human pace — for either the RSC stream or the DOM cards.
      const ready = await waitForAny([
        SELECTORS.ORDER_CARDS,
        SELECTORS.ORDER_DETAIL_LINK,
      ]);

      // Re-check for a challenge that may have replaced the page while waiting.
      if (pageLooksChallenged()) {
        return { orderNumbers: [], additionalFields: {}, orderSummaries: {}, hasNextPage: false, collectionError: true };
      }

      // PRIMARY: parse the RSC flight stream.
      const rsc = buildSnapshotFromRsc();
      if (rsc && !rsc.empty && rsc.orderNumbers.length > 0) {
        const hasNextPage = hasNextPageInDom();
        console.log(
          `Best Buy: collected ${rsc.orderNumbers.length} order(s) from RSC on page ${currentPage}. Next page: ${hasNextPage}`
        );
        return {
          orderNumbers: rsc.orderNumbers,
          additionalFields: rsc.additionalFields,
          orderSummaries: rsc.orderSummaries || {},
          hasNextPage,
        };
      }

      // FALLBACK: scrape the DOM order cards.
      const dom = extractOrderNumbersFromDom();
      if (dom.orderNumbers.length > 0) {
        const hasNextPage = hasNextPageInDom();
        console.log(
          `Best Buy: collected ${dom.orderNumbers.length} order(s) from DOM on page ${currentPage}. Next page: ${hasNextPage}`
        );
        return { ...dom, hasNextPage };
      }

      // Nothing found. Distinguish "genuinely empty history" from "not ready /
      // blocked". If the readiness wait timed out with no cards AND no RSC
      // orders, treat a truly empty, non-challenged page as end-of-orders;
      // otherwise report a retryable error.
      if (!ready) {
        // Could not confirm the list rendered — safer to retry than to declare
        // the history empty (a false "endOfOrders" would silently drop orders).
        console.warn("Best Buy: order list did not render within timeout.");
        return { orderNumbers: [], additionalFields: {}, orderSummaries: {}, hasNextPage: false, collectionError: true };
      }

      const bodyText = cleanText(document.body?.textContent || "").toLowerCase();
      const looksEmpty = /no (?:orders|purchases)|haven'?t placed|nothing here/.test(bodyText);
      if (looksEmpty) {
        console.log("Best Buy: purchase history is empty. End of orders.");
        return { orderNumbers: [], additionalFields: {}, orderSummaries: {}, hasNextPage: false, endOfOrders: true };
      }

      return { orderNumbers: [], additionalFields: {}, orderSummaries: {}, hasNextPage: false, collectionError: true };
    } catch (error) {
      console.error("Best Buy: error during collection:", error);
      return { orderNumbers: [], additionalFields: {}, orderSummaries: {}, hasNextPage: false, collectionError: true };
    }
  }

  function scrapeOrder(_ctx) {
    if (pageLooksChallenged()) {
      // Return a minimal, clearly-flagged object rather than partial garbage.
      return {
        schemaVersion: CONSTANTS.ORDER_SCHEMA_VERSION,
        orderNumber: null,
        items: [],
        extractionWarnings: ["Best Buy order page appears challenged/blocked (Akamai) — nothing scraped"],
      };
    }
    let rscWarnings = [];
    let data;
    try {
      data = scrapeOrderData();
    } catch (error) {
      console.error("Best Buy: scrapeOrder failed:", error);
      data = { schemaVersion: CONSTANTS.ORDER_SCHEMA_VERSION, orderNumber: null, items: [] };
      rscWarnings = ["scrapeOrder threw — Best Buy RSC/DOM shape may have changed"];
    }
    data.extractionWarnings = computeExtractionWarnings(data, rscWarnings);
    return data;
  }

  async function clickNextPage(_ctx) {
    try {
      if (pageLooksChallenged()) return { success: false };

      const nextButton = document.querySelector(SELECTORS.NEXT_BUTTON);
      if (!nextButton || nextButton.disabled || nextButton.getAttribute("aria-disabled") === "true") {
        return { success: false };
      }

      // Capture a signature so we can confirm the list actually advanced.
      const signatureBefore = Array.from(document.querySelectorAll(SELECTORS.ORDER_CARDS))
        .slice(0, 3)
        .map((c) => cleanText(c.textContent || "").slice(0, 80))
        .join("|");
      const urlBefore = window.location.href;

      nextButton.scrollIntoView({ block: "center", inline: "center" });
      // Human-paced click: a brief settle before acting.
      await delay(CONSTANTS.TIMING.ELEMENT_POLL_INTERVAL);
      nextButton.click();

      const deadline = Date.now() + CONSTANTS.TIMING.COLLECTION_TIMEOUT;
      while (Date.now() < deadline) {
        if (pageLooksChallenged()) return { success: false };
        const urlNow = window.location.href;
        const signatureNow = Array.from(document.querySelectorAll(SELECTORS.ORDER_CARDS))
          .slice(0, 3)
          .map((c) => cleanText(c.textContent || "").slice(0, 80))
          .join("|");
        if (urlNow !== urlBefore || (signatureNow && signatureNow !== signatureBefore)) {
          return { success: true };
        }
        await delay(CONSTANTS.TIMING.ELEMENT_POLL_INTERVAL);
      }
      console.warn("Best Buy: next-page click did not produce a visible transition");
      return { success: false };
    } catch (error) {
      console.error("Best Buy: error clicking next page:", error);
      return { success: false };
    }
  }

  return {
    id: "BESTBUY",
    label: "Best Buy",
    flag: "provider.bestbuy",
    defaultEnabled: false,
    hostPermissions: ["https://www.bestbuy.com/*"],
    contentMatches: ["https://www.bestbuy.com/purchasehistory/*"],
    ordersListUrl: "https://www.bestbuy.com/purchasehistory/purchases",
    locale: "en-US",
    currency: "USD",
    SELECTORS,
    isOrdersListUrl,
    initContent,
    collectOrderNumbers,
    scrapeOrder,
    clickNextPage,
  };
})();

// Register with the shared registry. registry.js loads before this file in every
// context (importScripts order + content_scripts order + script tags), so
// ProviderRegistry is defined; the guard is belt-and-suspenders.
if (typeof ProviderRegistry !== "undefined" && ProviderRegistry.register) {
  ProviderRegistry.register(BestBuyProvider);
}
