/**
 * providers/base.js — the provider adapter interface.
 *
 * A provider adapter isolates everything site-specific (host, URL shapes, CSS
 * selectors, extraction technique) behind one shape so the shared engine
 * (background collection loop, OrderDb, export, side panel) stays
 * provider-agnostic. Each adapter is a plain object registered with
 * ProviderRegistry (see providers/registry.js). This file carries NO runtime
 * code — it is the JSDoc contract wave-2 authors implement.
 *
 * A new provider = one providers/<id>.js file that builds an object matching
 * ProviderAdapter below and calls ProviderRegistry.register(it), plus its host
 * added to manifest.optional_host_permissions. Nothing else in the engine
 * needs to change.
 *
 * ---------------------------------------------------------------------------
 * @typedef {Object} ProviderAdapter
 *
 * // ----- identity / config (safe to read in ANY context) -----
 * @property {string}   id              Stable key, also the OrderDb partition
 *                                      (e.g. 'WALMART_US'). Never reused/renamed.
 * @property {string}   label           Human label shown in the UI ('Walmart.com').
 * @property {string}   flag            Feature-flag key stored in
 *                                      chrome.storage.local settings.flags
 *                                      (e.g. 'provider.walmart_us').
 * @property {boolean}  defaultEnabled  Effective flag when the user has not set
 *                                      one. ONLY WALMART_US is true.
 * @property {string[]} hostPermissions Match patterns granting site access
 *                                      (['https://www.walmart.com/*']). Used to
 *                                      resolve the adapter by hostname and, for
 *                                      optional providers, requested at opt-in.
 * @property {string[]} contentMatches  content_scripts match patterns for the
 *                                      orders pages (['https://www.walmart.com/orders*']).
 * @property {string}   ordersListUrl   Absolute URL of the orders LIST page the
 *                                      background tab opens to start a crawl.
 * @property {string}   locale          BCP-47 locale ('en-US').
 * @property {string}   currency        ISO-4217 currency ('USD').
 *
 * // ----- pure helper (safe in any context) -----
 * @property {(url: string) => boolean} isOrdersListUrl
 *           True only for the orders LIST page (an order-DETAIL URL like
 *           /orders/123 must return false). Used by the background crawl to
 *           confirm the tab is still on the list.
 *
 * // ----- content-context methods (invoked ONLY inside a page) -----
 * // `ctx` is a ProviderContentCtx built by content.js. These may reference
 * // document/window and MUST NOT run at module load in a service worker.
 * @property {(ctx: ProviderContentCtx) => void} initContent
 *           Called once on content-script load: prime page-JSON snapshots and
 *           install any in-page fetch/XHR bridge.
 * @property {(ctx: ProviderContentCtx) => Promise<CollectResult>} collectOrderNumbers
 *           Collect the order numbers + Quick Export summaries for one list
 *           page. ctx.currentPage (1-based) says which page is loaded.
 * @property {(ctx: ProviderContentCtx) => (Object|Promise<Object>)} scrapeOrder
 *           Scrape one order-DETAIL page into the normalized order shape the
 *           export code consumes (same shape already exported today).
 * @property {(ctx: ProviderContentCtx) => Promise<{success: boolean}>} clickNextPage
 *           Advance the list to the next page. Providers that paginate purely
 *           via an in-page fetch (cursor/page-number) may resolve {success:true}
 *           without touching the DOM; Walmart clicks the "next" button.
 *
 * ---------------------------------------------------------------------------
 * @typedef {Object} ProviderContentCtx
 * @property {ProviderAdapter} provider  The adapter itself (self-reference).
 * @property {Document} document         The page document (for __NEXT_DATA__ /
 *                                       page-JSON reads and DOM scraping).
 * @property {Window}   window           The page window (for the in-page fetch
 *                                       bridge / same-origin fetch).
 * @property {Location} location         window.location.
 * @property {number}   currentPage      1-based list page for collectOrderNumbers.
 *
 * ---------------------------------------------------------------------------
 * @typedef {Object} CollectResult
 * @property {string[]} orderNumbers      Digits-only order numbers on this page.
 * @property {Object}   additionalFields  orderNumber -> title string.
 * @property {Object}   orderSummaries    orderNumber -> Quick Export summary.
 * @property {boolean}  hasNextPage       Whether another page follows.
 * @property {boolean} [endOfOrders]      True when the list is genuinely empty
 *                                        (stop, not a retryable error).
 * @property {boolean} [collectionError]  True on a transient failure the
 *                                        background loop should retry.
 * ---------------------------------------------------------------------------
 *
 * Note: the plan sketched `collectOrderNumbers -> { summaries, ... }`; the
 * implemented key is `orderSummaries` to match the existing background/side
 * panel merge code unchanged. Wave-2 adapters MUST return `orderSummaries`.
 */

// Documentation-only module; nothing to export.
