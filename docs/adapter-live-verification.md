# Adapter Live Verification (2026-07-18)

Ground-truth data shapes captured against LIVE logged-in sessions, read-only, in the
connected Chrome. These are the concrete corrections to apply to the Wave-2 adapters
(their field paths were best-effort). Structure/keys only were inspected — no personal
values retained.

## Target — REQUIRES FIX (list is shallow; scrapeOrder must fetch detail)
- **List (collectOrderNumbers):** `GET https://api.target.com/guest_order_aggregations/v1/order_history?key=<KEY>&page_number=N&page_size=M` (header `x-api-key`). Page-based via `total_pages`. Each `orders[]` is SHALLOW:
  - `order_number`, `placed_date`, `order_type`, `order_purchase_type`, `summary.grand_total` (string), `address` = `[]` (EMPTY at list level), `order_lines[].item.{tcin, description, images.primary_image}`, `order_lines[].fulfillment_spec.status.tracking_number`. Items have NO price at list level.
- **Detail (scrapeOrder MUST call this):** `GET https://api.target.com/post_orders/v1/<order_number>?key=<KEY>`. Returns:
  - `summary.{grand_total (number), total_taxes, total_product_price (=subtotal), total_shipping_charges, handling_fee, total_items, adjustments[].{promo_description,promo_value}}`
  - `addresses[]`, `packages[]` (item lines w/ prices), `order_date`, `guest_profile`
- **FIX:** target.js scrapeOrder should NOT read financials from the list `summary` (only grand_total is there). It must fetch `post_orders/v1/{order_number}` and map from there. Map: subtotal=`summary.total_product_price`, tax=`summary.total_taxes`, shipping=`summary.total_shipping_charges`, handling=`summary.handling_fee`, total=`summary.grand_total`, address=`addresses[]`, date=`order_date`, items from `packages[]`.

## Uber Eats — minor field-path fixes
- `getPastOrdersV1` (POST, `x-csrf-token: x`) → `{ordersMap, orderUuids, paginationData.nextCursor, meta}` (confirmed).
- Order (`ordersMap[uuid]`): date = **`baseEaterOrder.completedAt`**; items = **`baseEaterOrder.shoppingCart.items[]`** (also `baseEaterOrder.userGroupedItems[]`); currency = **`baseEaterOrder.shoppingCart.currencyCode`** (or `baseEaterOrder.currencyCode`); merchant = `storeInfo.title`; numItems = `baseEaterOrder.numItems`. Totals live in `fareInfo` (top-level order key). Store address at `storeInfo.location.address.{address1,city,region,postalCode,country}`.
- **FIX:** point ubereats.js at these exact paths (esp. `baseEaterOrder.completedAt` for date and `baseEaterOrder.shoppingCart.items` for items).
- **APPLIED (2nd live pass, confirmed leaves):**
  - Fare breakdown is `fareInfo.checkoutInfo[]` = `{label, key, type, rawValue}` (rawValue = **dollar decimal**), labels e.g. `Subtotal`, `Tax`, `Delivery Fee`, `Service Fee and Other Fees`, `Promotion`, `Membership Benefit`. NOTE `Tax on Delivery Fees` sorts before `Tax` → mapFare now matches exact-label-first. `fareInfo.totalPrice` = order total.
  - Cart item = `{title, price, quantity}`; **`price` is an integer in MINOR units (cents)** — scaled /100 in mapItems. (checkoutInfo rawValues are dollars — do NOT scale those.)
  - `completedAt` = 24-char **ISO 8601 string**.
  - **STILL FLAGGED:** `fareInfo.totalPrice` came back as a float in the hundreds — confirm it is a dollar amount (not cents-as-float) against a real visible order total; if it's cents, orderTotal will read 100× high. Everything else verified.

## Instacart — REQUIRES FIX (SSR cache lacks orders; use live client cache)
- The embedded `<script id="node-apollo-state">` has only ~48 cache keys and **NO normalized order entries** — orders are NOT there.
- After the page fetches, `window.__APOLLO_CLIENT__.cache.extract()` contains `PersonalOrderHistory` and `RestaurantOrderHistory` typed entries.
- Orders are at `PersonalOrderHistory[<varsKey e.g. {"first":10}>].orderDeliveriesConnection.nodes[]` (Relay connection), with `orderDeliveriesConnection.pageInfo.{endCursor, hasNextPage}` → cursor pagination via `first`/`after`. Also layout lists at `viewLayout.ordersHistory.orderList` and `inStorePurchases.history`.
- **FIX:** instacart.js primary source must be the LIVE `__APOLLO_CLIENT__` cache (or bridge-captured GraphQL responses), NOT `node-apollo-state`. Read `orderDeliveriesConnection.nodes` and follow `@ref`s. Paginate on `pageInfo.hasNextPage`/`endCursor`. Cover both PersonalOrderHistory (grocery) and RestaurantOrderHistory.

## Amazon — selectors mostly OK; pagination needs care
- `.order-card.js-order-card` (10), `.yohtmlc-order-id` (10), `#time-filter` (year dropdown, 1) all MATCH ✓.
- Order id lives in `.yohtmlc-order-id` (NOT `bdi` — `bdi` count was 0). Order-id regex `[A-Z0-9]{3}-\d{7}-\d{7}` matches card text ✓.
- **Pagination selector `.a-pagination li.a-last:not(.a-disabled) a` matched 0** — either this view is single-page or the selector is stale. amazon.js must page via the `startIndex=` URL param and detect end-of-list by card-count / absence of a next control, NOT rely solely on `.a-pagination`.
- **FIX:** make order-id extraction prefer `.yohtmlc-order-id`; make pagination `startIndex`-driven with a robust end condition.

## Walmart.ca — CONFIRMED WORKING (no fix)
- `GET https://www.walmart.ca/orchestra/graphql/PurchaseHistoryV3/<hash>` returns 200 in-session; same passive bridge model as Walmart.com works. Config variant only.

## Best Buy — UNVERIFIABLE on this account (no purchase history present)
Live check on the logged-in Best Buy session found NO order data to validate against:
- `window.__next_f` (~21KB) contains ZERO order fields (0 hits for orderNumber/orderId/items/orderTotal/grandTotal/orderDate/sku/productName) and ZERO `BBY01-…` order numbers — the RSC stream here is shell/layout only, NOT order data. **So the adapter's primary "parse `__next_f`" assumption is not supported by what this account renders.**
- No order numbers appear anywhere in `document.body.innerText`; the visible "cards" are promos ("Review your recent purchases", "win $400"); order links point to a generic `/profile/ss/orderlookup`, not per-order detail.
- Conclusion: this account has no Best Buy order history to display, so field paths + pagination + the data source itself (RSC vs client-fetched vs server-DOM) remain **UNVERIFIED**, same practical status as Sam's Club. Before trusting bestbuy.js: test on a Best Buy account that HAS orders; determine whether orders come from `__next_f`, a client XHR after load, or server-rendered DOM (the RSC-only assumption looks wrong), and map fields/pagination from real data.

## Sam's Club — cannot verify (no account). Remains reference-only.
