# Featured-badge nomination draft

> Where: One Stop Support page → "My item" → "I want to nominate my extension
> for the Featured badge". Submit ONLY after v8.0 is live and the new
> screenshots + description are up — reviewers judge the live listing.
> Prerequisites checklist is in README.md.

## What does your extension do? (purpose)

Walmart Invoice Exporter turns a Walmart customer's order history into a
private spending dashboard and usable documents. The dashboard shows monthly
spend on an interactive chart (click a month to drill in), lets users expand
any order into its complete invoice inline — items, prices, full money
breakdown, payment methods — and surfaces insights like biggest order,
savings rate, busiest day, and price changes on repurchased items. From the
same data, users export Excel workbooks, CSV (including QuickBooks/Xero
presets), JSON, PDF invoices, and printable receipts. It solves a real gap:
walmart.com offers no bulk export or spending overview, so anyone doing
taxes, expense reports, or budgeting must open orders one by one.

## What value does it provide to users?

- Turns hours of manual copy-paste into a two-click export; users routinely
  export full years of orders for tax reporting and reimbursements.
- A spending dashboard users can't get anywhere else — monthly trends,
  drill-down invoices, price watch, most-bought items — computed entirely
  from their own data, entirely on-device.
- Fast, respectful collection: an optional fast mode reuses the user's own
  logged-in session (with automatic fallback to classic paging), "only new
  orders" makes re-syncs quick, and Walmart's own filters (order type + date
  range) scope exactly what gets collected.
- Households with multiple Walmart accounts get clean per-account data,
  detected only by a privacy-preserving hash — never a name or email.
- Strong privacy posture: no accounts, no servers, no analytics; all data
  stays local, with per-account delete, a single verifiable "Delete all
  saved data" control, and optional inactivity cleanup (data wipes itself
  after 180 unused days by default).
- Free, open source (GitHub), with an in-product Help & FAQ.

## Example use cases

1. A small-business owner exports Q1–Q4 Walmart orders into one Excel workbook
   as supporting documents for tax filing.
2. A family tracks grocery inflation: the dashboard's Price Watch shows which
   staples got more expensive since their first purchase, and the insights
   card shows savings rate and their most-bought item.
3. A user reconciles HSA/FSA or reimbursable purchases by collecting with
   Walmart's own filters (order type + date range), clicking the relevant
   month on the dashboard chart, and exporting exactly that scope.
4. A couple sharing one browser keeps their Walmart accounts separate: each
   account's orders, totals, and exports stay scoped to that account.
5. A power user exports JSON/CSV and feeds it to a spreadsheet or AI assistant
   for personalized budget analysis.

## Technical best practices (mention if the form asks)

- Manifest V3; side panel API; no remotely hosted code — all libraries
  (including Chart.js for the dashboard) bundled.
- Least privilege: host access limited to walmart.com order pages, with
  walmart.ca as an optional permission the user grants explicitly; no new
  permissions for the dashboard page.
- All parsing, charting, and file generation is local; the extension never
  calls external servers. Multi-account detection stores only a hash.
- Respects user privacy by architecture, not just policy: no data collection
  is declared in the privacy tab and the code is publicly auditable.
- Automated quality: a unit-test suite (node:test + Vitest) and a Playwright
  end-to-end suite that drives the real packaged extension, including
  download verification, on every push.
- Accessible, polished UI: one design language in light and dark across
  panel, settings, and dashboard; keyboard-navigable views; ARIA live
  regions for progress; reduced-motion support.
