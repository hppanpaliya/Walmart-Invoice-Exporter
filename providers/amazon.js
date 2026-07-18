/**
 * providers/amazon.js — Amazon.com (AMAZON) provider adapter.
 *
 * The HARDEST provider in the fleet. Unlike every other adapter, Amazon exposes
 * NO JSON order API and NO __NEXT_DATA__ / embedded state blob — order history
 * is plain server-rendered HTML. So this adapter is a DOM scraper end to end.
 *
 * Two things make it materially harder than Walmart:
 *
 *   1. COMPLETENESS ACROSS FILTERED VIEWS. Amazon does not present one flat
 *      order list. It splits orders into SEPARATE filtered views that never
 *      appear together: one per year (orderFilter=year-YYYY), a distinct DIGITAL
 *      orders view (orderFilter=digital), and — for some accounts — Amazon
 *      Business. Iterating only the default "past 3 months" view (or even a
 *      single year) silently drops most of a customer's history. To cover
 *      everything WITHOUT changing the shared background loop (which knows only
 *      about "pages" and a next-page control), this adapter VIRTUALISES every
 *      filtered view + its index-paged sub-pages into ONE long logical stream.
 *      hasNextPage stays true until the last sub-page of the last view; each
 *      clickNextPage step walks to the next sub-page, then rolls over to the
 *      next view. See the AmazonPager state machine below.
 *
 *   2. PAGINATION IS A FULL NAVIGATION. Amazon's `.a-pagination` "Next" is a
 *      real <a href="...startIndex=N"> — clicking it unloads the page and tears
 *      down the content script, which does NOT fit the shared click-then-collect
 *      loop (the CLICK_NEXT_BUTTON response would never arrive). Instead,
 *      clickNextPage fetches the next view/sub-page HTML with a SAME-ORIGIN,
 *      cookie-authenticated in-page fetch (the user's own session — no token
 *      capture, no navigation), parses it with DOMParser, and stashes the parsed
 *      Document. The next collectOrderNumbers reads that stashed Document instead
 *      of live `document`. The tab never leaves the orders list, so the content
 *      script — and the pager state on `window` — survive the whole crawl.
 *      This is the "paginate purely via in-page fetch, resolve {success:true}
 *      without touching the DOM" path base.js explicitly allows.
 *
 * Load-safe in every context (service worker importScripts, content script, side
 * panel): nothing below touches the DOM at module load. The DOM/fetch engine
 * only runs inside the interface methods, which the engine only ever calls in a
 * page. No dependency on Walmart's global CONSTANTS — all timings/regex are
 * local so the file is self-contained wherever it is imported.
 *
 * NOTE ON ORDER NUMBERS: base.js documents Walmart's "digits-only" order
 * numbers, but Amazon order ids are NOT digits — they are dashed strings like
 * `112-1234567-1234567` and digital ids begin with `D` (`D01-...`). Stripping
 * non-digits would corrupt the id AND break the detail-page `orderID=` lookup,
 * so this adapter preserves the NATIVE Amazon id string as the order number /
 * OrderDb key. (Integration note (3) in the delivery covers the detail-URL glue
 * this implies.)
 */
const AmazonProvider = (() => {
  "use strict";

  // ---- local config (no reliance on Walmart CONSTANTS) ---------------------
  const LIST_BASE = "https://www.amazon.com/your-orders/orders";
  // Amazon serves the same list at the legacy path too; both are "list" URLs.
  const LIST_PATHS = ["/your-orders/orders", "/gp/css/order-history"];
  const DEFAULT_PAGE_SIZE = 10; // Amazon default; real value is read from the "next" href.

  const TIMING = {
    COLLECTION_TIMEOUT: 10000,
    ELEMENT_POLL_INTERVAL: 200,
    // Human-paced gap before an in-page pagination fetch — never hammer.
    PAGE_FETCH_DELAY: 1200,
  };

  // Amazon order id: 3-7-7 digits, optionally prefixed with a letter (D = digital).
  const ORDER_ID_REGEX = /\b([A-Z]?\d{3}-\d{7}-\d{7})\b/;

  // ---- brittle selectors (see delivered brittle-selector list) -------------
  const SELECTORS = {
    // Order cards on a list page. Modern + a couple of legacy fallbacks.
    ORDER_CARDS: ".order-card.js-order-card, .order-card, .a-box-group.order, .js-order-card",
    ORDER_ID: ".yohtmlc-order-id, [class*='order-id']",
    ORDER_ID_BDI: "bdi",
    // Pagination: <ul class="a-pagination"> ... <li class="a-last"><a href>.
    PAGINATION: ".a-pagination, .a-pagination-container",
    PAGINATION_NEXT: ".a-pagination li.a-last:not(.a-disabled) a, ul.a-pagination li.a-last:not(.a-disabled) a",
    // Year / filter dropdown that drives orderFilter=…
    TIME_FILTER: "#time-filter, select[name='timeFilter'], select[name='orderFilter']",
    TIME_FILTER_OPTION: "option",
    // Per-card product rows / links.
    ITEM_ROW: ".yohtmlc-item, .a-fixed-left-grid, .item-box, [class*='item-view']",
    PRODUCT_LINK: "a.a-link-normal[href*='/gp/product/'], a.a-link-normal[href*='/dp/'], a.a-link-normal[href*='/product/']",
    DETAIL_LINK: "a[href*='order-details'], a[href*='orderID='], a[href*='print.html']",
    // Detail / print page hooks.
    DETAIL_ITEM: ".a-link-normal[href*='/gp/product/'], .a-link-normal[href*='/dp/'], .yohtmlc-item",
    MAIN_HEADING: "h1, #ordersContainer h1",
  };

  // ==========================================================================
  // Pure helpers (safe in any context; only string work).
  // ==========================================================================

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function extractCurrencyValues(value) {
    if (!value) return [];
    const matches = String(value).match(/-?\$[\d,]+(?:\.\d{2})?/g);
    return matches ? matches.map((m) => cleanText(m)) : [];
  }

  function getParam(url, name) {
    try {
      return new URL(url, "https://www.amazon.com").searchParams.get(name) || "";
    } catch (_) {
      const m = String(url || "").match(new RegExp("[?&]" + name + "=([^&#]+)"));
      return m ? decodeURIComponent(m[1]) : "";
    }
  }

  function isAmazonHost(url) {
    try {
      return /(^|\.)amazon\.com$/i.test(new URL(url).hostname);
    } catch (_) {
      return false;
    }
  }

  function pathOf(url) {
    try {
      return new URL(url, "https://www.amazon.com").pathname;
    } catch (_) {
      return "";
    }
  }

  /** The orders LIST page — matches every filter/startIndex variant, but NOT an
   *  order-detail or print page (those carry orderID= and a detail path). */
  function isOrdersListUrl(url) {
    if (!isAmazonHost(url)) return false;
    const path = pathOf(url).replace(/\/+$/, "");
    if (/order-details|summary\/print|css\/summary/.test(pathOf(url))) return false;
    return LIST_PATHS.some((p) => path === p.replace(/\/+$/, ""));
  }

  /** Absolute list URL for a given filter + startIndex. */
  function buildListUrl(filter, startIndex) {
    const u = new URL(LIST_BASE);
    if (filter) u.searchParams.set("orderFilter", filter);
    if (startIndex) u.searchParams.set("startIndex", String(startIndex));
    return u.href;
  }

  // Marker query param carrying the target order id on a detail-scrape tab.
  const DETAIL_PARAM = "wieOrderID";

  /** The printable invoice page for a (physical) order id. */
  function printInvoiceUrl(orderNumber) {
    return `https://www.amazon.com/gp/css/summary/print.html?orderID=${encodeURIComponent(orderNumber)}`;
  }

  /** The printable summary page for a DIGITAL (D…) order id. */
  function digitalSummaryUrl(orderNumber) {
    return `https://www.amazon.com/gp/digital/your-account/order-summary.html?orderID=${encodeURIComponent(orderNumber)}&print=1`;
  }

  /**
   * Detail URL for an order id — used by integration glue (the side panel's
   * download flow navigates its worker tab here and sends GET_ORDER_DATA).
   *
   * NOT the print page itself: /gp/css/summary/print.html is outside this
   * extension's content-script matches, so a tab navigated there has NO
   * message listener and every GET_ORDER_DATA would die with "Receiving end
   * does not exist". Instead the tab opens the orders LIST (which IS covered)
   * with the target id as a marker param; scrapeOrder sees the marker and
   * fetches + parses the print page in-page with the user's own cookie
   * session — the same same-origin fetch technique pagination already uses.
   */
  function orderDetailUrl(orderNumber) {
    const id = cleanText(orderNumber);
    if (!id) return "";
    const u = new URL(LIST_BASE);
    u.searchParams.set(DETAIL_PARAM, id);
    return u.href;
  }

  // ==========================================================================
  // Content-context engine — runs ONLY inside an Amazon page.
  // ==========================================================================

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitForAny(selectors, timeout = TIMING.COLLECTION_TIMEOUT, poll = TIMING.ELEMENT_POLL_INTERVAL) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const sel of selectors) {
        if (document.querySelector(sel)) return document.querySelector(sel);
      }
      await delay(poll);
    }
    throw new Error(`None of the selectors matched after ${timeout}ms: ${selectors.join(", ")}`);
  }

  /**
   * AmazonPager — the virtual "one long list" over all filtered views.
   * State lives on `window` so it survives across collectOrderNumbers /
   * clickNextPage calls within the same (never-navigated) content-script page.
   */
  const AmazonPager = {
    key: "__wieAmazonPagerState",

    state() {
      if (!window[this.key]) {
        window[this.key] = {
          initialized: false,
          views: [], // ordered [{ filter }] — years desc, then digital, then business
          viewIdx: -1, // -1 = the live/default document Amazon first loaded
          startIndex: 0, // startIndex within the CURRENT view
          pendingDoc: null, // Document stashed by clickNextPage for the next collect
          lastNextHref: null, // in-view next-page href from the last parsed doc
        };
      }
      return window[this.key];
    },

    /** Discover the filtered views from the live document's time-filter dropdown. */
    init(rootDoc) {
      const st = this.state();
      if (st.initialized) return st;

      const views = [];
      const seen = new Set();
      const pushView = (filter) => {
        if (filter && !seen.has(filter)) {
          seen.add(filter);
          views.push({ filter });
        }
      };

      // Year views from the dropdown, e.g. option value "year-2024".
      try {
        const select = rootDoc.querySelector(SELECTORS.TIME_FILTER);
        const options = select ? Array.from(select.querySelectorAll(SELECTORS.TIME_FILTER_OPTION)) : [];
        const years = options
          .map((o) => cleanText(o.value || o.getAttribute("value")))
          .filter((v) => /^year-\d{4}$/.test(v))
          .sort()
          .reverse();
        years.forEach(pushView);

        // If the dropdown could not be read, fall back to a spread of recent
        // years so a crawl still covers history rather than only the default view.
        if (years.length === 0) {
          const nowYear = new Date().getFullYear();
          for (let y = nowYear; y >= nowYear - 6; y--) pushView(`year-${y}`);
        }
      } catch (_) {
        /* dropdown shape changed — the year fallback above still applies next run */
      }

      // Digital orders are a SEPARATE filtered view that never shows in the
      // year lists — must be visited explicitly or digital purchases are missed.
      pushView("digital");

      // Amazon Business (only present on business accounts): detect a tab/link.
      try {
        const hasBusiness =
          rootDoc.querySelector("a[href*='orderFilter=business'], a[href*='/business/'], [data-a-target*='business']") ||
          /amazon business/i.test(rootDoc.body ? rootDoc.body.textContent.slice(0, 4000) : "");
        if (hasBusiness) pushView("business");
      } catch (_) {}

      st.views = views;
      st.initialized = true;
      return st;
    },

    /** Compute the next (viewIdx, startIndex, url) target, or null when done. */
    nextTarget(currentDoc) {
      const st = this.state();

      // 1) Try the next sub-page WITHIN the current view via its pagination link.
      //    (Skip in-view paging while still on the live/default doc: viewIdx -1
      //    jumps straight into views[0]; year views cover that history anyway.)
      if (st.viewIdx >= 0) {
        const nextLink = currentDoc.querySelector(SELECTORS.PAGINATION_NEXT);
        const href = nextLink ? nextLink.getAttribute("href") : "";
        if (href) {
          const nextStart = Number(getParam(href, "startIndex")) || st.startIndex + DEFAULT_PAGE_SIZE;
          const view = st.views[st.viewIdx];
          return {
            viewIdx: st.viewIdx,
            startIndex: nextStart,
            url: buildListUrl(view ? view.filter : "", nextStart),
          };
        }
      }

      // 2) Roll over to the next view.
      const nextIdx = st.viewIdx + 1;
      if (nextIdx < st.views.length) {
        return {
          viewIdx: nextIdx,
          startIndex: 0,
          url: buildListUrl(st.views[nextIdx].filter, 0),
        };
      }

      // 3) Nothing left.
      return null;
    },

    hasNext(currentDoc) {
      return this.nextTarget(currentDoc) !== null;
    },
  };

  /** Parse the order id out of one order card. Preserves the native dashed id. */
  function orderIdFromCard(card) {
    // Preferred: dedicated order-id node with a <bdi>.
    const idNode = card.querySelector(SELECTORS.ORDER_ID);
    if (idNode) {
      const bdi = idNode.querySelector(SELECTORS.ORDER_ID_BDI);
      const idText = cleanText((bdi || idNode).textContent);
      const m = idText.match(ORDER_ID_REGEX);
      if (m) return m[1];
      if (idText) return idText;
    }
    // Any bdi in the card (Amazon wraps ids in <bdi dir="ltr">).
    const anyBdi = Array.from(card.querySelectorAll("bdi"))
      .map((b) => cleanText(b.textContent))
      .find((t) => ORDER_ID_REGEX.test(t));
    if (anyBdi) return anyBdi.match(ORDER_ID_REGEX)[1];
    // A detail/print link with orderID= in it.
    const link = card.querySelector(SELECTORS.DETAIL_LINK);
    const fromHref = link ? getParam(link.getAttribute("href"), "orderID") : "";
    if (fromHref) return fromHref;
    // Last resort: scan the whole card's text.
    const m = cleanText(card.textContent).match(ORDER_ID_REGEX);
    return m ? m[1] : "";
  }

  /** Header value keyed by an adjacent label (ORDER PLACED / TOTAL / SHIP TO). */
  function cardHeaderValue(card, labelRegex) {
    const cols = Array.from(card.querySelectorAll(".a-column, .a-row, .order-header .a-column, span, div"));
    for (const col of cols) {
      const text = cleanText(col.textContent);
      if (!labelRegex.test(text)) continue;
      // The value is usually the last line after the label word.
      const cleaned = text.replace(labelRegex, "").trim();
      if (cleaned) return cleaned;
    }
    return "";
  }

  /** Best-effort Quick Export summary from a single card's visible text. */
  function buildCardSummary(card, orderNumber) {
    const cardText = cleanText(card.textContent);

    const dateRaw = cardHeaderValue(card, /order placed/i);
    const dateMatch = (dateRaw || cardText).match(/\b([A-Z][a-z]{2,8}\.? \d{1,2},? \d{4})\b/);

    const totalRaw = cardHeaderValue(card, /total/i);
    const total = extractCurrencyValues(totalRaw)[0] || extractCurrencyValues(cardText)[0] || "";

    const statusKeywords = [
      "Delivered", "Arriving", "Shipped", "Out for delivery", "Preparing", "Ordered",
      "Cancelled", "Canceled", "Return", "Refunded", "Not yet shipped",
    ];
    const lower = cardText.toLowerCase();
    const status = statusKeywords.find((k) => lower.includes(k.toLowerCase())) || "";

    const items = [];
    card.querySelectorAll(SELECTORS.PRODUCT_LINK).forEach((a) => {
      const name = cleanText(a.textContent);
      if (name) {
        items.push({ name, quantity: "", statusCode: "", thumbnailUrl: "" });
      }
    });

    return {
      source: "dom",
      orderNumber,
      orderDate: dateMatch ? dateMatch[1] : "",
      deliveredDate: "",
      orderType: /^D/.test(orderNumber) ? "digital" : "",
      isInStore: false,
      itemCount: items.length || "",
      orderTotal: total,
      subTotal: "",
      driverTip: "",
      status,
      fulfillmentTypes: "",
      items,
    };
  }

  /** Scrape all order cards in a Document into the CollectResult pieces. */
  function extractOrdersFromDoc(doc) {
    const orderNumbers = [];
    const additionalFields = {};
    const orderSummaries = {};
    const seen = new Set();

    const cards = Array.from(doc.querySelectorAll(SELECTORS.ORDER_CARDS));
    cards.forEach((card) => {
      try {
        const orderNumber = orderIdFromCard(card);
        if (!orderNumber || seen.has(orderNumber)) return;
        seen.add(orderNumber);
        orderNumbers.push(orderNumber);
        // Title: order date + first item name, whatever is available.
        const summary = buildCardSummary(card, orderNumber);
        additionalFields[orderNumber] = cleanText(
          [summary.orderDate, summary.items[0] && summary.items[0].name].filter(Boolean).join(" — ")
        );
        orderSummaries[orderNumber] = summary;
      } catch (_) {
        /* skip a malformed card, keep the rest */
      }
    });

    return { orderNumbers, additionalFields, orderSummaries };
  }

  /**
   * Fetch a list URL in-page with the user's own cookie session and parse it.
   * Same-origin GET, no token capture, no navigation.
   */
  async function fetchListDoc(url) {
    const res = await window.fetch(url, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "text/html" },
    });
    if (!res.ok) {
      throw new Error(`Amazon list fetch failed: ${res.status}`);
    }
    const html = await res.text();
    return new DOMParser().parseFromString(html, "text/html");
  }

  // ---- interface methods ---------------------------------------------------

  function initContent(_ctx) {
    // Nothing to prime — no bridge, no page JSON. Pager initialises lazily on
    // the first collectOrderNumbers so it reads the fully-hydrated dropdown.
  }

  async function collectOrderNumbers(ctx) {
    const currentPage = (ctx && ctx.currentPage) || 1;
    try {
      // Ensure a list is actually present (empty history throws → endOfOrders).
      if (!AmazonPager.state().pendingDoc) {
        await waitForAny([SELECTORS.ORDER_CARDS, SELECTORS.MAIN_HEADING, SELECTORS.TIME_FILTER]);
      }

      const pager = AmazonPager.state();
      // pendingDoc: the page clickNextPage just fetched. lastDoc: the page of
      // the PREVIOUS collect — used when the background loop retries a page
      // after a failed clickNextPage, so a retry re-reads the page the crawl
      // is actually on instead of falling back to the original live document
      // (which would silently rewind the pager to view/page 1).
      const doc = pager.pendingDoc || pager.lastDoc || document;
      pager.pendingDoc = null;

      // Discover the filtered views on the first page from the live dropdown.
      if (currentPage <= 1 && !pager.initialized) {
        AmazonPager.init(document);
      }

      const { orderNumbers, additionalFields, orderSummaries } = extractOrdersFromDoc(doc);
      const hasNextPage = AmazonPager.hasNext(doc);

      // Remember the doc so clickNextPage can read its in-view pagination link.
      pager.lastDoc = doc;

      if (orderNumbers.length === 0 && !hasNextPage) {
        // A genuinely empty final view — treat as end-of-orders, not an error.
        return { orderNumbers: [], additionalFields: {}, orderSummaries: {}, hasNextPage: false, endOfOrders: true };
      }

      return { orderNumbers, additionalFields, orderSummaries, hasNextPage };
    } catch (error) {
      const msg = String(error && error.message);
      if (msg.includes("None of the selectors matched")) {
        // No cards, no heading, no filter → empty history, stop cleanly.
        return { orderNumbers: [], additionalFields: {}, orderSummaries: {}, hasNextPage: false, endOfOrders: true };
      }
      console.error("Amazon collectOrderNumbers error:", error);
      return { orderNumbers: [], additionalFields: {}, orderSummaries: {}, hasNextPage: false, collectionError: true };
    }
  }

  async function clickNextPage(_ctx) {
    try {
      const pager = AmazonPager.state();
      const doc = pager.lastDoc || document;
      const target = AmazonPager.nextTarget(doc);
      if (!target) {
        return { success: false };
      }

      // Human pace — never hammer Amazon.
      await delay(TIMING.PAGE_FETCH_DELAY);

      const nextDoc = await fetchListDoc(target.url);

      // Commit the cursor and stash the parsed doc for the next collect call.
      pager.viewIdx = target.viewIdx;
      pager.startIndex = target.startIndex;
      pager.pendingDoc = nextDoc;
      pager.lastDoc = nextDoc;
      return { success: true };
    } catch (error) {
      console.error("Amazon clickNextPage error:", error);
      return { success: false };
    }
  }

  // ---- order detail scrape -------------------------------------------------

  function scrapeOrderData(doc, pageHref) {
    doc = doc || document;
    pageHref = pageHref || (typeof window !== "undefined" ? window.location.href : "");
    const orderNumber =
      getParam(pageHref, "orderID") ||
      (function () {
        const idNode = doc.querySelector(SELECTORS.ORDER_ID);
        const t = cleanText(idNode ? idNode.textContent : "");
        const m = t.match(ORDER_ID_REGEX);
        return m ? m[1] : "";
      })() ||
      (function () {
        const m = cleanText(doc.body ? doc.body.textContent.slice(0, 4000) : "").match(ORDER_ID_REGEX);
        return m ? m[1] : "";
      })();

    const bodyText = cleanText(doc.body ? doc.body.textContent : "");

    const dateMatch =
      bodyText.match(/order(?:ed| placed)(?: on)?\s*:?\s*([A-Z][a-z]{2,8}\.? \d{1,2},? \d{4})/i) ||
      bodyText.match(/\b([A-Z][a-z]{2,8}\.? \d{1,2},? \d{4})\b/);
    const orderDate = dateMatch ? cleanText(dateMatch[1]) : "";

    const grandTotalMatch = bodyText.match(/(?:grand total|order total)\s*:?\s*(-?\$[\d,]+(?:\.\d{2})?)/i);
    const orderTotal = grandTotalMatch ? cleanText(grandTotalMatch[1]) : (extractCurrencyValues(bodyText).pop() || "");

    const subtotalMatch = bodyText.match(/(?:item\(s\) subtotal|subtotal)\s*:?\s*(-?\$[\d,]+(?:\.\d{2})?)/i);
    const taxMatch = bodyText.match(/(?:estimated tax|tax(?:\s+collected)?)\s*:?\s*(-?\$[\d,]+(?:\.\d{2})?)/i);
    const shippingMatch = bodyText.match(/(?:shipping(?:\s*&\s*handling)?)\s*:?\s*(-?\$[\d,]+(?:\.\d{2})?)/i);

    // Items: product links on the detail/print page.
    const items = [];
    const seen = new Set();
    doc.querySelectorAll(SELECTORS.DETAIL_ITEM).forEach((a) => {
      const productName = cleanText(a.textContent);
      if (!productName || seen.has(productName)) return;
      seen.add(productName);
      const href = a.getAttribute && a.getAttribute("href");
      let productLink = "N/A";
      if (href) {
        try {
          productLink = new URL(href, "https://www.amazon.com").href;
        } catch (_) {
          productLink = href;
        }
      }
      // Nearest price + qty in the item's row.
      const row = a.closest(SELECTORS.ITEM_ROW) || a.parentElement;
      const rowText = cleanText(row ? row.textContent : "");
      const price = extractCurrencyValues(rowText)[0] || "";
      const qtyMatch = rowText.match(/\b(?:qty|quantity)\s*:?\s*(\d+)\b/i);
      items.push({
        productName,
        productLink,
        deliveryStatus: "",
        quantity: qtyMatch ? qtyMatch[1] : "",
        price,
      });
    });

    // Ship-to address (best-effort — Amazon markup varies widely).
    const addrNode =
      doc.querySelector(".displayAddressDiv, [class*='shipping-address'], .a-color-base .displayAddressUL") || null;
    const address = addrNode ? cleanText(addrNode.textContent) : "";

    return {
      // Stamp the shared schema version (guarded so the file stays loadable
      // standalone): the export/DB layers treat anything below
      // CONSTANTS.ORDER_SCHEMA_VERSION as not-yet-downloaded and re-fetch it
      // forever, so a hardcoded 1 made every Amazon invoice invisible.
      schemaVersion: (typeof CONSTANTS !== "undefined" && CONSTANTS.ORDER_SCHEMA_VERSION) || 1,
      orderNumber: orderNumber || null,
      orderDate,
      orderType: /^D/.test(orderNumber || "") ? "digital" : "",
      isInStore: false,
      orderSubtotal: subtotalMatch ? cleanText(subtotalMatch[1]) : "",
      subtotalBeforeSavings: "",
      savings: "",
      orderTotal,
      deliveryCharges: shippingMatch ? cleanText(shippingMatch[1]) : "",
      bagFee: "",
      tax: taxMatch ? cleanText(taxMatch[1]) : "",
      tip: "",
      refund: "",
      donations: "",
      barcodeImageUrl: "",
      sellers: "",
      fulfillmentTypes: "",
      deliveredDate: "",
      trackingNumbers: "",
      paymentSplit: "",
      address,
      addressRecipient: "",
      addressLine: address,
      deliveryInstructions: "",
      deliveryInstructionsExpanded: false,
      paymentMethods: "",
      paymentMethodDetails: [],
      paymentMessages: "",
      items,
    };
  }

  function computeExtractionWarnings(data) {
    const warnings = [];
    try {
      const items = Array.isArray(data && data.items) ? data.items : [];
      if (!data || !data.orderNumber) warnings.push("Order number is missing (Amazon markup may have changed)");
      if (items.length === 0) warnings.push("No items were extracted for this order");
      else if (items.every((i) => !cleanText(i && i.productName))) warnings.push("All extracted items have a blank product name");
      if (!cleanText(data && data.orderTotal)) warnings.push("Order total came back empty");
      if (items.length > 0 && items.every((i) => !cleanText(i && i.price))) warnings.push("No item prices were extracted");
      if (!cleanText(data && data.orderDate)) warnings.push("Order date came back empty");
      if (!cleanText(data && data.address)) warnings.push("Shipping address came back empty");
    } catch (error) {
      console.warn("Amazon extraction validation failed (ignored):", error);
    }
    return warnings;
  }

  /**
   * Fetch + parse the printable invoice for one order id in-page (same-origin,
   * cookie-authenticated — no navigation, so the content script survives).
   * Physical ids try the print invoice first, digital (D…) ids the digital
   * order summary; each falls back to the other before giving up.
   */
  async function scrapeOrderViaFetch(orderNumber) {
    const urls = /^D/i.test(orderNumber)
      ? [digitalSummaryUrl(orderNumber), printInvoiceUrl(orderNumber)]
      : [printInvoiceUrl(orderNumber), digitalSummaryUrl(orderNumber)];

    let shell = null;
    let lastError = null;
    for (const url of urls) {
      try {
        const doc = await fetchListDoc(url);
        const data = scrapeOrderData(doc, url);
        if (!data.orderNumber) data.orderNumber = orderNumber;
        // Usable when the parse found items or a total; otherwise keep it as a
        // shell and try the alternate page shape.
        if ((Array.isArray(data.items) && data.items.length > 0) || cleanText(data.orderTotal)) {
          return data;
        }
        shell = shell || data;
        lastError = new Error(`parsed ${url} but found no items/total`);
      } catch (error) {
        lastError = error;
      }
    }
    console.warn(`Amazon: detail fetch failed for order ${orderNumber}:`, lastError);
    return (
      shell || {
        schemaVersion: (typeof CONSTANTS !== "undefined" && CONSTANTS.ORDER_SCHEMA_VERSION) || 1,
        orderNumber,
        orderDate: "",
        orderTotal: "",
        items: [],
      }
    );
  }

  async function scrapeOrder(ctx) {
    const loc = (ctx && ctx.location) || window.location;
    // Detail-scrape tab: the orders list carrying a wieOrderID marker (see
    // orderDetailUrl) — fetch the invoice in-page. Without the marker (e.g. a
    // print/detail page reached directly) scrape the live document as before.
    const targetId = cleanText(getParam(loc.href, DETAIL_PARAM));
    const data = targetId ? await scrapeOrderViaFetch(targetId) : scrapeOrderData(document, loc.href);
    data.extractionWarnings = computeExtractionWarnings(data);
    return data;
  }

  return {
    id: "AMAZON",
    label: "Amazon",
    flag: "provider.amazon",
    defaultEnabled: false,
    hostPermissions: ["https://www.amazon.com/*"],
    contentMatches: [
      "https://www.amazon.com/gp/css/order-history*",
      "https://www.amazon.com/your-orders/*",
    ],
    ordersListUrl: LIST_BASE,
    locale: "en-US",
    currency: "USD",
    SELECTORS,
    isOrdersListUrl,
    orderDetailUrl, // integration helper (not part of base interface)
    buildListUrl, // integration helper
    initContent,
    collectOrderNumbers,
    scrapeOrder,
    clickNextPage,
  };
})();

// Register with the shared registry. registry.js loads before this file in
// every context, so ProviderRegistry is defined; the guard is belt-and-suspenders.
if (typeof ProviderRegistry !== "undefined" && ProviderRegistry.register) {
  ProviderRegistry.register(AmazonProvider);
}
