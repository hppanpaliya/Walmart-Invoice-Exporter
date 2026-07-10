# Project Handoff — Walmart Invoice Exporter v6.4 work

> **Purpose of this file:** Complete context for any engineer (human or AI) picking up this work.
> Covers: what was diagnosed and verified, all available Walmart data, the owner's decisions,
> the commit-by-commit plan with current status, hard constraints, and how to test.
>
> Companion doc: [`ROADMAP.md`](./ROADMAP.md) — deferred future features + engineering principles.
>
> Last updated: 2026-07-09

---

## 1. Background: the "repeated entry" incident (diagnosed & fixed)

Chrome Web Store reviews reported "repeated entries" in exports. Root cause was **verified live
against a real logged-in Walmart account** (2026-07-09):

- The store version **6.2** (`main` before this work — commit `4626af5`, a revert to `736a810`)
  scraped the DOM using `w_*` CSS classes (`w_U9_0.w_sD6D.w_QcqU`) that **Walmart deleted**.
  Result on a real order: 4 item rows, all with EMPTY product name/qty/price → users saw
  N identical blank rows = "repeated entries". Order total also extracted EMPTY.
- Second contributing bug: 6.2's pagination clicks "Next" and returns success **without verifying
  the page actually changed**, and its `checkForNextPage` merely checks the button exists
  (Walmart leaves it in the DOM on the last page).
- Also verified live: Walmart renders **duplicate "View details" buttons** for multi-shipment
  orders (one order had 3 buttons) — any non-dedup'd collection path multiplies entries.

**The fix (branch `fix`, v6.3, now merged into `main` at `20f2610`):**
- Extracts from the `script#__NEXT_DATA__` JSON payload first → network request payload
  snapshots → DOM as last resort.
- Dedups order numbers via `seen` Set; verifies pagination transitions via
  `getOrderListSignature()` + `waitForOrdersListTransition()` before advancing.
- Verified live: same order that produced 4 blank rows on 6.2 produced 4 correct rows
  (names, prices, per-item status incl. "Canceled") with subtotal $18.53 / total $24.11 on 6.3.

**Store action items:** publish 6.4 when this work lands; reply to "repeated entry" reviews
explaining Walmart changed their site and v6.3+ fixes it.

---

## 2. Verified data inventory (what Walmart exposes)

All confirmed live on a real account, 2026-07-09.

### 2a. Order DETAIL page — `script#__NEXT_DATA__` → `props.pageProps.initialData.data.order`

| Category | Fields |
|---|---|
| Identity | `id`, `displayId`, `orderDate` (ISO 8601 + timezone), `type` ("GLASS"=online; in-store exists), `title`, `shortTitle`, `itemCount`, `timezone`, `isInStore`-adjacent flags |
| Financial (`priceDetails`) | `subTotal`, `taxTotal`, `grandTotal`, `grandTotalWithTips`, `authorizationAmount`, `fees[]` (labeled, e.g. "Free delivery from store"), `discounts[]`, `savings`, `allSavings`, `strikethroughSubTotal`, `driverTip`, `donations`, `monthlyPayment`, `rewards`, `refund` |
| Payment | `paymentMethods[]`: `cardType`, `description` ("ending in …"), `paymentType`, `paymentPreferenceId`, `displayValues` (per-card amounts), `message`, `billingAddress`; plus `tippingPaymentMethod`, `refundPaymentMethods`, `chargeHistory` (title/message — actual charges vs estimate) |
| Per group/shipment (`groups_2101[]`) | `fulfillmentType`, `status` (message parts), `deliveryDate`, `deliveredDate`, `seller` (name/contact/address — marketplace!), `store`, `driver`, `shipment` + `multiPackageDetails` (tracking), `pickupPerson`, `pharmacyInfo`, `returnEligibilityMessage`, `deliveryInstructions`, `cancellationBanner`, `subGroups[].categories[].items[]` |
| Per item | `productInfo.name`, `productInfo.usItemId` (→ `walmart.com/ip/{usItemId}`), `productInfo.imageInfo.thumbnailUrl` (i5.walmartimages.com), `offerId`, `quantity`, `requestedWeight`, `priceInfo.linePrice.displayValue`, `isAlcohol`, `salesUnitType`, `conditionBadge`, `bundleComponents`, `addOns` |
| Meta | `idBarcodeImageUrl` (ready-made receipt barcode: `receipts-query.edge.walmart.com/barcode?...`), `wPlusMembershipStatus`, `customer` (name/email), `orderInvoiceDetails`, `digitalInvoiceDetail` |

### 2b. Purchase-history LIST page — payload per order (no detail visit needed!)

`id`, `displayId`, `orderDate` (ISO), `itemCount`, `type`, `isInStore`, `title`,
`priceDetails: { orderTotal, subTotal, driverTip }` (each `.displayValue`),
`groups[]` (note: `groups`, NOT `groups_2101` on list page) with `status`, `fulfillmentType`,
`deliveredDate`, and `items[]: { id, uniqueId, offerId, quantity, imageInfo.thumbnailUrl, name,
isUnavailable, statusCode, addOns }` — item names/thumbnails/qty but **no per-item prices**.
Plus `pageInfo.nextPageCursor` and `filterGroups` (date / returned status / status / order type).

**Implication:** a summary export (date, totals, item names, status) needs ZERO detail-page visits.

---

## 3. Owner decisions (verbatim intent)

- ✅ Ship 6.3 merge FIRST, before all features. (DONE — `20f2610`)
- ✅ P0.1 store replies + P0.3 tripwire: agreed. (Tripwire DONE — `94369fb`)
- ✅ P1.4 Quick Export from list payload: agreed. (IN PROGRESS — see §5)
- ❌ **NO `fetch()`/XHR to walmart.com** — owner explicitly rejected due to bot-detection risk
  (PerimeterX). Data comes only from pages the user actually visits.
- ✅ P1.6 date/filter: owner already relies on Walmart's own filter params (collection paginates
  whatever filtered view the user set). Decision: implement only as *filter awareness* (display
  detected active filters in the panel); do NOT construct filter URLs ourselves (fragile).
- ✅ P2.7 new columns: agreed.
- ✅ P2.8 CSV/JSON formats: agreed.
- ⚠️ P2.9 thumbnails in Excel: owner unsure of demand → implement as opt-in toggle, DEFAULT OFF.
- ✅ P2.10 barcode + receipt: agreed (printable HTML receipt; true PDF deferred to roadmap).
- ✅ P3+ features (IndexedDB sync, dashboard, price history, auto-export, Pro tier, ports,
  in-store, CI fixtures): deferred — recorded in `docs/ROADMAP.md`.
- ✅ **Process: one feature = one commit.** Parallel worktree agents where files don't overlap;
  sequential where they do (most features touch `sidepanel.download.js` / `content.js`).
- ✅ Resilience is paramount: Walmart's UI **and** server payloads may change. Keep BOTH data
  paths (payload + DOM fallback) alive in every feature; never let one break the other.

---

## 4. Hard engineering constraints (apply to every change)

1. Extraction order: `__NEXT_DATA__` payload → network snapshots → DOM. Never remove a fallback.
2. No `fetch()`/XHR to walmart.com endpoints. No new tabs beyond the existing download-tab flow.
3. No new manifest permissions without owner sign-off (store re-review + user-visible warning).
4. Blank/garbage extraction must trip the warning banner (see `computeExtractionWarnings` in
   content.js), never silently export.
5. Everything on-device; no telemetry, no servers.
6. Style: vanilla JS, JSDoc, constants in `utils.js` `CONSTANTS`, match existing banner/UI
   patterns in `sidepanel.view.js`/`sidepanel.css`.
7. `node --check` every modified JS file before committing.
8. Don't touch `manifest.json` version / `CHANGELOG.md` / `README.md` in feature commits —
   the final release commit does version 6.4 + changelog.
9. Commits end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. No pushes.

---

## 5. Commit plan & status

| # | Commit | Status |
|---|---|---|
| 1 | `0f171a5` chore: gitignore playwright artifacts | ✅ on main |
| 2 | `20f2610` merge v6.3 (supersedes 6.2 revert) | ✅ on main |
| 3 | `94369fb` tripwire: blank-data detection + warning banner | ✅ on main |
| 4 | `c22ca87`/`fb9568a` docs: ROADMAP.md | ✅ on main |
| 5 | **Quick Export** | ✅ DONE — data layer (`60bffdb`, merged) + UI: Quick Export button, `quickExportSummaries()` in sidepanel.download.js, graceful degradation (orders without summaries export # + title only; none at all → prompt re-collect). |
| 6 | Filter awareness | ✅ DONE — `describeActiveFilters()` (utils.js) + `updateFilterNotice()` (view.js); display-only, no owner-constructed filter URLs. |
| 7 | New export columns | ✅ DONE — sellers, fulfillmentTypes, deliveredDate, trackingNumbers, refund, donations, paymentSplit (all `displayValues`, not just `[0]`). Appended at the end of the multi-order sheet; schemaVersion 1→2 so 6.3 caches re-fetch. (taxTotal was already exported as 'Tax'.) |
| 8 | CSV + JSON formats | ✅ DONE — 'Export format' selector (XLSX/CSV/JSON/receipt); RFC-4180 CSV as orders file (row per order) + items file (row per item) with numeric money fields; JSON = full structured objects. All export paths incl. Quick Export honor the format. |
| 9 | Thumbnails (opt-in, default OFF) | ✅ DONE — toggle default OFF; `embedItemThumbnails()` fetches at export time and falls back to a hyperlink cell per image on failure (no host permission exists for i5.walmartimages.com; none added). Payload thumbnailUrl is backfilled into DOM-merged items. |
| 10 | Barcode + printable receipt | ✅ DONE — `barcodeImageUrl` from `idBarcodeImageUrl` → 'Receipt Barcode' hyperlink column (Excel), URL column (CSV), field (JSON). 'Printable receipt (.html)' format renders per-order receipts with page breaks; user prints to PDF. |
| 11 | Release commit | ✅ DONE — CHANGELOG 6.4, manifest 6.4, README, this table. |

All v6.4 work shipped one feature per commit and passed a multi-agent code review.
Remaining store action items from §1 (publish 6.4, reply to "repeated entry" reviews) are the owner's.

---

## 6. Architecture cheat-sheet (post-6.3)

- `content.js` (~1780 lines) — all walmart.com extraction. Key pieces:
  `PurchaseHistoryDataSource` (list page: payload/network/DOM snapshots, `buildSnapshot()`),
  `extractOrderDataFromNextData()` + DOM scraper + `mergeOrderItems()` (detail page),
  `computeExtractionWarnings()` (tripwire), `getOrderListSignature()` /
  `waitForOrdersListTransition()` (pagination safety), message handlers at bottom.
- `background.js` — service worker; `CollectionState` (Set of order numbers, additionalFields,
  pagesCached, persisted to `chrome.storage.local`); pagination orchestration.
- `sidepanel.js` + `sidepanel.state.js` / `view.js` / `actions.js` / `download.js` —
  panel UI; `download.js` owns the per-order tab-fetch flow (`OrderDataFetcher`) and ExcelJS
  workbook generation; `view.js` owns banners (see `showExtractionWarning`).
- `utils.js` — `CONSTANTS` (SELECTORS / MESSAGES / STORAGE_KEYS / URLS), `ChromeApi` wrappers.
- Release packaging: `.github/workflows/release.yml` (remember it copies each sidepanel module).

## 7. How to test against the real site

Chrome must be driven via the Playwright extension bridge (CDP port is blocked on default
profiles in modern Chrome; profile-copying was ruled out):
1. User installs "Playwright Extension" from the Chrome Web Store and provides the
   `PLAYWRIGHT_MCP_EXTENSION_TOKEN`.
2. `export PLAYWRIGHT_MCP_EXTENSION_TOKEN=…; playwright-cli attach --extension=chrome`
3. Drive with `playwright-cli --s=chrome goto/eval/…`. Load the unpacked extension build via
   `git archive <ref> | tar -x -C <dir>` + relaunch Chrome with `--load-extension=<dir>`.
4. Good live fixtures: multi-shipment order `200010000000042` (duplicate detail buttons,
   canceled items); list page has orders with 2-3 duplicate buttons.
5. There is NO automated test suite yet (roadmap item: fixture-based CI). Minimum bar:
   `node --check` all files + live smoke of collect → quick export → deep export.
