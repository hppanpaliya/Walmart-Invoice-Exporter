# Changelog

## [8.2] - July 19, 2026

### Added
- **Richer MCP read tools**: `search_orders` (free-text search across order numbers, titles, and item names), `spending_summary` (overall and per-month totals), `export_orders` (full records as JSON, paged), plus live progress tools `get_collection_progress` and `get_invoice_job`.
- **MCP action tools behind a new opt-in**: a second, separate Settings toggle — **"Allow AI tools to collect data"** (off by default) — lets MCP clients start order collection (`start_collection` / `stop_collection`, with order-type and date filters) and fetch invoices in a background tab (`collect_invoices` / `cancel_invoice_job`) using the signed-in session. With the toggle off, the bridge stays exactly as read-only as before, and deleting data is never possible through MCP either way. Requires [`walmart-invoice-mcp`](https://www.npmjs.com/package/walmart-invoice-mcp) v0.2+ (wire protocol v2).

## [8.1] - July 19, 2026

### Added
- **Optional local MCP access (off by default)**: a new Settings → "AI access (MCP)" toggle lets AI tools on your own computer (Claude Code, Claude Desktop, any MCP client) read your saved orders through the [`walmart-invoice-mcp`](https://github.com/hppanpaliya/walmart-invoice-mcp) helper (published [on npm](https://www.npmjs.com/package/walmart-invoice-mcp), runs via `npx walmart-invoice-mcp`). Read-only and localhost-only: the extension only ever connects out to `127.0.0.1` with a pairing token you generate in Settings; nothing is sent to the internet.

- **Project website on GitHub Pages**: [github.harsh.al/Walmart-Invoice-Exporter](https://github.harsh.al/Walmart-Invoice-Exporter/) — a landing page, Help & FAQ, and privacy policy built from [site/](site/) and deployed automatically by the new `pages.yml` workflow — screenshots are pulled from `store-assets/` at build time so the site and store listing can't drift apart.

### Changed
- **Tooling moved from npm to pnpm**, with a 14-day supply-chain cooldown (`minimumReleaseAge`): newly published dependency versions aren't installed until they've been public for two weeks.
- FAQs (in-panel, website) and the README now cover the v8.0 features (dashboard, multi-account, inactivity retention) and the new MCP access.

## [8.0] - July 19, 2026

### Added
- **The dashboard is a multi-view app**: a navigation rail with five views — Overview, Items, Trends, Orders, and Year in review — each with its own URL (back/forward work), built on a drop-in view registry for future views.
- **Items view with your Personal Inflation Rate**: every product you've ever bought with times bought, total spent, average/last price, price-history sparklines, and click-to-expand full purchase timelines — plus a spend-weighted inflation figure comparing your own basket across the last two 12-month windows, computed entirely on your device.
- **Trends view**: cumulative spend, year-over-year lines, a GitHub-style shopping-days heatmap, delivery/pickup split, order-size histogram, day-of-week pattern, and a where-each-dollar-went stacked chart (items/tax/tips/savings per month).
- **Year in review**: a Wrapped-style annual summary — total spent with vs-last-year delta, superlatives (biggest order, most-bought item, busiest month/day, longest Walmart-free streak), top 5 by spend, and the year's month-by-month shape, with a year picker.
- **Monthly budget on the Overview**: set a budget once, get a progress ring, an on-pace month-end projection, and remaining/overage — stored locally like everything else. Plus a refunds tracker that appears only when you have refunds.
- **Full app dashboard**: click any order row to expand its complete invoice inline (items, prices, money breakdown, payment details); real interactive charts (Chart.js) with tooltips — click a bar to scope the page to that month; a new "More insights" analytics card (biggest order, savings rate, average items per order, busiest day, most-bought item); month group rows in the orders table with select-the-whole-month checkboxes.
- **Walmart's own order filters as collection options**: order type (Online / In store / In progress / Completed / Returned) and a date range, applied with the site's exact filter grammar. Collections that match nothing now explain themselves instead of showing a silent empty list.
- **Multi-account support**: saved data is scoped per Walmart account (detected privately — only a hash, never your name). A switcher appears in the panel and dashboard only when 2+ accounts have data; accounts auto-number and can be renamed; per-account delete in Settings; fetching another account's orders while the wrong account is signed in is blocked with a clear message.
- **Fast mode is a first-class citizen**: request-based collection honors "only new orders" (stops at the first all-known page), works on filtered views, keeps your filters across every page, and fast-fetched invoices now count everywhere (Saved chip, dashboard totals, savings/tax/tips).

### Changed
- **Complete visual redesign** of the panel, settings, and dashboard: one design language in light and dark (deep slate surfaces, blue accent, card-based layout, iOS-style switches, sticky month headers, sticky bottom download bar).
- **New build system (WXT/Vite)**: `npm run dev` for live development, `npm run zip` / `zip:firefox` for store packages (including the AMO sources zip). Load the unpacked extension from `dist/chrome-mv3`.

### Fixed
- Inline-script CSP violations spamming the console on walmart.com (dead legacy bridge removed; the MAIN-world capture script has owned this since 7.3).
- Fast-fetched invoices were stored but invisible (missing schema stamp) — totals showed $0.
- Filtered order views collected 0 orders (filtered pages render client-side; collection now waits for the page's own request and replays it faithfully, filters included).
- The account switcher showed an empty shell for single-account users.


## [7.3] - July 18, 2026

### Added
- **Spending Dashboard is now a full browser page** (opened via the chart icon), with the live side panel embedded alongside it: scope picker (all time / last 3 / last 6 / this year / last year / custom), monthly spend chart where clicking a bar re-scopes the whole page, stat strip with vs-previous-period deltas, price watch on items you rebuy, most-bought items, a searchable/sortable orders table, and scoped export straight from the page.
- **Receipt-style order list** in the panel: orders grouped by month with a "Showing" range filter and one-open-at-a-time detail rows.

### Fixed
- **Product links survive Walmart's payload change** (issue #14 follow-up): Walmart removed the product URL from the order page's embedded data, so links now fall back to being built from the item id (`walmart.com/ip/<id>`) — item links keep working even if the visible page markup changes again.
- **The order list no longer resets while collecting**: updates now append in place instead of rebuilding the list every second, so your scroll position, checked orders, and the expanded row all survive a live collection.
- **Years-old orders get real dates**: when an old order has no date anywhere in Walmart's data, the date is recovered from Walmart's own delivered date ("Delivered on …") or order title ("Jun 15, 2022 order") — the same dates walmart.com shows — instead of piling up under "NO DATE". Applies to the list, filters, and the dashboard, including orders you've already collected.
- CI unit-test job now installs dependencies, so the xlsx-verifying tests actually run.

## [7.0] - July 17, 2026

### Changed
- **Two-button download model:** the old "Download" and "Quick Export" buttons are replaced by an equal pair — "Single file" (one file with every selected order) and "Multiple files" (one file per selected order). The chosen format (Excel/CSV/JSON/receipt/PDF) shows right in the button label, e.g. "Single file (.xlsx)".
- **Collection demoted to one primary action:** "Collect orders" is now the single button on the main card; page limit and "only collect new orders" moved under an "Options" disclosure.
- **Removed the 884 KB ExcelJS injection from every walmart.com/orders page** — it now loads only when an Excel export actually runs, making the panel lighter on every other page.

### Added
- **Dedicated Settings view** (gear icon in the header): Appearance (System/Light/Dark theme — dark mode is new), Collection defaults, Export defaults, "Data on this device", and About.
- **"Use legacy Excel layout" opt-in** restores the older single-sheet workbook (pre-6.18) for anyone who prefers it over the current Orders/Items two-sheet layout. Off by default.
- **Unified on-device storage:** everything the extension stores now lives in one place (IndexedDB), with a single "Delete all saved data" control in Settings that truly wipes everything — no servers, no telemetry.
- **Instant re-export:** orders you've already downloaded re-export immediately, in any format, from the stored data — nothing is ever fabricated.
- Keyboard focus rings, reduced-motion support, and ARIA labeling throughout the panel.

### Fixed
- **The long-standing "cache won't clear" problem** is gone — the old three scattered clear controls (including the confusing "Clear Cache" button) are replaced by the one "Delete all saved data" control, which now actually removes everything.

## [6.25] - July 10, 2026

### Changed
- **Quick Export never synthesizes data anymore.** It now does exactly one thing, instantly and always accurately: re-export orders you've already downloaded (any format, no pages opened). Selected orders that were never downloaded are skipped with a clear count; if none of the selection is downloaded, it refuses with guidance instead of producing partial rows.

## [6.24] - July 10, 2026

### Fixes
- **Fix (root cause of duplicated \$0.00 items, verified live against a real order page):** Walmart's print view renders quantities as "Qty 2" and prices as "Discount price \$6.30\$7.72" (charged + strikethrough). The DOM scraper passed these through raw, so item quantities never matched the payload ("Qty 2" ≠ "2"), the duplicate-merge never matched, and prices parsed to \$0.00. The scraper now extracts the numeric quantity and the first (charged) currency token, and the merge normalizes quantities defensively. Regression tests encode the exact live DOM shapes.

## [6.23] - July 10, 2026

### Improvements
- The panel header now shows the running build version (e.g. "v6.23") so it's always clear whether the loaded extension is current.

## [6.22] - July 10, 2026

### Fixes
- **Fix:** Monthly spend no longer drops orders whose stored date is in human format (or lives only on the invoice) — every measured dollar now lands in a month bucket. Previously the bars could show a fraction of the real total (e.g. \$1.84 of \$27.49).
- **Fix:** Saving an invoice now records the order's date even when the order was never summary-collected.
- Clearer dashboard empty states explaining that repurchases/price history need items appearing across multiple downloaded invoices.

## [6.21] - July 10, 2026

### Changed
- **Reverted 6.20's in-tab collection** (owner decision): collection always runs in its own background tab again and never touches the tab you're using.

### Fixes (from a deep multi-agent code review)
- **Fix:** A mid-collection hiccup (content-script error, unexpected redirect) is no longer mistaken for a successful final page — collection retries instead of silently truncating, and the background verifies the collection tab is still on the orders list before each page.
- **Fix:** Incremental collection ("only new orders") now hydrates the order list from the local database when it stops early, so every stored order stays selectable and exportable even after the 24h cache expires.
- **Fix:** When the 24h cache is empty but the database has your orders, the panel now lists them (with a "Loaded N orders from the local database" note) — Quick Export and Download work without a forced re-collection.
- **Fix:** Genuinely distinct order lines with the same product and quantity (e.g. a re-priced substitution) both survive the item merge again; the payload absorbs at most one DOM copy per line, and a blank payload price is backfilled from the DOM.
- **Fix:** Accounting CSV presets skip orders with unknown totals instead of writing fake $0 transactions.
- **Fix:** Price history sorts correctly when order dates are in mixed formats.
- **Fix:** Removed the over-aggressive price sanity guard that could blank legitimate prices on partially canceled orders.

## [6.20] - July 10, 2026

### Improvements
- **Collection runs in your current tab** — Start Collection no longer launches a second tab when you're already on the orders page: it paginates right where you are (faster, no duplicate session). A background tab is only created when collection starts from elsewhere, and your own tab is never closed.

## [6.19] - July 10, 2026

### Fixes
- **Fix: duplicated items with \$0.00 prices and garbage statuses** — the DOM scrape could return the same items as the page payload but with wrong prices ("\$0.00") and progress text as status ("12 shopped"); the merge kept both copies. Payload items now always win, deduped by name+quantity. Invoices stored by older versions are no longer trusted (schema v3) — re-download those orders once to replace them.
- **Fix:** Raw numeric Walmart status codes (e.g. "3700.0031") no longer leak into the Delivery Status column — the human status text ("Delivered") is used.
- **Fix:** The per-order report's summary block no longer prints \$0.00 for values that were never scanned — and now **omits unmeasured fields entirely**: a quick (summary-only) report is simply shorter, and a new "Data" field states "Full invoice" or "Summary only — not scanned yet".

### Improvements
- **Dashboard measures fully downloaded invoices ONLY** — no half-measurements from summary data. A coverage banner shows how many stored orders are actually measured, and a "Reset dashboard data" button clears the local database.
- A "Data" column on the Orders sheet marks each order as Full invoice vs Summary only.
- Item prices that exceed twice their order's own total are treated as extraction corruption: blanked in exports and flagged by the warning tripwire.

## [6.18] - July 10, 2026

### Improvements
- **Redesigned Excel workbook** (Download and Quick Export both): an **Orders sheet** (one clean row per order — sum any money column safely) plus an **Items sheet** (one row per item: order, date, product, qty, price, status, type, link). No more 29-column rows with item fields buried behind repeated address/payment noise.
- **Unknown values are now BLANK, never \$0.00** — a missing price or tax no longer masquerades as zero.
- Frozen header rows, auto-filters, and Walmart-blue styled headers on every sheet.

## [6.17] - July 10, 2026

### Internal
- **End-to-end test harness:** Playwright now launches Chromium with the packaged extension loaded and drives it like a real user — collection through the real background worker, Quick Export selection contract, format parity with Download, per-item price joining from stored invoices, and the dashboard — asserting on the actual generated Excel files. walmart.com is fully mocked at the network layer (local proxy + synthetic pages built from the sanitized fixtures), so tests can never touch the real site or any real data. Runs in CI on every push. No user-facing changes.

## [6.16] - July 10, 2026

### Improvements
- **Improvement:** **Quick Export now uses the exact same format as Download Selected** — same columns, same single-file/multiple-files export modes, same format/preset/thumbnail options. Orders with a downloaded invoice export with full fidelity; the rest are built from list data with unknown fields left blank. Combined files are named `Walmart_Orders_Quick.*` so they never overwrite deep exports.
- **Improvement:** When exported orders have no downloaded invoice, Quick Export now says so plainly: an amber warning lists how many orders have blank item prices/fees/address and tells you to run Download Selected once on those to fill them.

## [6.15] - July 10, 2026

### Improvements
- **Improvement:** **Quick Export items sheet** — items are no longer crammed into a single "Item Names" cell. Excel exports gain an 'Items' worksheet (one row per item: order, date, item, qty, price, status), CSV exports a companion items file, and JSON nests a structured items array per order. Per-item prices aren't in Walmart's list data, so they join in automatically from any invoice you've downloaded — prices fill in as your database grows.

## [6.14] - July 10, 2026

### Fixes
- **Fix:** Quick Export now requires a selection and exports ONLY the ticked orders — identical contract to the Download button. No selection → prompt, never a surprise full export.
- **Fix:** Wrong/incomplete Quick Export rows: collection now waits up to 6 seconds for Walmart's rich page payload before ever falling back to DOM scraping; DOM-scraped rows can no longer overwrite payload-quality data (in the live collection or the local database); the DOM scraper only trusts dates found in the order card title (body dates are delivery estimates, not order dates); and Quick Export upgrades any degraded row from the best copy stored in the local database.

## [6.13] - July 10, 2026

### Improvements
- **UI refresh:** Download and Quick Export now sit side by side as one compact action row; the export controls (mode, format, CSV preset, thumbnails) are tucked into a collapsible "Export options" section so the main panel is just collect → select → export. Cleaner card, order list, and hover states throughout.

### Fixes
- **Fix:** Collection now always gathers the data Quick Export needs — pages collected via the DOM fallback get best-effort summaries (date, total, item count, status scraped from the order cards), and starting a collection over an old summary-less cache automatically re-collects from scratch instead of leaving Quick Export degraded.

## [6.12] - July 10, 2026

### Features
- **Feature:** **Microsoft Edge & Firefox packages** — every release now ships Edge and Firefox zips alongside Chrome. Firefox uses the browser sidebar (`sidebar_action`) instead of the side panel; the build derives its file list from the release workflow so packages never drift. Firefox build is validated structurally but not yet tested live.

## [6.11] - July 10, 2026

### Features
- **Feature:** **True PDF receipts** — a new 'PDF receipt (.pdf)' export format generates real PDF files directly in the extension via a built-in, dependency-free PDF writer: per-order receipts (items table, totals, payment/shipping meta, multi-page with repeated headers) and a Quick Export summary table. No more print-to-PDF detour.

## [6.10] - July 10, 2026

### Features
- **Feature:** **QuickBooks & Xero CSV presets** — a CSV preset selector (shown when CSV format is chosen) exports bank-import-ready files: QuickBooks 3-column (Date, Description, Amount) or Xero (Date, Amount, Payee, Description, Reference), with negative amounts for money spent and MM/DD/YYYY dates.

## [6.9] - July 10, 2026

### Features
- **Feature:** **In-store purchases** — a new 'Order Type' column in every export (Excel, CSV, JSON, Quick Export) distinguishes in-store purchases from online orders, completing the full Walmart spending picture.

## [6.8] - July 10, 2026

### Features
- **Feature:** **Price history on repurchases** — the dashboard now tracks items you've bought more than once (keyed by Walmart item id) and shows how their unit price moved, e.g. "you paid \$4.98, it was \$3.98 before". History deepens as you download invoices.

## [6.7] - July 10, 2026

### Features
- **Feature:** **Spending Dashboard** — a new panel view computed entirely on-device from the local order database: total/average spend, monthly spend bars, tips, savings, tax, refunds, donations, and your most-repurchased items. No servers, no telemetry — your data never leaves the browser.

## [6.6] - July 10, 2026

### Features
- **Feature:** **Local order database** — collected orders and downloaded invoices are now stored durably on-device (IndexedDB), surviving the 24-hour cache and browser restarts. A stats line in the panel shows what's stored, with a one-click clear.
- **Feature:** **Incremental collection** — new "Only collect new orders" toggle stops pagination as soon as a whole page of already-stored orders is reached, making regular syncs fast instead of re-crawling the entire history.
- **Feature:** Quick Export now falls back to the local database when the collection cache has expired — export without re-collecting.

### Fixes
- **Fix:** Quick Export respects the order selection — ticked orders export alone; nothing ticked exports everything collected.

## [6.5] - July 9, 2026

### Internal
- **CI regression suite:** sanitized `__NEXT_DATA__` fixture files + unit tests for the payload extractors, Quick Export summaries, CSV escaping (formula injection, BOM, RFC-4180), receipt HTML escaping, and the extraction-warning tripwire — running on every push via GitHub Actions (`ci.yml`). Prevents the next silent-breakage incident like the one v6.3 fixed. No user-facing changes.

## [6.4] - July 9, 2026

### Fixes
- **Fix:** Restored reliable extraction after Walmart removed the `w_*` CSS classes that v6.2 depended on — order data now comes from Walmart's page payload (`__NEXT_DATA__`) first, with network snapshots and the DOM as fallbacks. This resolves the "repeated blank entries" reports.
- **Fix:** Pagination now verifies the order list actually changed before advancing, and duplicate "View details" buttons on multi-shipment orders no longer produce duplicate entries.
- **Fix:** If Walmart changes their site again and fields come back empty, the extension now shows a warning banner instead of silently exporting blank data.

### Features
- **Feature:** **Quick Export** — one click builds a summary spreadsheet (order number, date, item count, item names, status, fulfillment, subtotal, tip, total) straight from the order list, without opening any order pages
- **Feature:** **Export formats** — choose Excel (default), CSV (RFC-4180, accounting-friendly numbers, orders + items files), JSON (full structured data), or a printable HTML receipt (open in browser, print to PDF)
- **Feature:** **New export columns** — marketplace seller(s), fulfillment type, delivered date, tracking numbers, refund, donations, per-card payment split, and a receipt barcode link
- **Feature:** **Product thumbnails (opt-in)** — optionally embed product images in Excel exports; falls back to image links when images can't be fetched (default off)
- **Feature:** **Filter awareness** — when your Walmart orders page has filters applied (date range, status, …), the panel now says so, since collection follows your filtered view

## [6.3] - March 25, 2026

### Improvements
- **Enhancement:** Added dual order-detail extraction (`__NEXT_DATA__` + DOM fallback) for more reliable exports
- **Enhancement:** Simplified Excel output by removing duplicate/non-essential fields: `Order Number (Display)`, `Barcode Data`, `Fee Breakdown`, and `Charge History`
- **Fix:** `Payment Method` no longer repeats message text; message content stays in `Payment Messages`
- **Refactor:** Removed fee-breakdown and charge-history keys from the scraped payload

## [6.0] - March 17, 2026

### Fixes
- **Fix:** Corrected extraction of all financial fields — subtotal, order total, tax, delivery charges, and tip — which were broken due to Walmart updating their DOM from `w_*` CSS classes to `ld_*` classes
- **Fix:** Tax amount now reliably extracted from the `.print-fees-item` price row instead of defunct class selectors
- **Fix:** Tip (`Driver tip`) now correctly extracted using text-based lookup on flex rows
- **Fix:** Order total now reads from `span` elements inside `.bill-order-total-payment` (Walmart changed from `h2` to `span`)
- **Fix:** Subtotal now extracts just the dollar amount from the last span in the row instead of the entire div `innerText` (which included the "Subtotal" label)
- **Fix:** Payment method extraction completely fixed — was returning empty due to defunct `.print-bill-payment-section` selector; now uses `[aria-labelledby^="card-description-"]` which matches the actual card spans

### Refactor
- **Refactor:** Modularized side panel logic into separate focused modules: `sidepanel.state.js`, `sidepanel.view.js`, `sidepanel.actions.js`, `sidepanel.download.js` — greatly improving maintainability
- **Refactor:** Improved image blocking logic with better error handling and MutationObserver optimizations
- **Enhancement:** Collection button and cache indicator handling improved for more reliable UI state management
- **Enhancement:** `ORDER_SUBTOTAL` selector now also matches `span[aria-label^="Subtotal after savings"]` for discount scenarios

## [5.2] - February 3, 2026

### Features
- **Feature:** Added shipping address and payment method to exported invoice details
- **Feature:** Added Order Total, Sub Total, Tax, Tip column to both multiple and single file mode


### Fixes
- **Fix:** Always collect order numbers to ensure cache is up to date with latest orders
- **Fix:** Updated caching system to use local storage instead of session storage for better persistence
- **Fix:** Minimum Chrome version requirement set to 116

### Enhanced Invoice Details
Exported invoices now include:
  - Shipping address
  - Payment method
  - Delivery charges
  - Tax
  - Tip
  - Order subtotal
  - Order total (both single and multiple file modes)

## [5.1] - January 31, 2026

### Features
- **Feature:** Added Order Subtotal column to both single and multiple invoice export modes

- **Enhancement:** Multiple files export now shows subtotal and order total columns

## [5.0] - December 28, 2025

### Side Panel UI
- **Feature:** Converted popup to persistent Chrome Side Panel that stays open while browsing
- **Feature:** Integrated FAQ directly into side panel with accordion navigation
- **Feature:** Added off-tab warning banner when navigating away from Walmart orders (preserves collected data)
- **Feature:** Added confirmation dialog when navigating to FAQ during active collection or download
- **Feature:** Added placeholder UI showing collection state before starting
- **Feature:** Added "Rate on Chrome Web Store" footer to both main view and FAQ
- **Enhancement:** Side panel persists across tab navigation - no more losing progress
- **Enhancement:** Click-to-return link to switch back to Walmart orders tab
- **Removed:** Standalone FAQ page (now inline in side panel)
- **Removed:** Old popup.html, popup.js, popup.css (replaced by sidepanel files)

### Performance Improvements
- **Performance:** Reduced element wait timeout from 30s to 10s for faster failure detection
- **Performance:** Decreased DOM polling interval from 500ms to 200ms for quicker element discovery
- **Performance:** Added early image interception using beforeload and error event listeners
- **Performance:** Optimized MutationObserver by disabling attribute and characterData monitoring
- **Performance:** Simplified order extraction to single-pass DOM traversal

### Code Quality
- **Refactor:** Removed unused variables (OrderNumberRegex, allOrderNumbers, currentPage, isProcessing)
- **Refactor:** Added JSDoc documentation to all major extraction functions
- **Refactor:** Converted let declarations to const where values are immutable
- **Refactor:** Added optional chaining to prevent null reference errors
- **Refactor:** Centralized timing constants in CONSTANTS.TIMING

## [4.0] - November 16, 2025
- **Feature:** Implemented caching for invoice data in Chrome local storage after the first download. Subsequent downloads check the cache first and use cached data if available, significantly speeding up the process.
- **Enhancement:** Refactored code to use centralized constants for selectors, text, and CSS classes in `utils.js` for better maintainability.

## [3.3] - November 15, 2025
- **Fix:** Resolved issue with order number extraction due to changes in Walmart's order history page structure.

## [3.2] - August 9, 2025

- **Feature:** Added Export mode selector (Multiple files or Single combined file)
  - New option in the popup to choose between downloading one XLSX per order or a single XLSX containing all selected orders
  - Combined export is processed sequentially in one background tab for reliability
  - Uses ExcelJS in the popup to generate a single workbook with all items
- **Enhancement:** Content script now supports structured data retrieval (no download) to power combined export
- **Note:** Existing multiple-file download flow remains unchanged

## [3.1] - March 25, 2025

- **Enhancement:** Added order description tooltip functionality
  - Hover over order numbers to see order delivery date or if it's canceled or returned order
  - Displays order delivery date from order history without downloading the order invoice
  - Makes identifying and selecting specific orders much easier

## [3.0] - March 25, 2025

- **Feature:** Implemented local storage caching system
  - Automatically stores previously collected order numbers
  - Dramatically improves loading time for repeat usage
  - Shows cache timestamp and source information
  - Includes option to clear cache when fresh data is needed
  - Cache automatically expires after 24 hours
- **Enhancement:** Improved memory management during order collection
- **Enhancement:** Updated FAQ with information about the caching system

## [2.5] - January 5, 2025

- **Enhancement:** Improved performance by blocking image loading in background tabs
  - Faster page loading during order collection and invoice download
  - Reduced network usage

## [2.4] - January 5, 2025

- **Enhancement:** Feature: Added comprehensive FAQ page with troubleshooting guides
  - Step-by-step instructions for single and batch downloads
  - Chrome settings configuration guide for bulk downloads
  - Common issues and solutions
  - Guide for merging multiple Excel files

## [2.3] - December 19, 2024

- **Fixed:** Resolved an issue with failed invoice downloads for new in-store orders.

## [2.2] - December 5, 2024

- **Enhancement:** Walmart orders page link clickable in popup.

## [2.1] - December 1, 2024

- **Enhancement:** Improved UI.

## [2.0] - November 26, 2024

- **Feature:** Added support for downloading multiple invoices at once.
- **Feature:** Introduced new order history crawler.
- **Update:** Improved invoice downloading system.
- **Enhancement:** Enhanced user interface with progress tracking.

## [1.4.1] - August 30, 2024

- **Update:** Improved order number extraction to handle various formats, including in-store purchases.

## [1.4] - August 29, 2024

- **Enhancement:** Improved invoice parsing using print-bill classes for better order delivery status accuracy.
- **Feature:** Added tip, tax, and delivery charges to the exported invoice.
- **Update:** Separated product name and links into different columns in the Excel file.

## [1.3] - August 27, 2024

- **Fixed:** Resolved an issue where xlsx invoice files were not downloading.
- **Update:** Changed the extension name to Walmart Invoice Exporter.
