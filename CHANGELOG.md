# Changelog

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
