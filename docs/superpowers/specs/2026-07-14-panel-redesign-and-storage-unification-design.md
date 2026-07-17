# Side Panel Redesign & Storage Unification — Design Spec

- **Date:** 2026-07-14
- **Status:** Draft for owner review
- **Baseline:** v6.25 (73/73 unit tests green on `main`)
- **Branch:** `redesign/panel-and-storage`
- **Author:** synthesized from two independent design reviews (systems-led + UX-led), both of which independently converged on the major decisions below.

---

## 1. Goal

The side panel works but is *modeless*: two export axes tangled into a hidden 2×2, a redundant "Quick Export" button, and three "clear" controls over two storage layers where the loudest one silently fails to clear the durable database. This initiative makes the panel legible and the data model honest, without touching the proven export engine or Walmart extraction.

### In scope
- **UI/IA redesign** of the side panel around a `collect → select → download` spine.
- **Two explicit download buttons** ("Single file" / "Multiple files"), format controls beneath them, Quick Export removed.
- **Legacy Excel layout** as an opt-in that restores the pre-6.18 single-sheet workbook.
- **Storage unification:** IndexedDB becomes the single source of truth; the redundant `chrome.storage` invoice cache is retired; live-collection progress moves to `chrome.storage.session`.
- **One honest "delete all saved data"** control replacing the three scattered ones.
- **A dedicated Settings view** consolidating defaults + data management.
- **Design system + accessibility:** tokens, dark mode, focus states, reduced-motion, ARIA, in-panel dialogs replacing `alert()`/`confirm()`.
- **Dead-weight removal:** stop injecting the 884 KB ExcelJS library into every Walmart page.

### Out of scope (do not touch — "currently it is working")
- The export converters in `utils.js` (`convertToXlsx`, `convertMultipleOrdersToXlsx`, CSV/JSON/receipt/PDF) — *only additive changes* (legacy writer) are allowed.
- The Walmart data-extraction logic in `content.js` (dual `__NEXT_DATA__` + DOM path).
- The exported file *contents/columns* of the current default formats (must stay byte-stable — golden-tested).
- The collection state machine's core pagination logic in `background.js` (its storage backing changes; its crawl logic does not).

### Non-goals
- No JS framework, no bundler, no build step (decision locked: stay vanilla + design system).
- No servers, telemetry, or any network call to walmart.com beyond the existing content-script extraction.

---

## 2. Constraints (non-negotiable)

1. **MV3**, strict CSP, everything bundled locally (no CDN/remote code/fonts).
2. Must keep working on **Chrome (side panel)** and **Edge/Firefox (sidebar shim)**. Any new file must be added to the release file list (`scripts/release-files.lib.sh` / `.github/workflows/release.yml`) and, if loaded by the worker, to `background.js`'s `importScripts(...)` (the Firefox build derives from it).
3. **Never `fetch()` walmart.com.** Data comes only from the content script reading the page payload + DOM.
4. **All data on-device.** No telemetry.
5. **One commit per feature**, each independently live-tested (Playwright extension harness), lowest-risk first.
6. **Owner owns push/publish** and version numbers. This work lands on a branch; the owner merges/releases.
7. Preserve users' existing stored data and persisted preferences across the upgrade (additive, idempotent migrations only).

---

## 3. Current state (evidence-backed problem summary)

| ID | Problem | Evidence |
|----|---------|----------|
| C1 | Invoices stored in **two** layers; the `chrome.storage` copy is redundant and its quota-recovery path replaces the whole invoice cache with a single order (silent data loss). | `sidepanel.download.js:158` + `:161`; `utils.js` `cacheInvoice` quota branch (~`:2222`). |
| C2 | **"Clear Cache" never clears IndexedDB.** After clicking it, `displayOrdersFromDb()` re-populates from IndexedDB, incremental still "knows" every order, dashboard still full → users report "won't clear." | `sidepanel.js:208-228` → `clearAllInvoiceCache` + `CLEAR_CACHE`→`background.js:219`; `sidepanel.actions.js` DB fallback. |
| C3 | **Conflated 2×2 action model:** `exportMode` `<select>` hidden in collapsed `<details>`; Download label mutates from it; Quick Export beside it. | `sidepanel.html:65-73`; `sidepanel.view.js:298-308`, `:390-399`. |
| C4 | **Quick Export's only real delta** over Download is instant tab-free re-export after the 24h window (Download's fast path reads the 24h `chrome.storage` cache, not IndexedDB). | `sidepanel.download.js:168-173` vs `:460`. |
| C5 | **Three reset controls, two layers, none complete.** | `sidepanel.js:192`, `sidepanel.view.js:232`, `sidepanel.dashboard.js` reset. |
| C6 | **884 KB ExcelJS injected into every `walmart.com/orders*` page** for a dead in-page path (`DOWNLOAD_XLSX` has no live sender). | `manifest.json:27`; `content.js:601`; grep confirms no sender. |
| C7 | Settings scattered; `alert()`/`confirm()` used for flow/destructive actions; no dark mode; a11y gaps (focus-visible, reduced-motion, ARIA, hover-only order meta, sub-24px targets, ~1.8:1 green Download button). | `sidepanel.css` (no `prefers-color-scheme`), `sidepanel.download.js:533,539`, `sidepanel.view.js:235`. |
| C8 | Live collection state in service-worker globals that Chrome can evict (~30s idle). | `background.js:10-41`. |

---

## 4. Target architecture

### 4.1 Storage model — three stores, three jobs, no overlap

| Store | Owns | Notes |
|-------|------|-------|
| **IndexedDB (`OrderDb`)** | **Single source of truth** for orders + invoices. Order list, exports, dashboard, incremental "known set" all read here. | Already durable and well-built (`orderdb.js`). Correct home for invoice blobs. |
| **`chrome.storage.local`** | **Settings/prefs only**, one namespaced `settings` object + rating counters. | Tiny; shared across contexts; survives restart. |
| **`chrome.storage.session`** | **Ephemeral live-collection progress** (order numbers found this run, `isCollecting`, `currentPage`, titles). Cleared on browser close. | In-memory, 10 MB (Chrome ≥112). Replaces the 24h collection cache. |

**Retire the 24h `walmart_order_cache`.** Its two real jobs split cleanly: "survive a mid-collection panel close" → `session`; "show my orders without re-collecting" → IndexedDB. This removes the "always refresh page 1", "cache lacks summaries → re-collect from scratch", and stale-then-refetch hacks (`background.js:73,130-133,140`).

**Retire the `walmart_invoice_cache` entirely.** Delete `getCachedInvoice` / `cacheInvoice` / `clearOldCacheEntries` / `deleteInvoiceCache` / `clearAllInvoiceCache` (`utils.js:~2160-2329`). Invoices live in IndexedDB only. This removes C1 including the quota footgun.

### 4.2 Download fetch path (makes killing Quick Export lossless)

`OrderDataFetcher.fetchOrderData(orderNumber)`:
1. `OrderDb.getOrder(n)` → if `invoice` present and `schemaVersion >= ORDER_SCHEMA_VERSION (3)`, **return it, open no tab.**
2. Else open a background tab, run the **unchanged** dual-extraction path, `OrderDb.putInvoice`, return.

Result: already-downloaded selected orders export instantly (even after 24h); not-yet-downloaded ones fetch. The two buttons strictly dominate today's Download + Quick Export. Preserve the *never-fabricate* contract: an order that can't be fetched is reported as failed, never synthesized.

### 4.3 Order list derivation

The panel's order list is derived: `OrderDb.getAllOrders()` sorted by date, with an in-progress collection overlaying newly-found numbers from `session`. One read path replaces the current cache-snapshot-with-DB-fallback fork.

### 4.4 Clearing model (resolved: single destructive control)

**Decision:** the clear-data area has **one** control: **"Delete all saved data"** (destructive). Freshness ("re-scan for new orders") is served by the main **Collect orders** button, so the soft "Refresh" option shown in the mockup is dropped as redundant — one honest destructive control is the cleaner mental model. "Delete all saved data" wipes IndexedDB (`OrderDb.clearAll`) **and** the `session` collection state, then refreshes the panel to a true empty state. Confirmed via an in-panel `Dialog` whose confirm button echoes the count ("Delete 142 orders") and uses the danger role. A separate non-destructive **"Reset settings to defaults"** lives in Settings (resets the `settings` object only; never touches data).

Removed: the injected "Clear Cache" button, the db-stats "clear" link, the dashboard "Reset dashboard data" button. The per-order badge becomes an **informational "✓ saved" chip** (no longer a delete control).

> Edge case (noted, low priority): forcing a *re-download* of an already-saved invoice. Past invoices effectively never change, so the escape hatch is "Delete all saved data" + re-download. A per-order "re-download" affordance is deferred unless demand appears.

### 4.5 Settings persistence + migration

- Consolidate the six scattered `chrome.storage.local.get` reads (`sidepanel.js:18,43,57,70,83` + pageLimit) into one `settings` object loaded once into state, written debounced on change.
- **Migration (one-time, on init, idempotent):**
  1. If legacy top-level setting keys exist, fold into `settings`, delete originals.
  2. If `walmart_invoice_cache` survives, `OrderDb.putInvoice` each entry (usually already present), then remove the key.
  3. Remove `walmart_order_cache`.
- **IndexedDB:** keep `DB_VERSION=1` unless adding an index (e.g. a `hasInvoice` boolean for fast dashboard coverage). If added, bump to 2 with an additive `onupgradeneeded` — never destructive.

---

## 5. UI / information architecture

### 5.1 Main view: `collect → select → download`

- **Header:** cart icon + title + version pill; right-aligned icon buttons **Dashboard · Help · Settings (gear)** (all `aria-label`led; fixes today's header crowding). Settings is a new sibling view via the existing `switchView`.
- **Status strip:** off-tab / filter / extraction warnings consolidate into one `Banner` region (`role="status" aria-live="polite"`), replacing the five ad-hoc notice styles + `insertBefore(body.firstChild)` insertions.
- **① Collect:** primary **[Collect orders]** button; page-limit + "only new" behind a small **Options** disclosure (defaults live in Settings; "only new orders" is the default). Inline progress.
- **② Select:** "N orders · M selected", Select-all, scrollable order list. Each row: checkbox + order # + **always-visible meta** (date · status; no more hover-only tooltip) + **"✓ saved"** chip when a full invoice is stored.
- **③ Download:** the two buttons, then format controls **below**.

### 5.2 The two-button model (precise behavior)

- **[Single file]** → all SELECTED orders into one workbook/file (current default layout, or legacy single-sheet if toggled). Replaces `exportMode==='single'`.
- **[Multiple files]** → one file per SELECTED order. Replaces `exportMode==='multiple'`.
- **Labels echo the current format:** "Single file (.xlsx)" / "Multiple files (.csv)" — the format is never hidden. A shared caption carries the model: *"Single = one file with every order. Multiple = one file per order."*
- Both buttons are an **equal, matched pair** (not two loud solid fills; accent-tinted). No mutating single button, no Quick Export.
- **Per selected order:** IndexedDB invoice → else fetch (dual-extraction) → persist → export. (§4.2)
- **States:**
  - 0 selected → both disabled with one inline reason "Select at least one order."
  - Running → pressed button shows a **determinate** "Preparing… 3 / 12"; other disabled; a **Cancel** appears (wired to the existing `downloadInProgress` check in `runDownloadQueue`). Progress via a persistent `ProgressBar` + `StatusLine` (`aria-live`), not injected timed divs.
  - Success → `Banner/success` "Exported 12 orders (Excel)", auto-dismiss.
  - Partial → `Banner/danger` "10 of 12 exported · 2 failed (#…, #…) — Retry failed" with a retry of just those.
- On click, persist the last choice (keep the `exportMode` storage key for upgrade continuity), but always show both buttons.
- **Delete:** `exportMode` `<select>` (`sidepanel.html:67-73`), `updateDownloadButtonLabel`, `quickExportSummaries`, the Quick Export button, and the `QUICK_EXPORT*` text constants.

### 5.3 Legacy Excel toggle

- **Placement:** in the format controls under the buttons, visible only when Format = Excel; rendered minor/secondary (muted). A matching default lives in Settings.
- **Label:** "Use legacy Excel layout"; help: "Single-sheet workbook like older versions (before the Orders/Items split)." Default **OFF**, persisted as `settings.legacyExcel`.
- **Wiring (additive only):** recover the deleted single-sheet writers and their column-config helpers from `f6a282d^:utils.js` (the pre-6.18 `convertMultipleOrdersToXlsx` / `convertSingleOrderToXlsx` bodies + `configureMultipleOrdersColumns` and the single-order analog — recover exact names from git) as new `convert*Legacy` functions. Gate in `exportCombinedOrders`/`exportOneOrder` on `settings.legacyExcel`. The current Orders+Items writer stays the untouched default.

### 5.4 Settings view (dedicated)

Reached via the header gear; same pattern as FAQ/Dashboard. Contains: **Appearance** (theme System/Light/Dark segmented control, persisted, stamps `data-theme`), **Collection** (default pages, default "only new"), **Export defaults** (default format, thumbnails, legacy layout), **Data on this device** (count line + "Delete all saved data" + "Reset settings to defaults"), **About** (version, on-device/no-telemetry note, "Rate this extension" — moved here from the footer nag; delete the `Math.random()` rating injection near actions). Per-export choices (format, preset, thumbnails, the two buttons) stay on the main screen — they're task state, not configuration.

### 5.5 Design system (vanilla, self-contained, CSP-safe)

- **Tokens** (CSS custom properties): space (4px base), radius, type scale (≥11px), semantic color roles. Light values + `@media (prefers-color-scheme: dark)` defaults + `:root[data-theme=...]` manual override. System font stack (no remote fonts).
- **Dark mode** = system by default with a persisted 3-way override.
- **A11y:** `:focus-visible` ring (≥3:1, ≥3px), `prefers-reduced-motion` disables the spinner animation, `aria-label`s on icon buttons, `aria-live` status region, focus-trapped `Dialog` (Esc + `aria-modal`) replacing `window.confirm`/`alert`, ≥24px targets, keyboard-reachable order meta (it's now always-visible text). Move Download off the failing green to the accent color.
- **Components** (~12 small vanilla factory/template helpers, no framework): `AppHeader`, `IconButton`, `Section`/`Card`, `Button` (`primary|neutral|danger|ghost|accent-pair`), `SegmentedControl`, `Field` (+`Number`/`Select`/`Toggle`), `OrderList`/`OrderRow`, `Banner` (`info|warning|danger|success` — replaces all five notice styles), `StatusLine`+`ProgressBar`, `Dialog`, `Toast`, `Disclosure`. Dashboard keeps its `StatTile`/`BarRow`.

### 5.6 Dead-weight removal

Remove `exceljs.bare.min.js` from `content_scripts` in `manifest.json`; delete the dead `DOWNLOAD_XLSX` handler in `content.js` and the constant. ExcelJS remains loaded by the side panel (`sidepanel.html`) where exports actually run. Update the release file lists / Firefox `importScripts` accordingly.

---

## 6. Testing strategy

- **Golden-output safety net (Phase 0, gates everything):** pin the current byte-level/serialized output of all five formats (xlsx via a stable serialization of cells, csv/json/html/pdf text) into `tests/` so any accidental change to default output fails loudly. Extend `tests/utils.export.test.js`.
- **Unit (`npm test`, `node --test`):** add tests for the storage-model selection (IndexedDB-first fetch), the migration (legacy keys folded + removed; invoice-cache entries preserved into DB), the clear model (delete-all empties DB + session; reset-settings leaves data), and the legacy Excel writer (asserts a single `Walmart Orders` sheet with the 29 legacy headers).
- **E2E (`npm run test:e2e`, Playwright + packed extension):** update the harness (it currently clicks `#quickExportButton`/`#downloadButton` and sets `app.exportMode` directly — `tests/e2e/extension.e2e.js`). New ids `#singleFileDownload`/`#multiFileDownload`; mode implied by the button. Add assertions: re-exporting an already-saved order **opens no tab** (proves the IndexedDB fast path); format parity for both buttons; collection survives a panel reopen (session state); delete-all yields a true empty state.
- **Manual live test** each phase: load unpacked at 375px in light + dark, keyboard-only pass, drive collect→select→download.
- `npm install` is required before e2e (Playwright not yet installed).

---

## 7. Phased implementation plan (one commit per feature, lowest-risk first)

Each phase is independently shippable, keeps exports working, and is verified by `npm test` + `npm run test:e2e` + a manual live pass. Phases are an **ordered chain**; only the bracketed slices are safe to parallelize (disjoint files, isolated worktrees).

- **P0 — Golden-output safety net.** No behavior change. *Verify:* Jest green, goldens captured. **[parallelizable]**
- **P0b — Remove dead ExcelJS injection** + `DOWNLOAD_XLSX` handler; update release/Firefox file lists. *Verify:* extension loads; orders page no longer injects ExcelJS; e2e green. **[parallelizable]**
- **P0c — Restore legacy Excel writer** (additive `convert*Legacy` + its golden/unit test), not yet wired to UI. *Verify:* new test asserts 29-col single sheet; default output unchanged. **[parallelizable]**
- **P1 — Data fast-path + invoice-cache retirement.** `fetchOrderData` reads IndexedDB first; stop writing invoices to `chrome.storage`; migrate + delete `walmart_invoice_cache`. Invisible to UI. *Verify:* e2e "re-export opens no tab"; goldens unchanged. *(Now Quick Export is provably redundant.)*
- **P2 — Session-state collection.** Replace `walmart_order_cache` with `chrome.storage.session`; list derives from IndexedDB; remove TTL hacks. *Verify:* e2e collection + panel-reopen keeps orders.
- **P3 — Design tokens + dark mode + a11y foundation** (CSS + `Banner`/`StatusLine`/`Dialog` components; unify the five notices; fix contrast/focus/reduced-motion). No flow change. *Verify:* visual + keyboard pass both themes; e2e green.
- **P4 — Header IA + Settings view shell** (three icon buttons + gear → empty Settings view + nav). *Verify:* no header wrap @375; navigation works.
- **P5 — Two-button model + kill Quick Export.** New buttons, format controls below, format-echoed labels, inline disabled reasons, in-panel progress/errors, legacy toggle wired. Update e2e/unit **in the same commit**. *Verify:* updated format-parity specs for both buttons.
- **P6 — Collect-step demotion** (primary "Collect orders" + Options disclosure; defaults sourced from Settings). *Verify:* limit + incremental still honored.
- **P7 — Unified clear model.** Settings "Data on this device" + "Delete all saved data" `Dialog` (DB + session) + "Reset settings"; remove the three old controls; badge → info-only; consolidate settings into one `settings` object + migration. *Verify:* migration unit test; delete-all live-verified to truly empty.
- **P8 — Settings polish + store assets.** Theme persistence, defaults, About/rate relocation; regenerate `screenshot.webp` + update `ChromeStore.MD`/FAQ "caching" copy to the new model. *Verify:* prefs persist across reload; listing matches UI.
- **P9 (optional) — Service-worker state hardening** if not fully covered by P2 (no live state in globals; `GET_PROGRESS` reads session).

Each phase maps to one release commit (6.26, 6.27, …); exact numbers are the owner's call.

---

## 8. Risks & guardrails

| Risk | Guardrail |
|------|-----------|
| Breaking export parity (the crown jewels) | P0 golden net first; never edit converter internals, only add the legacy writer + route to it; full Jest+Playwright before/after every phase. |
| Firefox/Edge packaging drift | Every new/removed file updated in `release-files.lib.sh` / `release.yml`; worker deps mirrored in `importScripts`; staying bundler-free keeps this intact. |
| Existing users' data/prefs | Migrations additive + idempotent; fold caches into IndexedDB before removing keys; keep reading legacy pref keys. |
| Tests hardcode old UI | Update e2e/unit **in the same commit** as the UI change (P5). |
| Half-built modal less accessible than native `confirm` | `Dialog` focus-trap + Esc + `aria-modal` are acceptance criteria for P3, not polish. |
| Muscle-memory loss (Quick Export gone) | One-time dismissible tip where the button was: "Quick Export is now built into Download — saved orders re-export instantly." (Requires P1 to be true first.) |
| Receipt/PDF documents inherit panel dark mode | Verify the receipt/PDF templates keep their own light styling (they're separate documents). |

---

## 9. Open decisions for owner review

1. **Soft "Refresh" option dropped** (§4.4) — one destructive "Delete all saved data" only. Flip if you want the two-option dialog back.
2. **Version numbering** — phases as sequential releases 6.26+, or a single larger bump. Owner's call.
3. **Optional per-order "re-download"** affordance — deferred by default (§4.4).
4. **`hasInvoice` IndexedDB index** (DB v2) — add now for dashboard speed, or defer.

---

## 10. 2026-07-17 addendum: list & flow redesign (v7.1)

Approved follow-on to §5.1/§5.2 above, implemented on `redesign/panel-and-storage` after v7.0 shipped. Tightens the main view around a single explicit macro state and a denser, receipt-style order list, without touching the storage model (§4), the export engine, or the two-button download pipeline's contract.

### A. State-driven top card

The panel has exactly two macro states, driven by `hasOrders` = (`OrderDb` has ≥1 order) OR a collection is in progress/has results this session:

- **First-run** (`hasOrders` false — the safe default baked into `sidepanel.html` before any JS runs, via `body.first-run`): the collect card becomes a hero — centered icon, "Export your Walmart orders" heading, a one-line subtext, and a full-width primary button labeled **"Load my orders"**. The Options disclosure stays visible. The entire list section and download section (buttons, caption, format panel) are hidden outright (`display:none`), not just visually collapsed — their DOM/ids don't exist until real orders render.
- **Returning** (`hasOrders` true): the hero disappears, the collect button returns to its normal inline size with the label **"Check for new orders"**, and the list + download sections render normally.

`view.updateMacroState(hasOrders)` toggles `body.first-run` and stamps `state.app.hasOrders`, which `setCollectionButtonsState` (utils.js) reads for its default start-button label. Called from `sidepanel.actions.js`: optimistically at collection start, after every DB/list render (`renderOrderList`), and forced `true` for the single-Walmart-order-page view (always something to act on, even for a brand-new user).

Loading state text: `"Loading page {N}… · {count} orders found"`, `count` = the live `orderNumbers.length` from `GET_PROGRESS`.

### B. Receipt-style order list

`displayOrderNumbers(orderNumbers, additionalFields)` keeps its exact signature (the e2e harness and every caller are unchanged) but now, internally: reads `OrderDb.getAllOrders()`, builds one row model per order number via `buildOrderRowModel` (utils.js — date/status/item-count/total with documented fallbacks, sorted newest-first with undated rows last), and renders them grouped under uppercase month labels ("JULY 2026"; undated rows under "NO DATE", shown only in the All-time filter).

Row layout: checkbox · primary line ("Jul 9 · Delivered") + fine print ("12 items · #…0042") · right-aligned monospace total + a "✓ saved" chip when a current-schema invoice is stored · chevron. A row with neither summary nor invoice data renders a dimmed fallback ("#…last4" / "Details arrive on next sync") and is not expandable. Per-row checkbox `id`/`value` stay exactly `orderNumber`, unchanged from pre-redesign — selection, `getSelectedOrderNumbers`, and the e2e checkbox selectors all keep working.

The heading row above the list is two pieces of live text, both driven by `updateCheckboxCount` (utils.js, the one source of truth): "Select all N shown" (left) and "Orders (T) · M selected" / "M selected · of T total" when a filter is hiding rows (right).

### C. Tap-to-expand rows

Clicking anywhere on a row except the checkbox or a button/link toggles its accordion detail (chevron rotates via CSS, honors `prefers-reduced-motion`); only one row is open at a time. Keyboard: `role="button"`, `tabindex="0"`, `aria-expanded`, Enter/Space toggle.

Expanded detail:
- **Has invoice:** first 3 invoice items ("Name ×qty" + mono price) + "+N more"; a mini-ledger from `invoice.orderSubtotal` / `invoice.tax` / `invoice.tip` / `invoice.orderTotal` — **only rows whose value exists**, never a fabricated "$0.00"; the full order number (mono) + Copy (clipboard + Toast); **Re-export** / **View on Walmart**.
- **Summary-only:** item names ×qty (no prices) from `summary.items`; ledger from `summary.subTotal` / `summary.driverTip` / `summary.orderTotal`; an amber hint ("Download this order to get per-item prices, tax, and the full receipt."); order number + Copy; **Download this order** / **View on Walmart**.

Both "Re-export" and "Download this order" call `Sidepanel.download.downloadSelectedOrders(null, [orderNumber])` — a `null` mode keeps the user's current persisted `exportMode` rather than changing it. "View on Walmart" duplicates `OrderDataFetcher.buildOrderUrls`' primary-URL logic as a small `buildOrderViewUrl` helper in `sidepanel.view.js` (documented as an intentional duplicate rather than a cross-module export for one URL string).

### D. Date "Showing" filter

A `<select id="listRangeFilter">` above the list — All time / Last 3 months / Last 6 months / This year / Last year / Custom range… — each option's label includes its live count (e.g. "Last year (37)"). Custom range reveals two `<input type="date">`s. The filter is in-memory view state only (`sidepanel.view.js`'s `listState`, not persisted; defaults to All time on every panel open). Changing it re-renders from the already-built row array (no re-read of `OrderDb`) via `renderFilteredList`, which also restores the checked set for rows that remain visible by reading it off the live DOM before the rebuild. Undated orders only ever show under All time; any bounded range hides them and reports the count ("N orders without a date are hidden").

Pure, unit-tested bucketing logic lives in utils.js: `getRangeBounds`, `isDateInRange`, `filterOrderRowsByRange`, `getRangeLabelSuffix`. The single-file download path (`sidepanel.download.js`) appends `view.getActiveRangeLabelSuffix()` to the `"Walmart_Orders"` base filename — empty string for All time, so the golden export tests (which never touch the filter) stay byte-identical.

### E. Footer + copy

The main view's footer collapsed to one small, muted line: a lock icon, "Stays on your device", "Rate" (existing Chrome Web Store review link), "by Harshal Panpaliya". The previous "Like the extension?" block was already living a second life in Settings' About section (§5.4) by this point, so nothing was lost. The in-panel FAQ's "How to Use" copy was updated for the new button labels ("Load my orders" first-run / "Check for new orders" returning).

### F. Responsive

At ≤340px the two download buttons stack vertically, full-width. The header never wraps — the icon-button group is `flex-shrink:0`; the title ellipsizes instead. All list/detail text that could overflow (fine print, item names, the full order number) truncates with `min-width:0` + `text-overflow:ellipsis` on its flex child rather than causing horizontal scroll, verified from 280px up.

### Deviations / judgment calls

- The pre-redesign `#collectionPlaceholder` (baked-in disabled `#singleFileDownload`/`#multiFileDownload` buttons) was simplified to just its "No orders collected yet" message — first-run now owns the true empty state, so the placeholder only ever needs to cover "a render pass found zero orders while otherwise returning" (e.g. a filtered Walmart page with no matches), where no buttons should render at all rather than disabled ones.
- `getCachedOrderNumbers` (utils.js) is no longer called from the list renderer — each row's `hasInvoice` now comes directly from the same `OrderDb` record already fetched for the row model, which is both simpler and one DB round-trip cheaper. The function itself was left in place (unused) rather than deleted, since it's a reasonable general-purpose helper and deleting it was out of scope for this pass.
