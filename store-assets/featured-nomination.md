# Featured-badge nomination draft

> Where: One Stop Support page → "My item" → "I want to nominate my extension
> for the Featured badge". Submit ONLY after v7.x is live and the new
> screenshots + description are up — reviewers judge the live listing.
> Prerequisites checklist is in README.md.

## What does your extension do? (purpose)

Walmart Invoice Exporter lets Walmart customers export their complete order
history into usable documents — Excel workbooks, CSV, JSON, PDF invoices, and
printable receipts — and understand their spending through a built-in
dashboard (monthly totals, price changes on repurchased items, most-bought
items). It solves a real gap: walmart.com offers no bulk export, so anyone
doing taxes, expense reports, or budgeting must open orders one by one.

## What value does it provide to users?

- Turns hours of manual copy-paste into a two-click export; users routinely
  export full years of orders for tax reporting and reimbursements.
- Spending insights users can't get anywhere else, computed entirely from
  their own data, entirely on-device.
- Strong privacy posture: no accounts, no servers, no analytics; all data
  stays local with a single verifiable "Delete all saved data" control.
- Free, open source (GitHub), with an in-product Help & FAQ.

## Example use cases

1. A small-business owner exports Q1–Q4 Walmart orders into one Excel workbook
   as supporting documents for tax filing.
2. A family tracks grocery inflation: the dashboard's Price Watch shows which
   staples got more expensive since their first purchase.
3. A user reconciles HSA/FSA or reimbursable purchases by exporting a specific
   date range using Walmart's own filters plus the extension's scoped export.
4. A power user exports JSON/CSV and feeds it to a spreadsheet or AI assistant
   for personalized budget analysis.

## Technical best practices (mention if the form asks)

- Manifest V3; side panel API; no remotely hosted code — all libraries bundled.
- Least privilege: host access limited to walmart.com order pages; no new
  permissions for the dashboard page.
- All parsing/generation is local; the extension never calls external servers.
- Respects user privacy by architecture, not just policy: no data collection
  is declared in the privacy tab and the code is publicly auditable.
- Automated quality: 150+ unit tests and a Playwright end-to-end suite that
  drives the real packaged extension, including download verification.
- Accessible UI: keyboard-navigable views, ARIA live regions for progress,
  dark mode following system preference.
