# Reliability audit — October 14, 2026

## Scope and outcome

Work continued without sub-agents after the user's instruction to stop them. The starting commit was `b7bf537`; work is committed on `codex/reliability-audit`. Upstream was fetched and had no incoming commits. Existing category-feature files and the saved session transcript were untracked before this audit and were preserved.

This is a review and regression-hardening pass across extraction, collection, exports, persistence, dashboard views, local AI access, capture tooling, and packaging. It is not a certification of every Walmart API, account variation, or future deployment.

## Confirmed defects and fixes

| Area | Reproduced problem | Result |
| --- | --- | --- |
| US charged items | All-unavailable/canceled categories fell through to ordered-item copies and DOM rows | Explicit item arrays remain authoritative even when no charged lines survive |
| Redesigned summaries | The first fix incorrectly treated category labels without item arrays as an authoritative empty invoice | A full browser regression caught this; metadata-only categories now allow rendered invoice items |
| Canada charged items | The older adapter included unavailable lines and collapsed legitimate duplicate lines | Uses the charged-category traversal and DOM merge safeguards, retaining Canada product URLs |
| Payment inference | A missing allocation could become negative when known charges exceeded the invoice total | Leaves the allocation unknown so existing warnings remain actionable |
| Empty invoice response | A missing response immediately navigated to another URL | Retries the same page once before trying the alternate URL |
| Saved invoices | Updated extraction could be bypassed by current-schema older saved data | US extraction marker is now 5; Canada has marker 1; older records refresh, with a warning on stale fallback |
| Financial export parity | HTML/PDF receipts and legacy bulk Excel omitted promos, express/returned fees and extra adjustments | These amounts are exported; legacy column positions are preserved by appending columns |
| Receipt rendering | Numeric zero totals were omitted; receipts bypassed payment-split alias normalization | Explicit zeros remain visible; receipts use the shared split formatter; long PDF adjustment labels wrap |
| Export links | Receipt barcode URLs bypassed the product-link safety gate | Spreadsheet hyperlinks and receipt image URLs use the same HTTP(S), no-credentials validation |
| Dashboard refresh | An older asynchronous read could overwrite a newer invoice/account/provider view | Refresh generations reject superseded results; account selection is captured for each read |
| Inactivity retention | NaN/nonpositive timestamps and blank/boolean windows could cause premature deletion | Invalid baselines cannot authorize deletion; blank windows use the default |
| Partial API collection | Throttling/query failures or repeated cursors could leave partial history marked complete | Keeps collected pages, persists them, preserves the account, and requests classic rescue; explicit page limits remain intentional stops |
| Main-world replay | A prefix check allowed normalized traversal and unrelated Orchestra operations | URL origin and normalized purchase-history operation path are checked before using captured headers |
| Local AI summaries | Summaries ignored newer invoice totals, including zero | Prefer the current invoice, then valid summary amounts |
| Local AI connection | Calls could run before pairing; inherited tool names were accepted; an old socket could disconnect a replacement | Pairing and own-tool checks plus socket identity guards |
| Capture tooling | The allowlist removed named financial adjustment labels from regression captures | Retains the known labels and adds a synthetic financial reconciliation scenario |
| Branch releases | Release publishing ran independently of the CI result | Release workflow now runs both unit suites and the packaged-extension browser suite before replacing releases |

The new failure cases were reproduced before their relevant fixes. The dashboard refresh test deliberately releases an older database read after a newer invoice has rendered. The packaged browser suite exposed the metadata-only-category regression and passed after its correction.

## Verification

The clean committed snapshot, excluding pre-existing untracked drafts:

- **327 Node tests passed.**
- **291 Vitest tests passed** across 31 files. These are largely a port of the Node tests, not an additional 291 independent scenarios.
- **40 Chromium integration/end-to-end tests passed.** They cover the packaged extension, real download files, collection, both export modes, cache refresh/migration, dashboard navigation, stale refreshes, frame boundaries, charge-history scraping, and the offline corpus.
- Chrome and Firefox MV3 builds and ZIP packaging succeeded for **8.8**.
- Extension JavaScript syntax checks, workflow YAML parsing, and `git diff --check` passed.
- A generated PDF receipt was rendered with Poppler and visually inspected for amount alignment and long-label wrapping.

The working tree including the unfinished category draft is **not fully green**: Node reports 329 passing / 3 failing; Vitest reports 293 passing / 3 failing. All three failures are in the pre-existing untracked category tests: category naming, classification expectations, and the expanded empty-summary shape. Those files were neither edited nor included in the clean release candidate. They must be reconciled before integrating that feature.

The eight-case offline corpus includes one layout derived from an anonymized live page plus explicitly synthetic layouts/variants. The additional financial case checks promo, express fee, returned fee, refund, donation, unknown adjustment, total, and tender split. Synthetic fixtures are not presented as additional live account captures.

Earlier signed-in Chrome checks in this conversation observed valid charge-history requests for Visa/Walmart Cash, adjusted PayPal, and Gift Card/PayPal. Chrome replay also returned a valid ledger with the PR's existing query hash. The new 8.8 package was validated in isolated Chromium; it was not installed or reloaded into the user's signed-in profile during this audit.

## Remaining limits and follow-up work

1. **The ledger accounting PR remains unmerged.** Its direct query still worked in the sampled live session, but hardcoded hashes remain a maintenance dependency. Its card detector also classifies gift-card endings as credit cards, its clean-order path omits non-card totals, and it lacks separate PayPal refund accounting. Invoice allocations must remain distinct from gross bank charges and refund credits.
2. **Unavailable source data remains unknown.** Charge-history totals can cover adjustments/fulfillment groups beyond the displayed invoice. Multiple unresolved allocations cannot be established by guessing. Missing/ambiguous cases need anonymized evidence and warnings.
3. **Live Canada parity is not established.** Shared charged-item fixtures now pass, but the US-only redesigned-page and payment-drawer work is not a claim that every Canada layout or financial field is covered. No signed-in Canada account was tested in this pass.
4. **The category draft remains unfinished.** Its tests are reported above, and its navigation/view files remain unintegrated.
5. **One high dependency advisory remains.** The installed graph reports `node-forge` 1.4.0 through `wxt → web-ext-run → @devicefarmer/adbkit`. This is development tooling, not an application import in the shipped extension. The audit metadata mentions a patched version, but the npm query for 1.4.1 returned no published version; the [GitHub advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv) also lists no patched release at this check. No audit suppression or private cryptographic patch was introduced. The installed dependency audit does not certify vendored assets.
6. **Local package-manager tooling has a compatibility problem.** The system's Corepack signing keys blocked `pnpm`, and system Node 23.3 could not run the current pnpm package's SQLite import. Tests/builds ran through installed executables, and the dependency audit used the bundled Node runtime. No signature verification was disabled.
7. **The browser suite uses controlled Walmart responses.** It verifies extension behavior reproducibly, including malformed inputs, but does not prove compatibility with every authenticated production order or future website change. API challenges, delayed drawer rendering, new fee labels and new account layouts still require ongoing capture coverage.

## Small features worth considering after reliability work

These are proposals, not newly implemented features:

1. **Refresh selected saved invoices** — an explicit action to bypass a valid cache after a later refund or tip change, with a visible last-refreshed time.
2. **Export validation summary** — show missing fields, inferred payment allocations and reconciliation differences before downloading, with a small accompanying diagnostics sheet if requested.
3. **Provider/currency provenance** — carry source site and currency into combined exports so US and Canada amounts cannot be mistaken for a single currency.
4. **Account-specific budgets** — the existing monthly-budget feature currently uses one global preference; scope it by account/provider if separate targets are needed.

No additional product features or PR merge were performed during the audit. Commits and the clean 8.8 build are available for review and manual verification.
