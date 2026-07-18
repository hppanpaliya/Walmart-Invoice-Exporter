/**
 * providers/target.js — Target.com (TARGET) provider adapter.
 *
 * A FETCH-BASED provider. Unlike Walmart (which scrapes server-rendered HTML /
 * __NEXT_DATA__ off each page), Target exposes a clean cookie-session REST API:
 *
 *   GET https://api.target.com/guest_order_aggregations/v1/order_history
 *         ?key=<KEY>&page_number=<n>&page_size=<N>
 *   header: x-api-key: <KEY>
 *
 * `<KEY>` is a PUBLIC web key embedded in every Target page request (it is NOT
 * a captured per-session secret — the same key ships to every guest). We read it
 * from page state when we can find it and fall back to the known literal.
 *
 * Response shape: { metadata, guest_id, total_orders, total_pages, orders, request }.
 * Pagination is PAGE-BASED (page_number / total_pages). Each order carries
 * order_number, placed_date, order_type, order_purchase_type, summary (totals),
 * address (ship-to), and order_lines[] where each line has item + original_quantity.
 * We cover ALL purchase types (online AND in-store) so nothing is skipped.
 *
 * Target sits behind bot protection, so we (a) issue the fetch from the page's
 * OWN main-world context (credentials:'include' + x-api-key) rather than the
 * isolated content world, and (b) throttle pagination.
 *
 * Loadable + safe at load time in every extension context (service worker via
 * importScripts, content script, side panel). Nothing below touches the DOM,
 * window, or network at module load — the content engine only runs when an
 * interface method is invoked, which only ever happens inside a Target page.
 */
const TargetProvider = (() => {
  "use strict";

  // --------------------------------------------------------------------------
  // Config / constants
  // --------------------------------------------------------------------------

  // Public web key embedded in every Target page request. Read from page state
  // when possible (getApiKey); this literal is the known fallback value.
  const FALLBACK_API_KEY = "ff457966e64d5e877fdbad070f276d18ecec4a01";
  const ORDER_HISTORY_ENDPOINT =
    "https://api.target.com/guest_order_aggregations/v1/order_history";
  // Per-order DETAIL endpoint. The order_history LIST is shallow (summary has
  // ONLY grand_total, address is [], items carry no price), so full financials,
  // itemized prices, and the ship-to address MUST be pulled from here.
  const ORDER_DETAIL_ENDPOINT = "https://api.target.com/post_orders/v1/";
  const ORDERS_LIST_URL = "https://www.target.com/orders";
  const PRODUCT_URL_PREFIX = "https://www.target.com/p/-/A-";

  const PAGE_SIZE = 50; // per-page request size; kept modest to be gentle.
  // Bot protection: pace requests so automated pagination is not throttled.
  const PAGE_THROTTLE_MS = 1200;
  const FETCH_TIMEOUT_MS = 20000;
  const MAX_PAGES = 200; // hard safety ceiling; real ceiling is total_pages.

  // 40-hex web key pattern (the shape of FALLBACK_API_KEY), used to sniff the
  // live key out of page scripts/state.
  const API_KEY_RE = /\b([a-f0-9]{40})\b/i;

  // --------------------------------------------------------------------------
  // Small helpers (safe in any context)
  // --------------------------------------------------------------------------

  function cleanText(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  /** True only for the orders LIST page (a detail URL must return false). */
  function isOrdersListUrl(url) {
    return /^https:\/\/www\.target\.com\/orders\/?($|\?)/.test(String(url || ""));
  }

  /** Digits/letters-preserving order-number normalizer (Target numbers can be
   *  long numeric strings; keep them intact rather than stripping non-digits). */
  function normalizeOrderNumber(value) {
    return cleanText(value);
  }

  /**
   * Format a currency-ish value as a USD display string ("$12.34").
   * Target summary amounts arrive as numbers OR as pre-formatted strings OR as
   * { amount, currency } / { value } shaped objects — cover all three.
   */
  function formatUsd(value) {
    if (value == null || value === "") return "";
    if (typeof value === "object") {
      // { amount } / { value } / { display_value } shaped money objects.
      const inner =
        value.display_value != null ? value.display_value
        : value.amount != null ? value.amount
        : value.value != null ? value.value
        : "";
      return formatUsd(inner);
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return "";
      // Already a display string ("$12.34" / "-$1.00").
      if (/\$/.test(trimmed)) return trimmed;
      const num = Number(trimmed.replace(/[^0-9.-]+/g, ""));
      return Number.isFinite(num) ? toUsd(num) : trimmed;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return toUsd(value);
    }
    return "";
  }

  function toUsd(num) {
    const sign = num < 0 ? "-" : "";
    return `${sign}$${Math.abs(num).toFixed(2)}`;
  }

  /**
   * Read the first present value across a list of candidate paths on an object.
   * Each candidate is a dotted path string. Returns "" when none resolve.
   */
  function pick(obj, paths) {
    for (const path of paths) {
      let cur = obj;
      let ok = true;
      for (const key of path.split(".")) {
        if (cur && typeof cur === "object" && key in cur) {
          cur = cur[key];
        } else {
          ok = false;
          break;
        }
      }
      if (ok && cur != null && cur !== "") return cur;
    }
    return "";
  }

  function isInStorePurchase(order) {
    const type = `${order?.order_purchase_type || ""} ${order?.order_type || ""} ${order?.source || ""}`.toLowerCase();
    return /store|in[-_ ]?store|instore|pickup/.test(type);
  }

  // --------------------------------------------------------------------------
  // Content-context: API key discovery + in-page fetch bridge.
  // Everything below runs ONLY inside a Target page.
  // --------------------------------------------------------------------------

  // Cache of fetched order objects (order_number -> raw order) so scrapeOrder
  // can map without re-fetching. Populated by collectOrderNumbers.
  const orderCache = new Map();

  let cachedApiKey = "";

  /**
   * Best-effort read of the public web key from page state. Target embeds it in
   * inline scripts / __TGT_DATA__ / apiKey config. Falls back to the known
   * literal when nothing is found.
   */
  function getApiKey(ctx) {
    if (cachedApiKey) return cachedApiKey;
    try {
      const doc = (ctx && ctx.document) || (typeof document !== "undefined" ? document : null);
      if (doc) {
        // Look for an explicit apiKey/x-api-key assignment first (most precise).
        const scripts = Array.from(doc.querySelectorAll("script"));
        for (const script of scripts) {
          const text = script.textContent || "";
          if (!text) continue;
          const labeled =
            /["']?(?:x-api-key|apiKey|api_key|webKey|web_key)["']?\s*[:=]\s*["']([a-f0-9]{40})["']/i.exec(text);
          if (labeled && labeled[1]) {
            cachedApiKey = labeled[1];
            return cachedApiKey;
          }
        }
        // Otherwise sniff any 40-hex token from the serialized page state.
        const html = doc.documentElement ? doc.documentElement.innerHTML : "";
        const loose = API_KEY_RE.exec(html);
        if (loose && loose[1]) {
          cachedApiKey = loose[1];
          return cachedApiKey;
        }
      }
    } catch (error) {
      console.warn("Target: API key discovery failed, using fallback", error);
    }
    cachedApiKey = FALLBACK_API_KEY;
    return cachedApiKey;
  }

  /**
   * Run a fetch in the page's MAIN-world context (so it carries the page's real
   * fetch, cookies, and headers past bot protection) and resolve the parsed
   * JSON. Falls back to an isolated-world fetch if the bridge is unavailable.
   * @returns {Promise<Object>} parsed JSON response
   */
  function pageFetchJson(ctx, url, headers) {
    const win = (ctx && ctx.window) || (typeof window !== "undefined" ? window : null);
    const doc = (ctx && ctx.document) || (typeof document !== "undefined" ? document : null);

    // Preferred path: inject a one-shot main-world script that performs the
    // fetch with credentials and posts the JSON back. This is the true
    // "page context" request Target's bot protection expects.
    if (win && doc && doc.documentElement) {
      return new Promise((resolve, reject) => {
        const requestId = `wie_tgt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          win.removeEventListener("message", onMessage);
          // Fall back to isolated-world fetch on timeout.
          isolatedFetchJson(url, headers).then(resolve, reject);
        }, FETCH_TIMEOUT_MS);

        function onMessage(event) {
          if (event.source !== win) return;
          const msg = event.data;
          if (!msg || msg.source !== "WIE_TARGET_FETCH_BRIDGE" || msg.requestId !== requestId) {
            return;
          }
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          win.removeEventListener("message", onMessage);
          if (msg.ok && msg.json) {
            resolve(msg.json);
          } else {
            // Bridge reached the network but errored — fall back once.
            isolatedFetchJson(url, headers).then(resolve, reject);
          }
        }

        win.addEventListener("message", onMessage);

        try {
          const script = doc.createElement("script");
          script.textContent = `(() => {
            const SOURCE = "WIE_TARGET_FETCH_BRIDGE";
            const requestId = ${JSON.stringify(requestId)};
            const url = ${JSON.stringify(url)};
            const headers = ${JSON.stringify(headers || {})};
            fetch(url, { method: "GET", credentials: "include", headers })
              .then((response) => response.text().then((text) => {
                let json = null;
                try { json = JSON.parse(text); } catch (_) {}
                window.postMessage({ source: SOURCE, requestId, ok: response.ok && !!json, json }, "*");
              }))
              .catch(() => {
                window.postMessage({ source: SOURCE, requestId, ok: false, json: null }, "*");
              });
          })();`;
          (doc.head || doc.documentElement).appendChild(script);
          script.remove();
        } catch (error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          win.removeEventListener("message", onMessage);
          isolatedFetchJson(url, headers).then(resolve, reject);
        }
      });
    }

    return isolatedFetchJson(url, headers);
  }

  /** Isolated-world fetch fallback (extension host permission supplies cookies). */
  function isolatedFetchJson(url, headers) {
    return fetch(url, { method: "GET", credentials: "include", headers }).then((response) => {
      if (!response.ok) {
        throw new Error(`Target order_history HTTP ${response.status}`);
      }
      return response.json();
    });
  }

  /**
   * Fetch a single page of order history.
   * @returns {Promise<Object>} { orders, total_pages, total_orders, ... }
   */
  async function fetchOrderHistoryPage(ctx, pageNumber, pageSize = PAGE_SIZE) {
    const key = getApiKey(ctx);
    const url =
      `${ORDER_HISTORY_ENDPOINT}?key=${encodeURIComponent(key)}` +
      `&page_number=${pageNumber}&page_size=${pageSize}`;
    return pageFetchJson(ctx, url, { "x-api-key": key });
  }

  /**
   * Fetch the full DETAIL document for a single order. This is the authoritative
   * source for financials, itemized prices, and the ship-to address (the LIST
   * endpoint returns none of those). Same public web key + x-api-key header,
   * issued from the page's own context with credentials.
   *   GET https://api.target.com/post_orders/v1/<order_number>?key=<KEY>
   * @returns {Promise<Object>} parsed detail JSON
   */
  async function fetchOrderDetail(ctx, orderNumber) {
    const key = getApiKey(ctx);
    const url =
      `${ORDER_DETAIL_ENDPOINT}${encodeURIComponent(orderNumber)}` +
      `?key=${encodeURIComponent(key)}`;
    return pageFetchJson(ctx, url, { "x-api-key": key });
  }

  // --------------------------------------------------------------------------
  // Order -> Quick Export summary (matches walmart-us buildOrderSummary keys).
  // --------------------------------------------------------------------------

  function extractItemName(item) {
    return cleanText(
      pick(item, [
        "description",
        "title",
        "short_description",
        "item_description",
        "display_name",
        "name",
      ])
    );
  }

  function extractItemTcin(item) {
    return cleanText(pick(item, ["tcin", "item_id", "id"]));
  }

  function extractItemThumbnail(item) {
    return cleanText(
      pick(item, [
        "images.primary_image_url",
        "images.base_url",
        "enrichment.images.primary_image_url",
        "primary_image_url",
        "image_url",
      ])
    );
  }

  function extractItemPrice(line, item) {
    return formatUsd(
      pick(line, ["summary.total", "summary.grand_total", "effective_price", "unit_price"]) ||
      pick(item, [
        "unit_price",
        "current_retail",
        "price.current_retail",
        "price.reg_retail",
        "effective_price",
      ])
    );
  }

  function buildItems(order) {
    const lines = Array.isArray(order?.order_lines) ? order.order_lines : [];
    const items = [];
    lines.forEach((line) => {
      const item = line?.item || {};
      const productName = extractItemName(item);
      const tcin = extractItemTcin(item);
      const quantity =
        line?.original_quantity != null ? String(line.original_quantity)
        : line?.quantity != null ? String(line.quantity)
        : "";
      const price = extractItemPrice(line, item);
      if (!productName && !quantity && !price) return;

      items.push({
        productName,
        productLink: tcin ? `${PRODUCT_URL_PREFIX}${tcin}` : "N/A",
        deliveryStatus: cleanText(
          pick(line, ["fulfillment_spec.type", "fulfillment.type", "status", "order_line_status"])
        ),
        quantity,
        price,
        thumbnailUrl: extractItemThumbnail(item),
      });
    });
    return items;
  }

  function buildOrderSummary(order, normalizedOrderNumber) {
    const items = buildItems(order);
    const summary = order?.summary || {};
    return {
      source: "network",
      orderNumber: normalizedOrderNumber,
      orderDate: cleanText(order?.placed_date || ""),
      itemCount: items.length || (Array.isArray(order?.order_lines) ? order.order_lines.length : ""),
      orderTotal: formatUsd(pick(summary, ["grand_total", "order_total", "total"])),
      subTotal: formatUsd(pick(summary, ["sub_total", "subtotal"])),
      driverTip: formatUsd(pick(summary, ["tip", "gratuity"])),
      status: cleanText(pick(order, ["order_status", "status"])),
      fulfillmentTypes: cleanText(order?.order_purchase_type || order?.order_type || ""),
      orderType: cleanText(order?.order_type || ""),
      isInStore: isInStorePurchase(order),
      items: items.map((item) => ({
        name: item.productName,
        quantity: item.quantity,
        statusCode: item.deliveryStatus,
        thumbnailUrl: item.thumbnailUrl,
      })),
    };
  }

  // --------------------------------------------------------------------------
  // Order -> normalized order shape (matches walmart-us scrapeOrderData return).
  // --------------------------------------------------------------------------

  function buildAddress(order) {
    return buildAddressFromObject(order?.address);
  }

  /** Normalize a single address object (list `address`, or `addresses[0]` from
   *  the detail response) into { recipient, line, address }. */
  function buildAddressFromObject(addressInput) {
    const address = addressInput && typeof addressInput === "object" ? addressInput : {};
    const recipient = cleanText(
      pick(address, ["name", "full_name"]) ||
      [pick(address, ["first_name"]), pick(address, ["last_name"])].filter(Boolean).join(" ")
    );
    const line = cleanText(
      pick(address, ["address_line1", "address_line_1", "line1"]) &&
        [
          pick(address, ["address_line1", "address_line_1", "line1"]),
          pick(address, ["address_line2", "address_line_2", "line2"]),
          [
            pick(address, ["city"]),
            pick(address, ["state", "region"]),
            pick(address, ["zip_code", "postal_code", "zip"]),
          ]
            .filter(Boolean)
            .join(" "),
        ]
          .filter(Boolean)
          .join(", ")
    );
    const full = cleanText([recipient, line].filter(Boolean).join(", ")) || line || recipient;
    return { recipient, line, address: full };
  }

  function buildPaymentDetails(order) {
    const payments = Array.isArray(order?.payments)
      ? order.payments
      : Array.isArray(order?.summary?.payments)
        ? order.summary.payments
        : [];
    return payments
      .map((payment, index) => ({
        cardId: cleanText(pick(payment, ["payment_id", "id"]) || `target-card-${index}`),
        brand: cleanText(pick(payment, ["card_type", "type", "payment_type", "sub_type"])),
        ending: cleanText(pick(payment, ["card_last4", "last4", "masked_card_number", "display_card_number"])),
        amount: formatUsd(pick(payment, ["amount", "charged_amount", "total"])),
        message: "",
      }))
      .filter((entry) => entry.brand || entry.ending || entry.amount);
  }

  function buildPaymentSplit(paymentMethodDetails) {
    return (paymentMethodDetails || [])
      .map((method) => {
        if (!method.amount) return "";
        const label = [method.brand, method.ending].filter(Boolean).join(" ");
        return label ? `${label}: ${method.amount}` : method.amount;
      })
      .filter(Boolean)
      .join("; ");
  }

  /** Map one raw Target order object into the normalized export shape. */
  function mapOrderToNormalized(order) {
    const orderNumber = normalizeOrderNumber(order?.order_number);
    const summary = order?.summary || {};
    const addressDetails = buildAddress(order);
    const paymentMethodDetails = buildPaymentDetails(order);
    const items = buildItems(order);

    const data = {
      schemaVersion: (typeof CONSTANTS !== "undefined" && CONSTANTS.ORDER_SCHEMA_VERSION) || 1,
      orderNumber,
      orderDate: cleanText(order?.placed_date || ""),
      orderType: cleanText(order?.order_type || order?.order_purchase_type || ""),
      isInStore: isInStorePurchase(order),
      orderSubtotal: formatUsd(pick(summary, ["sub_total", "subtotal"])),
      subtotalBeforeSavings: formatUsd(pick(summary, ["original_sub_total", "pre_savings_sub_total"])),
      savings: formatUsd(pick(summary, ["savings", "total_savings", "discount"])),
      orderTotal: formatUsd(pick(summary, ["grand_total", "order_total", "total"])),
      deliveryCharges: formatUsd(pick(summary, ["shipping", "shipping_total", "delivery", "delivery_charges"])),
      bagFee: formatUsd(pick(summary, ["bag_fee", "bag_fees"])),
      tax: formatUsd(pick(summary, ["tax", "total_tax", "tax_total"])),
      tip: formatUsd(pick(summary, ["tip", "gratuity"])),
      refund: formatUsd(pick(summary, ["refund", "refund_total"])),
      donations: formatUsd(pick(summary, ["donations", "donation"])),
      barcodeImageUrl: "",
      sellers: cleanText(order?.is_market_place ? "Target Plus (Marketplace)" : "Target"),
      fulfillmentTypes: cleanText(order?.order_purchase_type || order?.order_type || ""),
      deliveredDate: cleanText(pick(order, ["delivered_date", "delivery_date"])),
      trackingNumbers: cleanText(
        (Array.isArray(order?.order_lines) ? order.order_lines : [])
          .map((line) => pick(line, ["fulfillment_spec.tracking_number", "tracking_number"]))
          .filter(Boolean)
          .join("; ")
      ),
      paymentSplit: buildPaymentSplit(paymentMethodDetails),
      address: addressDetails.address,
      addressRecipient: addressDetails.recipient,
      addressLine: addressDetails.line,
      deliveryInstructions: cleanText(pick(order, ["delivery_instructions", "instructions"])),
      deliveryInstructionsExpanded: false,
      paymentMethods: paymentMethodDetails
        .map((method) => [method.brand, method.ending].filter(Boolean).join(" - "))
        .filter(Boolean)
        .join("; "),
      paymentMethodDetails,
      paymentMessages: "",
      items,
    };

    data.extractionWarnings = computeExtractionWarnings(data);
    return data;
  }

  // --------------------------------------------------------------------------
  // DETAIL response (post_orders/v1/<order>) -> normalized order shape.
  // This is the authoritative mapping: the LIST is too shallow for financials,
  // itemized prices, or the ship-to address. See docs/adapter-live-verification.
  // --------------------------------------------------------------------------

  /**
   * Extract itemized lines (WITH prices) from a detail response's packages[].
   * The exact package sub-shape was not fully captured live, so we look for line
   * arrays under several likely keys (order_lines / items / lines) and read each
   * line's item + price defensively. Falls back to a bare order_lines[] on the
   * detail root if packages produced nothing.
   */
  function extractDetailItems(detail) {
    const packages = Array.isArray(detail?.packages) ? detail.packages : [];
    const items = [];

    packages.forEach((pkg) => {
      const lines =
        Array.isArray(pkg?.order_lines) ? pkg.order_lines
        : Array.isArray(pkg?.items) ? pkg.items
        : Array.isArray(pkg?.lines) ? pkg.lines
        : [];
      lines.forEach((line) => {
        const item =
          (line && typeof line.item === "object" && line.item) ||
          (line && typeof line.product === "object" && line.product) ||
          line ||
          {};
        const productName = extractItemName(item) || extractItemName(line);
        const tcin = extractItemTcin(item) || extractItemTcin(line);
        const quantity =
          line?.quantity != null ? String(line.quantity)
          : line?.original_quantity != null ? String(line.original_quantity)
          : item?.quantity != null ? String(item.quantity)
          : "";
        const price = extractDetailItemPrice(line, item);
        if (!productName && !quantity && !price) return;

        items.push({
          productName,
          productLink: tcin ? `${PRODUCT_URL_PREFIX}${tcin}` : "N/A",
          deliveryStatus: cleanText(
            pick(line, [
              "fulfillment_spec.status.status",
              "fulfillment_spec.type",
              "fulfillment.type",
              "status",
              "order_line_status",
            ])
          ),
          quantity,
          price,
          thumbnailUrl: extractItemThumbnail(item),
        });
      });
    });

    // Fallback: some detail payloads may still expose a flat order_lines[].
    if (items.length === 0 && Array.isArray(detail?.order_lines)) {
      return buildItems(detail);
    }
    return items;
  }

  /** Price for a detail line — detail carries per-line prices (list does not). */
  function extractDetailItemPrice(line, item) {
    return formatUsd(
      pick(line, [
        "summary.total",
        "summary.grand_total",
        "summary.total_product_price",
        "item_total",
        "total_price",
        "effective_price",
        "unit_price",
        "price",
      ]) ||
      pick(item, [
        "unit_price",
        "current_retail",
        "price.current_retail",
        "price.reg_retail",
        "effective_price",
        "price",
      ])
    );
  }

  /** Sum detail summary.adjustments[].promo_value into a savings display string. */
  function buildSavingsFromAdjustments(summary) {
    const adjustments = Array.isArray(summary?.adjustments) ? summary.adjustments : [];
    let total = 0;
    let found = false;
    adjustments.forEach((adj) => {
      const raw = adj?.promo_value;
      const num =
        typeof raw === "number" ? raw
        : Number(String(raw == null ? "" : raw).replace(/[^0-9.-]+/g, ""));
      if (Number.isFinite(num) && num !== 0) {
        total += Math.abs(num);
        found = true;
      }
    });
    return found ? toUsd(-total) : "";
  }

  /**
   * Map a post_orders DETAIL document into the normalized export shape (same
   * fields walmart-us scrapeOrderData returns). `listOrder` (the shallow order
   * from the history list, if we have it cached) supplements fields the detail
   * doc does not carry (order_type / purchase_type / tracking numbers).
   */
  function mapDetailToNormalized(detail, orderNumberHint, listOrder) {
    const summary = detail?.summary || {};
    const orderNumber = normalizeOrderNumber(
      detail?.order_number || orderNumberHint || listOrder?.order_number || ""
    );
    const addresses = Array.isArray(detail?.addresses) ? detail.addresses : [];
    const addressDetails = buildAddressFromObject(addresses[0]);
    const paymentMethodDetails = buildPaymentDetails(detail);
    const items = extractDetailItems(detail);

    const orderType = cleanText(
      detail?.order_type ||
        detail?.order_purchase_type ||
        listOrder?.order_type ||
        listOrder?.order_purchase_type ||
        ""
    );
    const fulfillmentTypes = cleanText(
      detail?.order_purchase_type ||
        detail?.order_type ||
        listOrder?.order_purchase_type ||
        listOrder?.order_type ||
        ""
    );
    const inStoreSource = detail?.order_purchase_type || detail?.order_type
      ? detail
      : listOrder || detail;

    const trackingNumbers = cleanText(
      []
        .concat(
          (Array.isArray(detail?.packages) ? detail.packages : []).map((pkg) =>
            pick(pkg, ["tracking_number", "status.tracking_number"])
          )
        )
        .concat(
          (Array.isArray(listOrder?.order_lines) ? listOrder.order_lines : []).map((line) =>
            pick(line, ["fulfillment_spec.status.tracking_number", "fulfillment_spec.tracking_number", "tracking_number"])
          )
        )
        .filter(Boolean)
        .join("; ")
    );

    const data = {
      schemaVersion: (typeof CONSTANTS !== "undefined" && CONSTANTS.ORDER_SCHEMA_VERSION) || 1,
      orderNumber,
      orderDate: cleanText(detail?.order_date || listOrder?.placed_date || ""),
      orderType,
      isInStore: isInStorePurchase(inStoreSource),
      orderSubtotal: formatUsd(
        pick(summary, ["total_product_price", "sub_total", "subtotal"])
      ),
      subtotalBeforeSavings: formatUsd(
        pick(summary, ["original_sub_total", "pre_savings_sub_total"])
      ),
      savings:
        buildSavingsFromAdjustments(summary) ||
        formatUsd(pick(summary, ["savings", "total_savings", "discount"])),
      orderTotal: formatUsd(pick(summary, ["grand_total", "order_total", "total"])),
      deliveryCharges: formatUsd(
        pick(summary, ["total_shipping_charges", "shipping", "shipping_total", "delivery"])
      ),
      // Detail exposes a handling_fee; the normalized shape's only generic fee
      // slot is bagFee, so handling maps there (flagged for live confirmation).
      bagFee: formatUsd(pick(summary, ["handling_fee", "bag_fee", "bag_fees"])),
      tax: formatUsd(pick(summary, ["total_taxes", "tax", "total_tax", "tax_total"])),
      tip: formatUsd(pick(summary, ["tip", "gratuity"])),
      refund: formatUsd(pick(summary, ["refund", "refund_total"])),
      donations: formatUsd(pick(summary, ["donations", "donation"])),
      barcodeImageUrl: "",
      sellers: cleanText(detail?.is_market_place ? "Target Plus (Marketplace)" : "Target"),
      fulfillmentTypes,
      deliveredDate: cleanText(pick(detail, ["delivered_date", "delivery_date"])),
      trackingNumbers,
      paymentSplit: buildPaymentSplit(paymentMethodDetails),
      address: addressDetails.address,
      addressRecipient: addressDetails.recipient,
      addressLine: addressDetails.line,
      deliveryInstructions: cleanText(pick(detail, ["delivery_instructions", "instructions"])),
      deliveryInstructionsExpanded: false,
      paymentMethods: paymentMethodDetails
        .map((method) => [method.brand, method.ending].filter(Boolean).join(" - "))
        .filter(Boolean)
        .join("; "),
      paymentMethodDetails,
      paymentMessages: "",
      // total_items is the authoritative count from the detail summary.
      itemCount:
        summary?.total_items != null ? String(summary.total_items) : String(items.length),
      items,
    };

    data.extractionWarnings = computeExtractionWarnings(data);
    return data;
  }

  /**
   * Best-effort validation identical in spirit to walmart-us: flag empty
   * expected fields so a Target API change is visible downstream.
   */
  function computeExtractionWarnings(data) {
    const warnings = [];
    try {
      const items = Array.isArray(data?.items) ? data.items : [];
      if (items.length === 0) {
        warnings.push("No items were extracted for this order");
      } else if (items.every((item) => !cleanText(item?.productName || ""))) {
        warnings.push("All extracted items have a blank product name");
      }
      if (!cleanText(data?.orderTotal || "")) {
        warnings.push("Order total came back empty");
      }
      if (!cleanText(data?.orderNumber || "")) {
        warnings.push("Order number is missing");
      }
      if (!cleanText(data?.orderDate || "")) {
        warnings.push("Order date came back empty");
      }
      if (!cleanText(data?.address || "")) {
        warnings.push("Ship-to address came back empty");
      }
    } catch (error) {
      console.warn("Target extraction validation failed (ignored):", error);
    }
    return warnings;
  }

  // --------------------------------------------------------------------------
  // Interface methods (see providers/base.js). `ctx` is built by content.js.
  // --------------------------------------------------------------------------

  /** Nothing to prime for a fetch-based provider; kept for interface parity. */
  function initContent(ctx) {
    // No page snapshot to seed and no fetch/XHR bridge to install: Target data
    // is pulled on demand in collectOrderNumbers via the page-context fetch.
  }

  /**
   * Collect order numbers + Quick Export summaries for ONE list page.
   * ctx.currentPage (1-based) selects the API page_number. Returns hasNextPage
   * from the API's total_pages so the background loop paginates ALL pages;
   * clickNextPage below merely advances the counter (no DOM). Raw order objects
   * are cached for scrapeOrder.
   * @returns {Promise<CollectResult>}
   */
  async function collectOrderNumbers(ctx) {
    const currentPage = Number((ctx && ctx.currentPage) || 1);

    // Throttle non-first pages to stay under Target bot protection.
    if (currentPage > 1 && typeof delay === "function") {
      await delay(PAGE_THROTTLE_MS);
    }

    try {
      const payload = await fetchOrderHistoryPage(ctx, currentPage);
      const orders = Array.isArray(payload?.orders) ? payload.orders : [];
      const totalPages = Number(payload?.total_pages || 0);

      const orderNumbers = [];
      const additionalFields = {};
      const orderSummaries = {};
      const seen = new Set();

      orders.forEach((order) => {
        const orderNumber = normalizeOrderNumber(order?.order_number);
        if (!orderNumber || seen.has(orderNumber)) return;
        seen.add(orderNumber);
        orderNumbers.push(orderNumber);
        orderCache.set(orderNumber, order);

        additionalFields[orderNumber] = cleanText(
          `${order?.placed_date || ""} ${order?.order_purchase_type || order?.order_type || ""}`.trim()
        );
        orderSummaries[orderNumber] = buildOrderSummary(order, orderNumber);
      });

      // Page-based pagination: another page follows while we are below
      // total_pages AND this page actually returned rows.
      const hasNextPage =
        orderNumbers.length > 0 &&
        currentPage < Math.min(totalPages || currentPage, MAX_PAGES);

      // A genuinely empty first page = no order history at all.
      if (orderNumbers.length === 0 && currentPage <= 1) {
        return {
          orderNumbers: [],
          additionalFields: {},
          orderSummaries: {},
          hasNextPage: false,
          endOfOrders: true,
        };
      }

      return { orderNumbers, additionalFields, orderSummaries, hasNextPage };
    } catch (error) {
      console.error("Target: order_history collection failed:", error);
      // Transient/network/bot-protection failure — let the loop retry.
      return {
        orderNumbers: [],
        additionalFields: {},
        orderSummaries: {},
        hasNextPage: false,
        collectionError: true,
      };
    }
  }

  /**
   * Scrape one order into the normalized shape. Fetch-based: no DOM.
   *
   * The order-history LIST is shallow (only grand_total; empty address; no item
   * prices), so this MUST fetch the per-order DETAIL document
   * (post_orders/v1/<order_number>) and map financials, itemized prices, and the
   * ship-to address from there. The cached list order (if any) only supplements
   * fields the detail doc omits (order_type / purchase_type / tracking).
   * @returns {Promise<Object>} normalized order
   */
  function scrapeOrder(ctx) {
    const fromUrl = resolveOrderNumberFromCtx(ctx);

    return (async () => {
      let listOrder =
        fromUrl && orderCache.has(fromUrl) ? orderCache.get(fromUrl) : null;
      let orderNumber = fromUrl || (listOrder ? normalizeOrderNumber(listOrder.order_number) : "");

      // Primary + authoritative: fetch the DETAIL document and map from it.
      if (orderNumber) {
        try {
          const detail = await fetchOrderDetail(ctx, orderNumber);
          if (detail && typeof detail === "object" && !detail.errors && !detail.error) {
            return mapDetailToNormalized(detail, orderNumber, listOrder);
          }
        } catch (error) {
          console.error("Target: order detail fetch failed:", error);
        }
      }

      // Detail unavailable and we have no cached list order (e.g. a fresh tab
      // opened straight to a detail URL): locate the shallow list order so we can
      // at least return a degraded, price-less shell — and retry the detail once
      // we have confirmed the order number.
      if (!listOrder && orderNumber) {
        try {
          for (let page = 1; page <= MAX_PAGES; page++) {
            if (page > 1 && typeof delay === "function") await delay(PAGE_THROTTLE_MS);
            const payload = await fetchOrderHistoryPage(ctx, page);
            const orders = Array.isArray(payload?.orders) ? payload.orders : [];
            const match = orders.find(
              (order) => normalizeOrderNumber(order?.order_number) === orderNumber
            );
            if (match) {
              listOrder = match;
              orderCache.set(orderNumber, match);
              break;
            }
            const totalPages = Number(payload?.total_pages || 0);
            if (orders.length === 0 || page >= Math.min(totalPages || page, MAX_PAGES)) break;
          }
        } catch (error) {
          console.error("Target: scrapeOrder list re-fetch failed:", error);
        }

        if (listOrder) {
          try {
            const detail = await fetchOrderDetail(ctx, orderNumber);
            if (detail && typeof detail === "object" && !detail.errors && !detail.error) {
              return mapDetailToNormalized(detail, orderNumber, listOrder);
            }
          } catch (error) {
            console.error("Target: order detail retry failed:", error);
          }
        }
      }

      // Last resort — degraded shell from the shallow list order (no item prices,
      // no financial breakdown); extractionWarnings will flag the gaps.
      if (listOrder) return mapOrderToNormalized(listOrder);
      return mapOrderToNormalized({ order_number: orderNumber });
    })();
  }

  function resolveOrderNumberFromCtx(ctx) {
    const loc = (ctx && ctx.location) || (typeof location !== "undefined" ? location : null);
    const href = (loc && (loc.href || String(loc))) || "";
    // Target order detail URLs look like https://www.target.com/orders/<number>.
    const match = /\/orders\/([^/?#]+)/.exec(String(href));
    return match ? normalizeOrderNumber(decodeURIComponent(match[1])) : "";
  }

  /**
   * Advance the list to the next page. Fetch-based provider: pagination is
   * driven by page_number in collectOrderNumbers, so this just resolves
   * success without touching the DOM. The background loop increments
   * currentPage and re-invokes collectOrderNumbers.
   * @returns {Promise<{success: boolean}>}
   */
  async function clickNextPage(ctx) {
    return { success: true };
  }

  return {
    id: "TARGET",
    label: "Target",
    flag: "provider.target",
    defaultEnabled: false,
    hostPermissions: ["https://www.target.com/*", "https://api.target.com/*"],
    contentMatches: ["https://www.target.com/orders*"],
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
// every context (importScripts order + content_scripts order + script tags),
// so ProviderRegistry is defined; the guard is a belt-and-suspenders no-op.
if (typeof ProviderRegistry !== "undefined" && ProviderRegistry.register) {
  ProviderRegistry.register(TargetProvider);
}
