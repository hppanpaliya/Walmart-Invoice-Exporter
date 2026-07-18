# Live Recon Findings

Companion to [`multi-provider-plan.md`](./multi-provider-plan.md) and
[`provider-expansion-candidates.md`](./provider-expansion-candidates.md). These are
**live, logged-in confirmations** of each provider's data path, verified in-browser
(2026-07-18). Only structure/shape was inspected — no personal order data was extracted
or stored.

Verification method per provider: confirm login → find the order-history network call →
call it via an **in-page `fetch` using the page's own session** (no token capture) →
record response shape (keys only).

---

## Walmart.com — CONFIRMED (in-page, cookie session)
- **Technique:** same-origin GraphQL, cookie-authenticated. In-page fetch carries session.
- **Endpoint shape:** `GET /orchestra/cph/graphql/<Operation>/<queryHash>?variables=<urlenc JSON>`
  (purchase history is `PurchaseHistoryV3`).
- **Page JSON:** `__NEXT_DATA__` holds config/feature-flags only, not the order records.
- **No token capture, no `webRequest` needed.**

## Target — CONFIRMED (in-page, cookie session + public web key)
- **Technique:** same-origin-ish REST API, cookie session. In-page fetch returns 200.
- **Endpoint:** `GET https://api.target.com/guest_order_aggregations/v1/order_history?key=<KEY>&page_number=1&page_size=N`
  - Header `x-api-key: <KEY>`.
  - **KEY is a public web key embedded in every page request** (`ff457966e64d5e877fdbad070f276d18ecec4a01`) — not a captured secret. Same key OrderPro used.
- **Response keys:** `{ metadata, guest_id, total_orders, total_pages, orders, request }`
  - Pagination: `total_pages` / `page_number` (page-based).
  - **Order object keys:** `tenant_key, placed_date, order_type, source, summary, address,
    order_lines, order_number, order_purchase_type, is_market_place, pending_returns, …`
  - **Order line keys:** `order_line_key, original_quantity, grouping, item,
    fulfillment_spec, order_line_id, is_free_gift, …`
- **Field mapping:** order # = `order_number`, date = `placed_date`, totals = `summary`,
  ship-to = `address`, items = `order_lines[].item` + `original_quantity`.
- **No token capture, no `webRequest` needed.** Note: Target sits behind bot protection;
  automated pagination may be throttled.

## Uber Eats — CONFIRMED (in-page, cookie session + static CSRF)
- **Technique:** same-origin POST API, cookie session. In-page fetch returns 200.
- **Endpoints (all `POST https://www.ubereats.com/_p/api/…`):**
  - `getPastOrdersV1` — the order list (paginated).
  - `getOrderEntitiesV1` / `getInvoiceStatusV1` — per-order detail / invoice.
  - Header `x-csrf-token: x` (Uber accepts the literal `x` — **no captured token**).
  - Request body: `{ limit, orderUuids, startTimeMs }` (and cursor for paging).
- **Response keys:** `{ ordersMap, orderUuids, paginationData, meta }`
  - Pagination: `paginationData.nextCursor` (**cursor-based**, not page-number).
  - Orders are a map keyed by UUID (`ordersMap`), ordered by `orderUuids`.
  - **Order object keys:** `baseEaterOrder, storeInfo, courierInfo, fareInfo, ratingInfo,
    interactionType`
- **Field mapping:** items/date = `baseEaterOrder`, merchant = `storeInfo`,
  totals/charges = `fareInfo`.
- **No token capture, no `webRequest` needed.**

## Walmart.ca — CONFIRMED (in-page, cookie session; OAuth concern resolved)
- **Technique:** identical to Walmart.com — same-origin Orchestra GraphQL, cookie session.
  Once logged in (via the `identity.walmart.com` OAuth flow), the session cookie carries
  and an in-page fetch just works. **No token capture needed after login.**
- **Endpoint:** `GET https://www.walmart.ca/orchestra/graphql/PurchaseHistoryV3/<hash>?variables=<urlenc JSON>` → **200**.
  - **Path delta vs .com:** `.ca` uses `/orchestra/graphql/…`; `.com` uses `/orchestra/cph/graphql/…`.
  - Operation is **PurchaseHistoryV3** (same as .com, not V2), tenant `CA_GLASS`.
  - **Cursor-based** pagination (`variables.input.cursor`, `limit`), plus `search` / `filterIds`.
  - Currency: **CAD**.
- **Config variant of the Walmart.com adapter** — differs only in host, API path segment,
  tenant, and currency.

## Amazon — CONFIRMED (server-rendered HTML, DOM scrape)
- **Technique:** no JSON order API and no `__NEXT_DATA__`. Order history is
  **server-rendered HTML**; scrape the DOM. This is the heavier pattern (matches
  OrderPro's hidden-iframe approach).
- **Page:** `https://www.amazon.com/gp/css/order-history` (also `/your-orders/orders`).
- **Selectors:** order cards = `.order-card.js-order-card`; order id via `.yohtmlc-order-id` / `bdi`.
- **Filtering/pagination:** year via `orderFilter=year-YYYY` (time-filter dropdown);
  index-based paging via `startIndex=` URL param. Digital orders are a separate filter.
- **Cost note:** most work of the five — multiple order types (regular/digital/business),
  brittle selectors, needs iframe or tab navigation per page.

## Instacart — CONFIRMED (in-page; embedded Apollo SSR cache + same-origin GraphQL)
- **Technique:** cookie session. Order data is in the **embedded Apollo SSR cache**
  (`<script id="node-apollo-state">`, URL-encoded JSON) for the first page, plus
  same-origin **Apollo GraphQL persisted queries** for pagination.
- **Endpoint:** `GET https://www.instacart.com/graphql?operationName=…&extensions={persistedQuery:{sha256Hash}}`.
- **Relevant operations:** `PersonalOrderHistory`, `RestaurantOrderHistory`,
  `OrderHistoryNavigation`, `AccountOrdersPageMetaQuery`.
- **No token capture needed.**

## Best Buy — CONFIRMED (in-page, server-rendered RSC; Akamai-protected)
- **Technique:** Next.js **App Router**. Order data is embedded in the RSC stream
  (`window.__next_f`, server components) and rendered to DOM — cookie session, no client
  token. Read the RSC payload or scrape the DOM cards.
- **Page:** `https://www.bestbuy.com/purchasehistory/purchases`. DOM order cards present;
  `__next_f` contains `orderNumber` / order data.
- **Anti-bot:** Akamai bot manager active (obfuscated beacon POST observed); automated
  navigation may get challenged. Higher friction than the API-based providers.
- **No token capture needed**, but RSC parsing is more work than a clean JSON API.

## Sam's Club — REFERENCE ONLY (from OrderPro code, NOT live-verified)
No Sam's Club account available, so this is reverse-engineered from the OrderPro bundle
(`SamsClubProvider`), not confirmed against a live session. Treat endpoints/hashes as
"last known," to be re-confirmed when an account is available.

- **Platform:** same Orchestra GraphQL family as Walmart. US = `www.samsclub.com`,
  CA = `samsclub.ca` (uses `/en/…` paths, `x-o-bu: SAMS-CA`). Fits the in-page model.
- **Orders list page:** `/orders` (US) or `/en/orders` (CA). **Order detail page:** `/orders/{id}`.
- **Auth — the key difference from Walmart:** Sam's uses a **client-readable bearer
  token**, not just a cookie. OrderPro reads it in-page as `authToken` (from a
  JS-accessible store, e.g. localStorage) and puts it in an `authorization` header. Because
  it's client-readable, **an in-page fetch can attach it — no `webRequest` capture needed.**
  OrderPro also refreshes the session by loading `/orders` in the background (throttled
  ~15 min, key `sams_club_session_refreshed_at`).
- **Order-list (summary) endpoint:**
  `GET https://www.samsclub.com/orchestra/cph/graphql/PurchaseHistoryV2/<queryHash>?variables=<urlenc JSON>`
  (CA: `…/orchestra/cph/graphql`). The `<queryHash>` is a **persisted-query hash** OrderPro
  grabbed from the page's own request (it used `webRequest` for this; **in-page you'd get it
  by observing the page's own PurchaseHistoryV2 call via a fetch-patch — exactly the bridge
  the Walmart adapter already has**).
- **Order-detail endpoint:**
  `GET https://www.samsclub.com/orchestra/orders/graphql/getOrder/<hash>?variables={orderId,orderIsInStore,clickThroughGroupId,enableIsWcpOrder}`
- **Required headers:** `authorization: <authToken>`, `x-apollo-operation-name:
  PurchaseHistoryV2` (list) / `getOrder` (detail), `x-o-gql-query`, `x-o-bu: SAMS-US|SAMS-CA`,
  `x-o-mart: B2C`, `x-o-platform: rweb`, `x-o-segment: oaoh`, `device_profile_ref_id`.
- **Response field mapping (order header):**
  - order id = `orderId || id`; detail_url = `/orders/{id}`
  - total = `priceDetails.grandTotal.displayValue`
  - date = `orderDate || deliveredDate`
  - status = `status.statusType` (`PREPARING/PLACED/ON_THE_WAY/DELAYED` → not delivered;
    `DELIVERED`; `IN_STORE/PICKED_UP` → regular; `CANCELED`; `RETURN_COMPLETED` → refunded)
  - tracking = `groups[].shipment.trackingNumber` / `.trackingUrl`
  - in-store detection = `type === 'IN_STORE'` or order-id length > 17
- **Response field mapping (items, grouped under `categories[].items[]`):**
  - name = `productInfo.name`; item id/URL = `productInfo.usItemId` → `/ip/{usItemId}`
  - quantity = `quantity`; price = `priceInfo.linePrice.value`;
    strikethrough/discount = `priceInfo.strikethroughPrice.value`;
    image = `productInfo.imageInfo.thumbnailUrl`
- **Payment-summary labels:** Subtotal, Shipping, Tax, Savings (promotion), discount
  (coupon), Total (grand total), Refund.
- **Caveats:** (1) unverified — hashes/paths may be stale; (2) it's the most app-like of the
  Walmart family, so expect the fetch-patch bridge (to grab the persisted-query hash +
  authToken) rather than reading `__NEXT_DATA__` directly.

---

## Login status snapshot (2026-07-18, connected Chrome "Browser 1")
- ✅ Logged in & mapped: **Walmart.com, Walmart.ca, Target, Uber Eats, Amazon, Instacart, Best Buy**
- ⚠️ Bot-protection wall (state ambiguous): **eBay** (captcha), **Home Depot** (Akamai blank shell)
- ❌ Logged out: Sam's Club, Etsy, DoorDash

## Difficulty ranking (all fit the model; differ only in effort)
1. **Walmart.ca** — trivial; config variant of the existing Walmart adapter.
2. **Target** — easy; clean JSON API, public key, page-based paging.
3. **Uber Eats** — easy; clean JSON API, static CSRF, cursor paging.
4. **Instacart** — easy–medium; embedded Apollo state + persisted GraphQL.
5. **Best Buy** — medium; RSC stream parsing + Akamai friction.
6. **Amazon** — hardest; HTML DOM scrape, multiple order types, brittle selectors.

## Takeaway
Every provider mapped so far fits the extension's model exactly: **in-page fetch from the
user's own session, no token capture, no `webRequest`, no background replay.** The only
per-site variation is mechanical — page-based vs cursor-based pagination, a public web key
(Target) vs a static CSRF value (Uber) vs pure cookie (Walmart).
