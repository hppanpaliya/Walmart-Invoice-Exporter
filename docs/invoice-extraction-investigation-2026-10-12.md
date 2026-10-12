# Invoice extraction investigation — October 12, 2026

## Scope and status

Issue #36 describes three symptoms: intermittent empty invoices, missing delivery fees, and missing in-store split-tender amounts. It hypothesizes page-loading or selector failures; it does not establish the cause. The similarly titled warning reports do not prove a shared root cause. Issue #22 (dates/status/order IDs) is separate.

The first patch repaired a verified handling bug: a truthy, incomplete scrape could be cached and counted as successfully exported. Live inspection subsequently established an additional compatibility failure on a redesigned Walmart order page. The first patch alone did not fix that layout.

## Live observations

The signed-in Walmart order page in the user's connected Chrome displayed a complete invoice, but:

- `.dn.print-items-list` matched zero elements.
- `.bill-order-total-payment` and the legacy subtotal selector were absent.
- `__NEXT_DATA__` had no order at the scraper's supported detail paths. Its page props contained `phRedesignInitialData.data.purchaseHistory.orders` instead.
- Product rows used `[data-testid="itemtile-stack"]`, `.print-item-title`, `[data-testid="productName"]`, `.bill-item-quantity`, and `[data-testid="line-price"]`.
- Payment totals appeared as labelled rows under `.bill-order-payment-spacing`, including a temporary authorization total that must not replace the final total.
- Two unavailable product rows retained prices. Reading every product row overstated the invoice subtotal.

Read-only execution of the new DOM extraction logic on that live page returned 20 charged lines representing 21 items. Their line prices summed to $47.44. Delivery $0, bag fee $0.40, tax $0.20, and tip $5.44 reconciled to the displayed final total of $53.48. Two uncharged rows were excluded.

This is a verified compatibility failure on the observed page. It is not proof that the reporter's two historical failures had precisely the same cause.

## Changes

- Validate the requested order identity, usable items, and a numeric total before caching or exporting. Recheck an incomplete page once, then try its alternate route. Persistently incomplete results become named failures eligible for Retry failed.
- Apply the same minimum checks to cache reuse, stale fallback, and fast invoice responses.
- Skip combined-file output when no order succeeded.
- Read redesigned product rows, excluding unavailable/canceled sections, and keep product names separate from descriptions and quantities separate from final weights.
- Read redesigned total/fee rows. Exclude repeated accessibility descriptions, crossed-out delivery prices, and temporary authorization totals. Combine distinct delivery and express fee rows.
- Recover metadata only from the embedded history summary whose ID matches the current detail URL. DOM lines remain essential because these summaries can omit item prices and detailed fees.
- Preserve payment card names carried by image alt text when the content host blocks images. The complete export test exposed this separate failure: the amount survived but the Visa name was removed.

## Validation and limits

The original handling bug was reproduced by regression tests: ten tests failed against the original fetcher and passed with its patch. A Chromium integration test runs the actual provider against a synthetic fixture matching the observed redesigned DOM. It checks charged lines, identity, links, status, weights, totals, paid/free/express delivery, split tenders, and operation without an embedded order summary. No personal identifiers or order contents were copied into the fixture.

The rendered live invoice was also saved locally and reduced to an anonymized fixture retaining its real DOM structure and monetary values. Backend replay in actual Chromium reproduced the failure with the original provider (zero items, blank total) and verified the patched provider (20 charged lines, $47.44 subtotal, $53.48 total, Walmart Cash $2.50 plus Visa $50.98). The generated Excel file was reopened and its rows and total checked.

The built extension was then loaded into isolated Chromium with Walmart requests served locally. The test exercised its actual collection and export UI, content host, cache, combined workbook, and per-order workbook against the captured DOM. Both exported files were reopened and checked. This required no reload of the user's installed extension. The user's signed-in Chrome supplied the live-page evidence; the complete export ran against the captured page in isolated Chromium, not against live authenticated Walmart requests.

Validation completed: 278 Node tests, 268 Vitest tests, and 22 Chromium integration/end-to-end tests passed. Chrome and Firefox builds succeeded. `git diff --check` passed.

The subsequent dashboard, export, dependency, and reusable capture work is documented in [hardening-2026-10-12.md](hardening-2026-10-12.md), with the expanded final validation results and remaining security finding.

Reproduction: `node --test tests/e2e/live-invoice.e2e.js` runs the packaged extension against the checked-in anonymized capture. `node scripts/verify-invoice-capture.cjs /path/to/saved-invoice.html [baseline-ref]` sanitizes a new local capture and compares the providers (default baseline `faae6af27e38e46dc6ed189b0924aa7a3e9a875e`); its assertions intentionally describe this particular invoice. The latter writes `output/playwright/Verified_Invoice.xlsx`.

Remaining limits:

- The reporter's exact affected pages/payloads are unavailable.
- The already-installed extension in the user's Chrome profile has not been updated or exercised through its export UI.
- In-store split amounts are still unresolved when Walmart supplies no amounts; inventing them would be incorrect.
- Issue #22 has not been fixed by these changes.
- No guarantee covers all layouts, order types, account variants, future Walmart changes, or every field. Missing fields outside the minimum validation requirements can still need investigation.
- Previously cached invoices with usable items and totals can retain old optional-field errors, including missing fees; this patch does not rewrite those records automatically.
