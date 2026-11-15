# Release 8.8: what was verified

Date: 2026-11-14. Release branch `codex/reliability-audit` (pull request #50),
final commit `d009d73`. This records what was checked, how, and what was not,
so the next release can repeat it. The procedure is in
`.opencode/skills/release-verification/SKILL.md`.

No personal data is recorded here: counts and outcomes only.

## Result

8.8 was ready to release. Test suites, both builds and the release build
passed on GitHub; the zip GitHub built was identical, file for file (53
files), to the build that was tested.

## Checks and outcomes

| Area | How | Outcome |
|---|---|---|
| Unit suites | Node and Vitest on the final extension code | 345 and 303 passed |
| Packaged extension, mock Walmart | Chromium end-to-end suite | 41 passed |
| Extraction on the live site | Provider code run on 25 real orders (5 history pages) in the user's signed-in browser | Every order complete; payment amounts equal to the order total on all 25 |
| Packaged build on real order pages, served locally | 11 orders: 3 fully canceled, 3 partly canceled, 5 delivered | Collection 11 of 11. Excel, CSV (generic, QuickBooks, Xero), JSON, receipt, PDF, one file per order, legacy layout and product photos all produced correct files. Partly canceled orders exported exactly the delivered lines |
| Refund arithmetic | Saved invoices of real orders | Order total equals subtotal plus fees, tax and tip, minus the refund: totals are already net of refunds |
| Dashboard on real data | All views, inline invoices | Total equals the sum of exported order totals; average leaves out fully canceled orders; no errors |
| Human check, simulated on real pages | One order served as the check page | Run stopped, finished orders kept, "Retry failed" completed the rest |
| Human check, live | Packaged build in an automated browser on walmart.com | Walmart challenged the browser; the run stopped with the notice and no false alert |
| Settings | Every control through the UI | Stored, persisted across reload, synced to the main view; limits clamped; delete-all and reset behave as labeled |
| Local AI bridge | Published relay `walmart-invoice-mcp` 0.2.0, MCP over stdio | Off by default; paired in 15 s; read tools matched seeded data; action tools refused until the second opt-in; wrong token rejected; relay on 127.0.0.1 only |
| Update from 8.3 | 8.3 store zip, then 8.8 in the same directory and profile | 21 saved orders unchanged record for record; settings and dashboard figures unchanged; no errors |
| Privacy and network | Search of the shipped files | Only Walmart, product image links and 127.0.0.1; no analytics, no remote code; bundled Excel library identical to 8.3 |
| Links | Listing, README, privacy policy | 15 of 16 returned 200; the npm page refuses scripted requests (the package exists) |
| Release zip | `unzip -v` listing of GitHub's zip against the tested build | Identical |

## Defects found by this pass, fixed in 8.8

- QuickBooks and Xero exports wrote a $0.00 line for each fully canceled order.
- "Reset settings to defaults" left "Allow AI tools to collect data" on.
- Dashboard headline figures were cut off once a total reached five digits at
  1280 and 1440 px wide (also present in 8.3).
- Fully canceled orders exported as an unexplained empty order; they are now
  labeled in Excel and on receipts.

## Not verified

- A complete export by the packaged build directly against live walmart.com.
  Walmart's human check stops automated browsers, and it was not worked around.
- In-store orders and Walmart Canada on live accounts. The account used had
  no in-store order among its 25 most recent.
- An export on 8.8 of a pristine invoice saved by 8.3. The headless test
  browser crashed when a collection started on a reused profile (it did the
  same with 8.3 on 8.3 and 8.8 on 8.8). The one export that did succeed was of
  an invoice 8.8 had already refreshed.
- The fix for issue #22 against an order that reproduces the original report.

## Known behavior worth telling users

- After the update, the first export of orders saved by 8.3 opens each order
  page once to refresh it.
- Offline replays of an order paid with two methods show the "amount per
  method unavailable" notice, because a saved page cannot open Walmart's
  charge-history panel. On the live site those amounts were read.

## Work after 8.8 (branch `feature/order-insights`, not released)

Built and tested: a notice when a collection stops early; optional per-item
and per-order details read from Walmart's payload; the matching export
columns and a "Not Fulfilled" sheet; a Categories view and a Missed items
view on the dashboard. Extraction version raised to 6.

Suites on that branch: 366 Node, 316 Vitest, 41 end-to-end.

Checked on 9 real orders served locally (2 fully canceled, 2 partly canceled,
5 delivered):

- Every saved invoice carried an order status ("Canceled", "Partly canceled",
  "Delivered") and the store; charged-line and unfulfilled-line counts
  matched an independent count from Walmart's payload.
- All 86 charged lines had a price each and a category path; 85 mapped to a
  known department (one department id is not in the table yet).
- Price each times quantity equaled the line total on 82 of 83 lines that are
  not weight adjusted.
- 58 lines that were ordered but never charged were recorded apart from the
  charged lines.
- Lines flagged substituted, weight adjusted and returned (2, 3 and 4)
  equaled the counts in Walmart's payload.
- The Excel export had three sheets (9 orders, 86 items, 58 not fulfilled).
  Order Status and Store were filled on all 9 orders; Price Each and
  Returnable on all 86 lines; Category on 85.
- The Categories and Missed items views rendered the same data with no
  errors. One expensive item from the unmapped department landed in "Needs a
  category", which is where the user assigns it.

Added afterwards on that branch: the same details for Walmart Canada
(unit-tested only), the Services department (`6163033`), version 8.9, and an
end-to-end test that sets a category by hand, reloads, and resets it.
