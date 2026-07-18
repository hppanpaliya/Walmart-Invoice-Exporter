/**
 * providers/instacart.js — Instacart (INSTACART) provider adapter.
 *
 * Data path (live-verified 2026-07-18, see docs/adapter-live-verification.md
 * "Instacart" section):
 *  - Cookie session; no token capture, no webRequest, no background replay.
 *  - PRIMARY SOURCE = the LIVE Apollo client cache:
 *      window.__APOLLO_CLIENT__.cache.extract().
 *    LIVE CHECK found the embedded <script id="node-apollo-state"> SSR blob has
 *    only ~48 cache keys and NO normalized order entries — the orders are NOT
 *    there, so that blob is now a LAST-RESORT fallback only.
 *  - Within the extracted cache, orders live at entries typed
 *      PersonalOrderHistory (grocery) and RestaurantOrderHistory (restaurant):
 *        <History>.orderDeliveriesConnection.nodes[]   (Relay connection)
 *      The `nodes[]` are Apollo REFERENCES (either {"__ref":"Type:id"} objects
 *      or bare "Type:id" strings) that must be DEREFERENCED against the same
 *      extracted flat cache map to reach the normalized order objects.
 *      Pagination lives at
 *        orderDeliveriesConnection.pageInfo.{ hasNextPage, endCursor }
 *      → Relay-style forward pagination via `first` / `after`.
 *      Also present (best-effort, included when reachable):
 *        viewLayout.ordersHistory.orderList  and  inStorePurchases.history.
 *  - PAGINATION replays same-origin Apollo GraphQL PERSISTED queries:
 *      GET https://www.instacart.com/graphql
 *          ?operationName=<Op>
 *          &variables=<url-encoded JSON, cursor advanced via first/after>
 *          &extensions=<url-encoded {"persistedQuery":{"version":1,"sha256Hash":"…"}}>
 *    BOTH families must be covered or data is missed:
 *      PersonalOrderHistory     — grocery orders
 *      RestaurantOrderHistory   — restaurant / prepared-food orders
 *
 * HOW WE GET THE PERSISTED-QUERY SHA-256 HASHES — and why we do NOT hardcode
 * them: Apollo persisted-query hashes are content-addressed digests of the
 * exact query document the site currently ships. They ROTATE whenever
 * Instacart edits a query, so any hash baked into this file rots and returns
 * PersistedQueryNotFound. Instead we install an in-page fetch/XHR bridge (the
 * same technique as providers/walmart-us.js) that OBSERVES the page's own
 * /graphql requests and captures, per operationName, the live
 * sha256Hash + the exact `variables` object the page used. Pagination then
 * REPLAYS those captured request templates with only the cursor/page advanced —
 * so both the hash AND the variable shape always come from the page itself and
 * never go stale.
 *
 * Loadable + safe at load time in all three contexts (service worker via
 * importScripts, content script, side panel). Nothing below touches the DOM at
 * module load; the content engine only runs when an interface method
 * (initContent / collectOrderNumbers / scrapeOrder / clickNextPage) is invoked,
 * which only ever happens inside an instacart.com page.
 */
const InstacartProvider = (() => {
  "use strict";

  const ORIGIN = "https://www.instacart.com";
  const GRAPHQL_URL = ORIGIN + "/graphql";
  const ORDERS_LIST_URL = ORIGIN + "/store/account/orders";

  // Order-history operations we care about. BOTH grocery + restaurant must be
  // paginated to exhaustion or restaurant orders are silently dropped.
  const ORDER_HISTORY_OPS = ["PersonalOrderHistory", "RestaurantOrderHistory"];

  // Pace same-origin GraphQL calls so we don't hammer Instacart during a crawl.
  const REQUEST_PACING_MS = 700;

  // ---- tiny self-contained helpers (no dependency on utils.js CONSTANTS) ----
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function cleanText(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function normalizeOrderNumber(value) {
    return String(value == null ? "" : value).replace(/[^\d]/g, "");
  }

  function toDisplayMoney(value) {
    // Instacart amounts appear both as preformatted strings ("$42.10") and as
    // numeric cents/dollars — normalize to a "$x.xx" display string.
    if (value == null || value === "") return "";
    if (typeof value === "string") {
      return /\$/.test(value) ? cleanText(value) : cleanText(value);
    }
    if (typeof value === "object") {
      // ASSUMPTION: money objects expose one of these shapes; verify live.
      const s =
        value.viewSection?.priceString ||
        value.priceString ||
        value.displayString ||
        value.formatted ||
        value.display ||
        "";
      if (s) return cleanText(s);
      const cents = value.cents ?? value.amountCents;
      if (typeof cents === "number") return "$" + (cents / 100).toFixed(2);
      const amt = value.amount ?? value.value;
      if (typeof amt === "number") return "$" + amt.toFixed(2);
    }
    if (typeof value === "number") return "$" + value.toFixed(2);
    return cleanText(String(value));
  }

  /** The orders LIST page (an order-detail URL must return false). */
  function isOrdersListUrl(url) {
    return /^https:\/\/www\.instacart\.com\/store\/account\/orders\/?($|\?)/.test(
      String(url || "")
    );
  }

  // ==========================================================================
  // Content-context engine — runs ONLY inside an instacart.com page.
  // ==========================================================================

  const InstacartDataSource = (() => {
    const MESSAGE_SOURCE = "WIE_INSTACART_BRIDGE";
    const TYPE_GRAPHQL_REQUEST = "INSTACART_GRAPHQL_REQUEST";
    const TYPE_GRAPHQL_RESPONSE = "INSTACART_GRAPHQL_RESPONSE";
    const APOLLO_STATE_SELECTOR = "script#node-apollo-state";
    const SNAPSHOT_MAX_AGE_MS = 30000;

    let messageListenerAttached = false;

    // operationName -> { sha256Hash, variables, url } captured from the page's
    // own live GraphQL requests. This is how we avoid hardcoding hashes.
    const capturedRequests = new Map();

    // operationName -> latest { orders, pageInfo, timestamp } observed from a
    // network response (used for pages beyond the embedded page-1 snapshot).
    const latestResponses = new Map();

    // operationName -> { hasNextPage, endCursor, first } — the authoritative
    // pagination cursor, seeded from the LIVE client cache on page 1 and then
    // advanced as we replay persisted queries. Relay `first`/`after` shape.
    const paginationState = new Map();

    // ---- Apollo cache reading -------------------------------------------

    function decodeApolloScript() {
      try {
        const script = document.querySelector(APOLLO_STATE_SELECTOR);
        const raw = script?.textContent;
        if (!raw) return null;
        // textContent is URL-ENCODED JSON.
        const decoded = decodeURIComponent(raw);
        return JSON.parse(decoded);
      } catch (error) {
        console.warn("Instacart: failed to parse node-apollo-state", error);
        return null;
      }
    }

    function extractApolloClientCache() {
      try {
        const client = window.__APOLLO_CLIENT__;
        if (client && client.cache && typeof client.cache.extract === "function") {
          return client.cache.extract();
        }
      } catch (error) {
        console.warn("Instacart: __APOLLO_CLIENT__.cache.extract() failed", error);
      }
      return null;
    }

    // ---- LIVE client-cache dereferencing (PRIMARY source) ----------------
    //
    // cache.extract() returns a FLAT normalized map keyed by "Typename:id"
    // (plus ROOT_QUERY). Nested links to other normalized entries are stored
    // as references, so to read an order we must follow those references back
    // into the same map. Apollo 3 serializes a reference as {"__ref":"Type:id"};
    // the live verification note described them as "@ref strings", so we also
    // accept a bare "Type:id" string that is itself a key of the cache.

    function isCacheKeyString(cache, value) {
      return (
        typeof value === "string" &&
        /^[A-Za-z][\w.]*:/.test(value) &&
        Object.prototype.hasOwnProperty.call(cache, value)
      );
    }

    /** Resolve one reference (object or string) to its normalized entry. */
    function derefFromCache(cache, value) {
      if (!cache || value == null) return null;
      if (typeof value === "string") {
        return isCacheKeyString(cache, value) ? cache[value] : null;
      }
      if (typeof value === "object") {
        if (typeof value.__ref === "string") return cache[value.__ref] || null;
        return value; // already an inline (denormalized) object
      }
      return null;
    }

    /**
     * Deep-copy a normalized entry, following every nested reference back into
     * the flat cache so heuristic field readers (buildOrderSummary /
     * extractOrderLines) see real leaf values instead of {"__ref":…} stubs.
     * Cycle- and depth-guarded.
     */
    function rehydrate(cache, value, depth, seenRefs) {
      if (depth > 6 || value == null) return value == null ? value : null;
      const t = typeof value;
      if (t === "string" || t === "number" || t === "boolean") {
        // A bare cache-key string is a reference; follow it.
        if (t === "string" && isCacheKeyString(cache, value)) {
          if (seenRefs.has(value)) return null;
          const next = new Set(seenRefs);
          next.add(value);
          return rehydrate(cache, cache[value], depth + 1, next);
        }
        return value;
      }
      if (Array.isArray(value)) {
        return value.map((v) => rehydrate(cache, v, depth + 1, seenRefs));
      }
      if (t === "object") {
        if (typeof value.__ref === "string") {
          if (seenRefs.has(value.__ref)) return null;
          const target = cache[value.__ref];
          if (!target) return null;
          const next = new Set(seenRefs);
          next.add(value.__ref);
          return rehydrate(cache, target, depth + 1, next);
        }
        const out = {};
        for (const [k, v] of Object.entries(value)) {
          out[k] = rehydrate(cache, v, depth + 1, seenRefs);
        }
        return out;
      }
      return value;
    }

    /** Pull the Relay `first` arg out of a field key like Op({"first":10}). */
    function firstArgFromKey(key) {
      try {
        const m = String(key || "").match(/\{.*\}/);
        if (!m) return null;
        const args = JSON.parse(m[0]);
        return typeof args.first === "number" ? args.first : null;
      } catch (_) {
        return null;
      }
    }

    /**
     * Locate every order-history connection in the extracted cache. Handles
     * both a normalized entry that IS the history (has __typename
     * Personal/RestaurantOrderHistory) and the ROOT_QUERY style where the
     * history is a field keyed `PersonalOrderHistory({...})`.
     * Returns [{ operationName, connection, first }].
     */
    function findOrderHistories(cache) {
      const histories = [];
      const seen = new Set();
      if (!cache || typeof cache !== "object") return histories;

      const opFor = (typename, key) => {
        if (/RestaurantOrderHistory/.test(typename) || /RestaurantOrderHistory/.test(key)) {
          return "RestaurantOrderHistory";
        }
        if (/PersonalOrderHistory/.test(typename) || /PersonalOrderHistory/.test(key)) {
          return "PersonalOrderHistory";
        }
        return null;
      };

      const consider = (key, obj) => {
        if (!obj || typeof obj !== "object") return;
        const conn = obj.orderDeliveriesConnection;
        if (!conn || typeof conn !== "object" || !Array.isArray(conn.nodes)) return;
        const op = opFor(String(obj.__typename || ""), String(key)) || "PersonalOrderHistory";
        const dedup = String(key) + "|" + (conn.pageInfo && conn.pageInfo.endCursor || "");
        if (seen.has(dedup)) return;
        seen.add(dedup);
        histories.push({ operationName: op, connection: conn, first: firstArgFromKey(key) });
      };

      for (const [key, entry] of Object.entries(cache)) {
        if (!entry || typeof entry !== "object") continue;
        // Case A: entry itself is an order-history object.
        consider(key, entry);
        // Case B: entry (e.g. ROOT_QUERY) has history fields keyed by op(args).
        for (const [fieldKey, val] of Object.entries(entry)) {
          if (/^(PersonalOrderHistory|RestaurantOrderHistory)/.test(fieldKey)) {
            consider(fieldKey, derefFromCache(cache, val) || val);
          } else if (val && typeof val === "object" && val.orderDeliveriesConnection) {
            consider(fieldKey, val);
          }
        }
      }
      return histories;
    }

    /** Dereference a connection's `nodes[]` (refs) into order objects. */
    function ordersFromConnection(cache, connection) {
      const nodes = connection && Array.isArray(connection.nodes) ? connection.nodes : [];
      return nodes
        .map((n) => derefFromCache(cache, n))
        .filter((n) => n && typeof n === "object");
    }

    /**
     * Best-effort in-store purchases + layout order list. These paths were
     * named in the live verification note but their leaf node shapes were NOT
     * captured (refs). We deref whatever ref-list we find and let buildSnapshot
     * dedup against the primary orderDeliveriesConnection results.
     */
    function collectAuxiliaryOrders(cache, out) {
      const asRefList = (listLike) => {
        if (Array.isArray(listLike)) return listLike;
        if (listLike && Array.isArray(listLike.nodes)) return listLike.nodes;
        if (listLike && Array.isArray(listLike.edges)) {
          return listLike.edges.map((e) => (e && (e.node || e)) || null);
        }
        return null;
      };
      const drain = (listLike, isInStore) => {
        const arr = asRefList(listLike);
        if (!arr) return;
        arr.forEach((ref) => {
          const raw = derefFromCache(cache, ref);
          if (!raw) return;
          const node = rehydrate(cache, raw, 0, new Set());
          if (!node || typeof node !== "object") return;
          if (isInStore) node.__wieInStore = true; // REVERIFY: in-store node shape
          out.push(node);
        });
      };
      try {
        for (const entry of Object.values(cache)) {
          if (!entry || typeof entry !== "object") continue;
          // inStorePurchases.history — REVERIFY leaf fields
          if (entry.inStorePurchases && typeof entry.inStorePurchases === "object") {
            drain(entry.inStorePurchases.history, true);
          }
          // viewLayout.ordersHistory.orderList — REVERIFY leaf fields
          const oh =
            (entry.viewLayout && entry.viewLayout.ordersHistory) || entry.ordersHistory;
          if (oh && typeof oh === "object") drain(oh.orderList, false);
        }
      } catch (_) {
        /* best-effort only */
      }
    }

    /**
     * PRIMARY read: build a snapshot from the LIVE __APOLLO_CLIENT__ cache.
     * Returns { snapshot, pageInfoByOp } (snapshot null when nothing found).
     */
    function collectFromClientCache() {
      const cache = extractApolloClientCache();
      if (!cache) return { snapshot: null, pageInfoByOp: {} };
      const orders = [];
      const pageInfoByOp = {};
      const histories = findOrderHistories(cache);
      histories.forEach((h) => {
        ordersFromConnection(cache, h.connection).forEach((raw) => {
          const node = rehydrate(cache, raw, 0, new Set());
          if (node) orders.push(node);
        });
        const pi = h.connection.pageInfo || {};
        const prev = pageInfoByOp[h.operationName];
        // Keep the pageInfo that can still advance (has a cursor / hasNextPage).
        if (!prev || (pi.hasNextPage && !prev.hasNextPage) || (pi.endCursor && !prev.endCursor)) {
          pageInfoByOp[h.operationName] = {
            hasNextPage: Boolean(pi.hasNextPage),
            endCursor: pi.endCursor || null,
            first: h.first || (prev && prev.first) || null,
          };
        }
      });
      collectAuxiliaryOrders(cache, orders);
      return { snapshot: buildSnapshot(orders, "apollo-client-cache"), pageInfoByOp };
    }

    /**
     * Walk an Apollo-normalized cache (or a GraphQL data node) and pull out
     * order-like records. Apollo `extract()` returns a FLAT map keyed by
     * `Typename:id`; SSR data nodes are nested. We handle both by scanning for
     * objects that look like an order.
     *
     * ASSUMPTION (needs live re-verification): order entities carry a numeric
     * legacy id / order number and at least one of a status/total/date field.
     * Exact __typename and field names are NOT yet confirmed.
     */
    function collectOrderNodes(root) {
      const found = [];
      const seen = new Set();
      const looksLikeOrder = (obj) => {
        if (!obj || typeof obj !== "object") return false;
        const tn = String(obj.__typename || "");
        const hasOrderTypename = /order/i.test(tn) && !/line|item|status|address/i.test(tn);
        const hasOrderId =
          obj.legacyId != null ||
          obj.orderId != null ||
          obj.orderNumber != null ||
          obj.deliveryId != null ||
          (obj.id != null && hasOrderTypename);
        return hasOrderTypename && hasOrderId;
      };

      const visit = (node, depth) => {
        if (!node || typeof node !== "object" || depth > 8) return;
        if (Array.isArray(node)) {
          node.forEach((child) => visit(child, depth + 1));
          return;
        }
        if (looksLikeOrder(node)) {
          const key =
            node.id ||
            node.legacyId ||
            node.orderId ||
            node.orderNumber ||
            node.deliveryId;
          const dedup = String(key);
          if (!seen.has(dedup)) {
            seen.add(dedup);
            found.push(node);
          }
        }
        for (const value of Object.values(node)) {
          if (value && typeof value === "object") visit(value, depth + 1);
        }
      };

      visit(root, 0);
      return found;
    }

    /**
     * Best-effort pageInfo extraction for cursor/page pagination. Instacart's
     * Apollo lists typically expose a Relay-style pageInfo; we also accept
     * offset/page shapes.
     * ASSUMPTION (needs live re-verification): field names below.
     */
    function extractPageInfo(root) {
      let result = { hasNextPage: false, endCursor: null, nextPage: null };
      const visit = (node, depth) => {
        if (!node || typeof node !== "object" || depth > 8) return;
        if (Array.isArray(node)) {
          node.forEach((c) => visit(c, depth + 1));
          return;
        }
        if (
          Object.prototype.hasOwnProperty.call(node, "hasNextPage") ||
          Object.prototype.hasOwnProperty.call(node, "endCursor") ||
          Object.prototype.hasOwnProperty.call(node, "nextCursor")
        ) {
          if (node.hasNextPage) {
            result = {
              hasNextPage: Boolean(node.hasNextPage),
              endCursor: node.endCursor || node.nextCursor || null,
              nextPage: node.nextPage || null,
            };
          }
        }
        for (const value of Object.values(node)) {
          if (value && typeof value === "object") visit(value, depth + 1);
        }
      };
      visit(root, 0);
      return result;
    }

    /**
     * Collect order nodes from a RAW GraphQL response (persisted-query replay).
     * Unlike the extracted cache, a live response is nested and its
     * orderDeliveriesConnection.nodes are INLINE objects (no refs), so we read
     * them directly and union with the heuristic scanner as a safety net.
     */
    function collectOrderNodesFromResponse(data) {
      const collected = [];
      const visit = (node, depth) => {
        if (!node || typeof node !== "object" || depth > 8) return;
        if (Array.isArray(node)) {
          node.forEach((c) => visit(c, depth + 1));
          return;
        }
        const conn = node.orderDeliveriesConnection;
        if (conn && Array.isArray(conn.nodes)) {
          conn.nodes.forEach((n) => n && typeof n === "object" && collected.push(n));
        }
        if (Array.isArray(node.orderList)) {
          node.orderList.forEach((n) => n && typeof n === "object" && collected.push(n));
        }
        if (node.inStorePurchases && node.inStorePurchases.history) {
          const h = node.inStorePurchases.history;
          const arr = Array.isArray(h) ? h : Array.isArray(h.nodes) ? h.nodes : [];
          arr.forEach((n) => n && typeof n === "object" && collected.push(n));
        }
        for (const value of Object.values(node)) {
          if (value && typeof value === "object") visit(value, depth + 1);
        }
      };
      visit(data, 0);
      collectOrderNodes(data).forEach((n) => collected.push(n));

      const seen = new Set();
      return collected.filter((n) => {
        const key = String(
          n.id ||
            n.legacyId ||
            n.orderId ||
            n.deliveryId ||
            n.orderNumber ||
            JSON.stringify(n).slice(0, 80)
        );
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    /**
     * Prefer the orderDeliveriesConnection.pageInfo in a raw response; fall
     * back to the generic scanner. REVERIFY: confirm the connection is named
     * `orderDeliveriesConnection` in the paginated response as well as in cache.
     */
    function extractDeliveriesPageInfo(data) {
      let found = null;
      const visit = (node, depth) => {
        if (found || !node || typeof node !== "object" || depth > 8) return;
        if (Array.isArray(node)) {
          node.forEach((c) => visit(c, depth + 1));
          return;
        }
        const conn = node.orderDeliveriesConnection;
        if (conn && conn.pageInfo && typeof conn.pageInfo === "object") {
          found = {
            hasNextPage: Boolean(conn.pageInfo.hasNextPage),
            endCursor: conn.pageInfo.endCursor || null,
            nextPage: null,
          };
          return;
        }
        for (const value of Object.values(node)) {
          if (value && typeof value === "object") visit(value, depth + 1);
        }
      };
      visit(data, 0);
      return found || extractPageInfo(data);
    }

    // ---- order -> summary mapping ---------------------------------------

    /**
     * Read an image field defensively. `currentItem.viewSection.primaryImage`
     * may itself be a bare URL string OR an object wrapping the URL.
     */
    function readImageUrl(image) {
      if (!image) return "";
      if (typeof image === "string") return cleanText(image);
      if (typeof image === "object") {
        return cleanText(
          image.url ||
            image.src ||
            image.imageUrl ||
            image.uri ||
            image.viewSection?.imageUrl ||
            ""
        );
      }
      return "";
    }

    /**
     * Build a Quick-Export summary from one order node.
     * LIVE-VERIFIED 2026-07-18 against the dereferenced `OrderDelivery` node in
     * orderDeliveriesConnection.nodes[]. Confirmed leaf paths are PRIMARY; the
     * older heuristic guesses are kept only as secondary fallbacks.
     */
    function buildOrderSummary(order, normalizedNumber) {
      const lines = extractOrderLines(order);
      return {
        source: "apollo",
        orderNumber: normalizedNumber,
        // LIVE: createdAt (ISO 8601); display fallback createdAtFullString.
        orderDate: cleanText(
          order?.createdAt ||
            order?.viewSection?.createdAtFullString ||
            order?.placedAt ||
            order?.orderDate ||
            order?.deliveredAt ||
            order?.viewSection?.dateString ||
            ""
        ),
        // LIVE: viewSection.deliveredAtFullString.
        deliveredDate: cleanText(
          order?.viewSection?.deliveredAtFullString ||
            order?.deliveredAt ||
            order?.completedAt ||
            ""
        ),
        orderType: cleanText(
          order?.__typename ||
            order?.orderType ||
            order?.fulfillmentType ||
            ""
        ),
        isInStore: Boolean(order?.__wieInStore || order?.isInStore || order?.pickup),
        itemCount: lines.length || order?.itemCount || "",
        // LIVE: amounts.viewSection.totalLine.amountString — a READY display
        // string like "$45.67"; use AS-IS (do not reformat).
        orderTotal: cleanText(
          order?.amounts?.viewSection?.totalLine?.amountString ||
            toDisplayMoney(
              order?.total ||
                order?.totalAmount ||
                order?.priceDetails?.total ||
                order?.viewSection?.totalString ||
                ""
            )
        ),
        // NOTE: the orders-LIST node carries ONLY the total line — there is NO
        // subtotal/tax/tip breakdown at list level — so these stay blank here.
        subTotal: toDisplayMoney(order?.subtotal || order?.priceDetails?.subtotal || ""),
        driverTip: toDisplayMoney(order?.tip || order?.priceDetails?.tip || ""),
        // LIVE: viewSection.statusString (fallback enum workflowState).
        status: cleanText(
          order?.viewSection?.statusString ||
            order?.workflowState ||
            order?.status ||
            order?.statusV2 ||
            ""
        ),
        fulfillmentTypes: cleanText(order?.fulfillmentType || ""),
        // LIVE: retailer.name (fallback retailer.slug).
        retailer: cleanText(
          order?.retailer?.name ||
            order?.retailer?.slug ||
            order?.store?.name ||
            order?.shop?.name ||
            ""
        ),
        items: lines.map((line) => ({
          name: line.productName,
          quantity: line.quantity,
          statusCode: line.deliveryStatus,
          thumbnailUrl: line.thumbnailUrl,
        })),
      };
    }

    /**
     * Extract line items from an order node.
     * LIVE-VERIFIED 2026-07-18: items live under `orderItems[]`; each element
     * (already deref'd by rehydrate) exposes its product under `currentItem`.
     *   productName    = currentItem.name
     *   thumbnailUrl   = currentItem.viewSection.primaryImage (url or object)
     *   product id     = currentItem.legacyId
     * Price & quantity are NOT present on the orders-LIST node → intentionally
     * blank (flagged via extractionWarnings); we do not invent them.
     */
    function extractOrderLines(order) {
      const candidates =
        (Array.isArray(order?.orderItems) && order.orderItems) ||
        (Array.isArray(order?.items) && order.items) ||
        (Array.isArray(order?.lineItems) && order.lineItems) ||
        (Array.isArray(order?.deliveries) &&
          order.deliveries.flatMap((d) => d?.items || [])) ||
        [];

      return candidates
        .map((item) => {
          const product = item?.currentItem || item?.product || item?.item || item;
          return {
            productName: cleanText(product?.name || item?.name || ""),
            productLink: cleanText(
              product?.canonicalUrl || product?.url || product?.productUrl || ""
            ) || "N/A",
            legacyId: cleanText(product?.legacyId || ""),
            deliveryStatus: cleanText(item?.status || item?.deliveryStatus || ""),
            // NOT present on the list node — leave blank, do not invent.
            quantity: "",
            price: "",
            thumbnailUrl: readImageUrl(
              product?.viewSection?.primaryImage ||
                product?.imageUrl ||
                product?.image?.url ||
                product?.viewSection?.imageUrl ||
                ""
            ),
          };
        })
        .filter((line) => line.productName || line.thumbnailUrl || line.legacyId);
    }

    function buildSnapshot(orders, source) {
      const list = Array.isArray(orders) ? orders : [];
      if (list.length === 0) return null;

      const orderNumbers = [];
      const additionalFields = {};
      const orderSummaries = {};
      const seen = new Set();

      list.forEach((order) => {
        // LIVE: orderNumber = legacyOrderId (fallbacks legacyOrderUuid, id).
        const raw =
          order?.legacyOrderId ||
          order?.legacyOrderUuid ||
          order?.legacyId ||
          order?.orderNumber ||
          order?.orderId ||
          order?.deliveryId ||
          order?.id ||
          "";
        const normalized = normalizeOrderNumber(raw);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        orderNumbers.push(normalized);
        const summary = buildOrderSummary(order, normalized);
        additionalFields[normalized] = cleanText(
          summary.retailer
            ? summary.retailer + (summary.orderDate ? " — " + summary.orderDate : "")
            : summary.orderDate
        );
        orderSummaries[normalized] = summary;
      });

      if (orderNumbers.length === 0) return null;
      return { orderNumbers, additionalFields, orderSummaries };
    }

    // ---- network bridge (captures live hashes + response payloads) -------

    function handleBridgeMessage(event) {
      if (event.source !== window) return;
      const message = event.data;
      if (!message || message.source !== MESSAGE_SOURCE) return;

      if (message.type === TYPE_GRAPHQL_REQUEST && message.operationName) {
        // Capture the live persisted-query hash + variables for this op.
        capturedRequests.set(message.operationName, {
          sha256Hash: message.sha256Hash || null,
          variables: message.variables || null,
          url: message.url || null,
          timestamp: Date.now(),
        });
      }

      if (message.type === TYPE_GRAPHQL_RESPONSE && message.operationName) {
        try {
          const data = message.data || null;
          if (data) {
            latestResponses.set(message.operationName, {
              orders: collectOrderNodesFromResponse(data),
              pageInfo: extractDeliveriesPageInfo(data),
              timestamp: Date.now(),
            });
          }
        } catch (error) {
          console.warn("Instacart: failed to index GraphQL response", error);
        }
      }
    }

    function attachBridgeMessageListener() {
      if (messageListenerAttached) return;
      window.addEventListener("message", handleBridgeMessage);
      messageListenerAttached = true;
    }

    function injectNetworkBridgeScript() {
      if (
        !document.documentElement ||
        document.documentElement.dataset.wieInstacartBridgeInjected === "true"
      ) {
        return;
      }
      document.documentElement.dataset.wieInstacartBridgeInjected = "true";

      const bridge = document.createElement("script");
      bridge.setAttribute("data-wie-bridge", "instacart");
      bridge.textContent = `(() => {
        const SOURCE = ${JSON.stringify(MESSAGE_SOURCE)};
        const REQ = ${JSON.stringify(TYPE_GRAPHQL_REQUEST)};
        const RES = ${JSON.stringify(TYPE_GRAPHQL_RESPONSE)};
        if (window.__wieInstacartBridgeInstalled) return;
        window.__wieInstacartBridgeInstalled = true;

        const urlOf = (input) => {
          try {
            if (typeof input === "string") return input;
            if (input && typeof input.url === "string") return input.url;
          } catch (_) {}
          return "";
        };

        const parseGraphqlUrl = (url) => {
          try {
            if (!url || url.indexOf("/graphql") === -1) return null;
            const u = new URL(url, location.origin);
            if (u.pathname.indexOf("/graphql") === -1) return null;
            const operationName = u.searchParams.get("operationName") || "";
            let variables = null, sha256Hash = null;
            const varsRaw = u.searchParams.get("variables");
            if (varsRaw) { try { variables = JSON.parse(varsRaw); } catch (_) {} }
            const extRaw = u.searchParams.get("extensions");
            if (extRaw) {
              try {
                const ext = JSON.parse(extRaw);
                sha256Hash = ext && ext.persistedQuery && ext.persistedQuery.sha256Hash || null;
              } catch (_) {}
            }
            if (!operationName) return null;
            return { operationName, variables, sha256Hash, url: u.href };
          } catch (_) { return null; }
        };

        const emitRequest = (info) => {
          if (!info) return;
          window.postMessage({
            source: SOURCE, type: REQ,
            operationName: info.operationName,
            sha256Hash: info.sha256Hash,
            variables: info.variables,
            url: info.url,
          }, "*");
        };

        const emitResponse = (operationName, text) => {
          if (!operationName || !text || text.indexOf("{") === -1) return;
          try {
            const parsed = JSON.parse(text);
            const data = parsed && parsed.data ? parsed.data : parsed;
            window.postMessage({ source: SOURCE, type: RES, operationName, data }, "*");
          } catch (_) {}
        };

        const patchFetch = () => {
          if (typeof window.fetch !== "function" || window.fetch.__wieInstacartWrapped) return;
          const orig = window.fetch.bind(window);
          const wrapped = (...args) => {
            const info = parseGraphqlUrl(urlOf(args[0]));
            if (info) emitRequest(info);
            return orig(...args).then((response) => {
              if (info) {
                try {
                  const cloned = response.clone();
                  cloned.text().then((t) => emitResponse(info.operationName, t)).catch(() => {});
                } catch (_) {}
              }
              return response;
            });
          };
          wrapped.__wieInstacartWrapped = true;
          window.fetch = wrapped;
        };

        const patchXHR = () => {
          if (XMLHttpRequest.prototype.__wieInstacartWrapped) return;
          const origOpen = XMLHttpRequest.prototype.open;
          const origSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this.__wieUrl = url;
            return origOpen.call(this, method, url, ...rest);
          };
          XMLHttpRequest.prototype.send = function (...args) {
            const info = parseGraphqlUrl(this.__wieUrl || "");
            if (info) emitRequest(info);
            this.addEventListener("load", function () {
              try {
                if (this.responseType && this.responseType !== "" && this.responseType !== "text") return;
                if (info) emitResponse(info.operationName, this.responseText);
              } catch (_) {}
            }, { once: true });
            return origSend.apply(this, args);
          };
          XMLHttpRequest.prototype.__wieInstacartWrapped = true;
        };

        patchFetch();
        patchXHR();
      })();`;

      (document.head || document.documentElement).appendChild(bridge);
      bridge.remove();
    }

    // ---- same-origin paginated fetch (in-page session) -------------------

    /**
     * Replay a captured persisted-query request for `operationName`, advancing
     * the cursor/page. Returns the parsed { orders, pageInfo } or null.
     * Uses the page's own captured hash + variable shape so nothing is stale.
     */
    async function fetchOrderHistoryPage(operationName, cursor, first) {
      const template = capturedRequests.get(operationName);
      if (!template || !template.sha256Hash) return null;

      // Clone the page's own variables, then advance Relay forward pagination.
      // orderDeliveriesConnection.pageInfo is Relay-style, so `first`/`after`
      // is the documented shape. REVERIFY: confirm the cursor argument on the
      // query is literally named `after` (and `first` for page size).
      const variables = JSON.parse(JSON.stringify(template.variables || {}));
      if (first != null && variables.first == null) variables.first = first;
      if (cursor != null) {
        variables.after = cursor;
        // Preserve any alternate cursor slots the captured request already used.
        if ("cursor" in variables) variables.cursor = cursor;
        if (variables.pagination && typeof variables.pagination === "object") {
          variables.pagination.after = cursor;
        }
      }

      const extensions = {
        persistedQuery: { version: 1, sha256Hash: template.sha256Hash },
      };
      const url =
        GRAPHQL_URL +
        "?operationName=" +
        encodeURIComponent(operationName) +
        "&variables=" +
        encodeURIComponent(JSON.stringify(variables)) +
        "&extensions=" +
        encodeURIComponent(JSON.stringify(extensions));

      try {
        const response = await window.fetch(url, {
          method: "GET",
          credentials: "include",
          headers: { accept: "application/json" },
        });
        if (!response.ok) return null;
        const json = await response.json();
        const data = json && json.data ? json.data : json;
        return {
          orders: collectOrderNodesFromResponse(data),
          pageInfo: extractDeliveriesPageInfo(data),
        };
      } catch (error) {
        console.warn("Instacart: order-history fetch failed", operationName, error);
        return null;
      }
    }

    // ---- public content-context API -------------------------------------

    function initialize() {
      attachBridgeMessageListener();
      injectNetworkBridgeScript();
    }

    /**
     * Page-1 orders. PRIMARY source is the LIVE __APOLLO_CLIENT__ cache
     * (orderDeliveriesConnection.nodes deref'd). The SSR blob
     * (node-apollo-state) is only consulted as a LAST RESORT because live
     * verification showed it carries no order entries. Also seeds per-op
     * pagination cursors from the cache's pageInfo.
     */
    function getPrimarySnapshot() {
      const { snapshot, pageInfoByOp } = collectFromClientCache();
      Object.entries(pageInfoByOp).forEach(([op, pi]) => paginationState.set(op, pi));
      return snapshot;
    }

    /**
     * Collect one list "page". currentPage===1 reads the LIVE Apollo client
     * cache (both PersonalOrderHistory + RestaurantOrderHistory) and merges any
     * bridge-observed responses, falling back to the SSR blob only if nothing
     * else produced orders. Later pages exhaust BOTH operations via captured
     * persisted queries, advancing Relay first/after cursors.
     */
    async function collect(currentPage) {
      const page = Number(currentPage || 1);

      if (page <= 1) {
        // Give the page a moment to run its own initial GraphQL calls so the
        // client cache is populated and the bridge has captured live hashes.
        let primary = getPrimarySnapshot();
        const deadline = Date.now() + 6000;
        while (!primary && Date.now() < deadline) {
          await sleep(300);
          primary = getPrimarySnapshot();
        }

        // Last-resort only: the SSR blob (verified to usually lack orders).
        const ssrFallback = primary
          ? null
          : buildSnapshot(collectOrderNodes(decodeApolloScript()), "apollo-ssr");

        const merged = mergeSnapshots([
          primary, // PRIMARY: live client cache
          snapshotFromLatestResponse("PersonalOrderHistory"),
          snapshotFromLatestResponse("RestaurantOrderHistory"),
          ssrFallback,
        ]);

        if (!merged) {
          return {
            orderNumbers: [],
            additionalFields: {},
            orderSummaries: {},
            hasNextPage: false,
            endOfOrders: true,
          };
        }
        return { ...merged, hasNextPage: hasAnyNextPage() };
      }

      // Subsequent pages: exhaust both operations via replayed persisted query,
      // advancing the Relay cursor tracked in paginationState.
      await sleep(REQUEST_PACING_MS);
      const results = [];
      let anyNext = false;
      for (const op of ORDER_HISTORY_OPS) {
        const pi = paginationState.get(op) || latestResponses.get(op)?.pageInfo;
        if (!capturedRequests.get(op)?.sha256Hash) continue;
        if (!pi?.hasNextPage) continue; // this family is exhausted
        const cursor = pi.endCursor || pi.nextPage || null;
        const fetched = await fetchOrderHistoryPage(op, cursor, pi.first);
        if (fetched) {
          const nextPi = {
            hasNextPage: Boolean(fetched.pageInfo?.hasNextPage),
            endCursor: fetched.pageInfo?.endCursor || null,
            first: pi.first || null,
          };
          paginationState.set(op, nextPi);
          latestResponses.set(op, { ...fetched, timestamp: Date.now() });
          results.push(buildSnapshot(fetched.orders, "apollo-network"));
          anyNext = anyNext || nextPi.hasNextPage;
        }
        await sleep(REQUEST_PACING_MS);
      }

      const merged = mergeSnapshots(results);
      if (!merged) {
        return {
          orderNumbers: [],
          additionalFields: {},
          orderSummaries: {},
          hasNextPage: false,
          endOfOrders: true,
        };
      }
      return { ...merged, hasNextPage: anyNext };
    }

    function snapshotFromLatestResponse(operationName) {
      const state = latestResponses.get(operationName);
      if (!state || Date.now() - state.timestamp > SNAPSHOT_MAX_AGE_MS) return null;
      return buildSnapshot(state.orders, "apollo-network");
    }

    function hasAnyNextPage() {
      return ORDER_HISTORY_OPS.some((op) => {
        // Cursor comes from the live client cache (paginationState) first, then
        // any bridge-observed response. We can only advance if we also captured
        // this op's persisted-query hash from the page's own traffic.
        const pi = paginationState.get(op) || latestResponses.get(op)?.pageInfo;
        return Boolean(pi?.hasNextPage && capturedRequests.get(op)?.sha256Hash);
      });
    }

    function mergeSnapshots(snapshots) {
      const valid = (snapshots || []).filter(Boolean);
      if (valid.length === 0) return null;
      const orderNumbers = [];
      const additionalFields = {};
      const orderSummaries = {};
      const seen = new Set();
      valid.forEach((snap) => {
        snap.orderNumbers.forEach((num) => {
          if (seen.has(num)) return;
          seen.add(num);
          orderNumbers.push(num);
          additionalFields[num] = snap.additionalFields[num] || "";
          orderSummaries[num] = snap.orderSummaries[num];
        });
      });
      if (orderNumbers.length === 0) return null;
      return { orderNumbers, additionalFields, orderSummaries };
    }

    /** Deref every order node currently reachable in the live client cache. */
    function orderNodesFromClientCache() {
      const cache = extractApolloClientCache();
      if (!cache) return [];
      const orders = [];
      findOrderHistories(cache).forEach((h) => {
        ordersFromConnection(cache, h.connection).forEach((raw) => {
          const node = rehydrate(cache, raw, 0, new Set());
          if (node) orders.push(node);
        });
      });
      collectAuxiliaryOrders(cache, orders);
      return orders;
    }

    /** Find a single order node (for scrapeOrder) by order number. */
    function findOrderNode(orderNumber) {
      const target = normalizeOrderNumber(orderNumber);
      const pools = [orderNodesFromClientCache()]; // PRIMARY
      for (const op of ORDER_HISTORY_OPS) {
        const state = latestResponses.get(op);
        if (state?.orders) pools.push(state.orders);
      }
      // LAST RESORT: the SSR blob (usually carries no orders).
      pools.push(collectOrderNodes(decodeApolloScript()));
      for (const pool of pools) {
        const match = pool.find((order) => {
          const raw =
            order?.legacyOrderId ||
            order?.legacyOrderUuid ||
            order?.legacyId ||
            order?.orderNumber ||
            order?.orderId ||
            order?.deliveryId ||
            order?.id ||
            "";
          return normalizeOrderNumber(raw) === target;
        });
        if (match) return match;
      }
      return null;
    }

    return { initialize, collect, findOrderNode, buildOrderSummary, extractOrderLines };
  })();

  // ==========================================================================
  // scrapeOrder — normalized order shape (matches providers/walmart-us.js).
  // Instacart has no separate print-view DOM; all fields come from the Apollo
  // cache (embedded SSR or bridge-captured). Every field is best-effort and
  // falls back to '' so downstream export never breaks on a missing value.
  // ==========================================================================

  const ORDER_SCHEMA_VERSION =
    (typeof CONSTANTS !== "undefined" && CONSTANTS.ORDER_SCHEMA_VERSION) || 1;

  function orderNumberFromLocation() {
    // ASSUMPTION (verify live): detail URLs look like
    // /store/account/orders/<id>. Fall back to the list page's first order.
    const match = String(window.location.pathname).match(/orders\/([\w-]+)/);
    return match ? match[1] : "";
  }

  function scrapeOrderData(ctx) {
    const orderNumberHint = orderNumberFromLocation();
    const order = InstacartDataSource.findOrderNode(orderNumberHint);

    if (!order) {
      return {
        schemaVersion: ORDER_SCHEMA_VERSION,
        orderNumber: normalizeOrderNumber(orderNumberHint) || null,
        orderDate: "",
        orderType: "",
        isInStore: false,
        orderSubtotal: "",
        subtotalBeforeSavings: "",
        savings: "",
        orderTotal: "",
        deliveryCharges: "",
        bagFee: "",
        tax: "",
        tip: "",
        refund: "",
        donations: "",
        barcodeImageUrl: "",
        sellers: "",
        fulfillmentTypes: "",
        deliveredDate: "",
        trackingNumbers: "",
        paymentSplit: "",
        address: "",
        addressRecipient: "",
        addressLine: "",
        deliveryInstructions: "",
        deliveryInstructionsExpanded: false,
        paymentMethods: "",
        paymentMethodDetails: [],
        paymentMessages: "",
        items: [],
      };
    }

    const summary = InstacartDataSource.buildOrderSummary(
      order,
      normalizeOrderNumber(
        order?.legacyOrderId ||
          order?.legacyOrderUuid ||
          order?.legacyId ||
          order?.orderNumber ||
          order?.orderId ||
          order?.id
      )
    );
    const lines = InstacartDataSource.extractOrderLines(order);

    // ASSUMPTION (needs live re-verification): the price-detail + address +
    // payment field paths below. Instacart groups these under priceDetails /
    // fees; names are unconfirmed.
    const price = order?.priceDetails || order?.charges || {};
    return {
      schemaVersion: ORDER_SCHEMA_VERSION,
      orderNumber: summary.orderNumber || null,
      orderDate: summary.orderDate,
      orderType: summary.orderType,
      isInStore: summary.isInStore,
      orderSubtotal: toDisplayMoney(price?.subtotal || order?.subtotal || ""),
      subtotalBeforeSavings: toDisplayMoney(price?.subtotalBeforeSavings || ""),
      savings: toDisplayMoney(price?.savings || price?.discount || ""),
      orderTotal: summary.orderTotal,
      deliveryCharges: toDisplayMoney(price?.deliveryFee || price?.delivery || ""),
      bagFee: toDisplayMoney(price?.bagFee || ""),
      tax: toDisplayMoney(price?.tax || price?.salesTax || ""),
      tip: summary.driverTip,
      refund: toDisplayMoney(price?.refund || order?.refundTotal || ""),
      donations: toDisplayMoney(price?.donation || ""),
      barcodeImageUrl: "",
      sellers: summary.retailer,
      fulfillmentTypes: summary.fulfillmentTypes,
      deliveredDate: summary.deliveredDate,
      trackingNumbers: "",
      paymentSplit: "",
      address: cleanText(
        order?.deliveryAddress?.streetAddress ||
          order?.address?.line1 ||
          order?.deliveryAddress?.formatted ||
          ""
      ),
      addressRecipient: cleanText(order?.deliveryAddress?.recipientName || ""),
      addressLine: cleanText(
        order?.deliveryAddress?.streetAddress || order?.address?.line1 || ""
      ),
      deliveryInstructions: cleanText(order?.deliveryInstructions || ""),
      deliveryInstructionsExpanded: false,
      paymentMethods: cleanText(
        order?.paymentMethod?.displayName || order?.payment?.label || ""
      ),
      paymentMethodDetails: [],
      paymentMessages: "",
      items: lines,
    };
  }

  /**
   * Non-throwing tripwire warnings — never break extraction. The core leaf
   * paths (orderNumber/date/total/status/retailer/items) are now LIVE-VERIFIED,
   * so those warnings only fire when a genuinely-present field fails to resolve.
   * Subtotal / tax / tip / item price / item quantity are GENUINELY ABSENT on
   * the orders-list node (it carries only a single total line and per-item
   * name/image/legacyId), so those are flagged unconditionally as a reminder
   * that a per-order detail fetch is required to populate them.
   */
  function computeExtractionWarnings(data) {
    const warnings = [];
    try {
      const items = Array.isArray(data?.items) ? data.items : [];
      if (items.length === 0) {
        warnings.push(
          "No items were extracted (checked order node orderItems[] → currentItem)"
        );
      } else {
        if (items.every((item) => !cleanText(item?.productName || ""))) {
          warnings.push(
            "All extracted items have a blank product name (checked currentItem.name)"
          );
        }
        // Confirmed absent at list level.
        warnings.push(
          "Item price and quantity are not present on the orders-list node — " +
            "the list node exposes only currentItem name/image/legacyId; a " +
            "per-order detail fetch is required to populate them"
        );
      }
      if (!data?.orderNumber) {
        warnings.push(
          "Order number is missing (checked legacyOrderId / legacyOrderUuid / id)"
        );
      }
      if (!cleanText(data?.orderDate || "")) {
        warnings.push(
          "Order date came back empty (checked createdAt / viewSection.createdAtFullString)"
        );
      }
      if (!cleanText(data?.orderTotal || "")) {
        warnings.push(
          "Order total came back empty (checked amounts.viewSection.totalLine.amountString)"
        );
      }
      if (!cleanText(data?.sellers || "")) {
        warnings.push("Retailer/store name came back empty (checked retailer.name)");
      }
      // Confirmed absent at list level: the orders-list OrderDelivery node has
      // only the total line — no subtotal/tax/tip breakdown.
      warnings.push(
        "Order subtotal, tax, and tip are not available on the orders-list node " +
          "(only a single total line is present); a per-order detail fetch is " +
          "required to populate them"
      );
    } catch (error) {
      console.warn("Instacart: extraction validation failed (ignored)", error);
    }
    return warnings;
  }

  // ==========================================================================
  // Interface methods (see providers/base.js). `ctx` is built by content.js.
  // ==========================================================================

  function initContent(ctx) {
    InstacartDataSource.initialize();
  }

  async function collectOrderNumbers(ctx) {
    try {
      return await InstacartDataSource.collect((ctx && ctx.currentPage) || 1);
    } catch (error) {
      console.error("Instacart: collection error", error);
      return {
        orderNumbers: [],
        additionalFields: {},
        orderSummaries: {},
        hasNextPage: false,
        collectionError: true,
      };
    }
  }

  function scrapeOrder(ctx) {
    const data = scrapeOrderData(ctx);
    data.extractionWarnings = computeExtractionWarnings(data);
    return data;
  }

  /**
   * Instacart paginates purely via in-page persisted-query fetch (cursor-based)
   * inside collectOrderNumbers — there is no "next" button to click, so we
   * resolve success without touching the DOM (base.js explicitly allows this).
   */
  async function clickNextPage(ctx) {
    return { success: true };
  }

  return {
    id: "INSTACART",
    label: "Instacart",
    flag: "provider.instacart",
    defaultEnabled: false,
    hostPermissions: ["https://www.instacart.com/*"],
    contentMatches: ["https://www.instacart.com/store/account/orders*"],
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
// every context, so ProviderRegistry is defined; the guard is belt-and-braces.
if (typeof ProviderRegistry !== "undefined" && ProviderRegistry.register) {
  ProviderRegistry.register(InstacartProvider);
}
