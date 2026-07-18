# Draft replies to store reviews

> Post these from the developer dashboard (Reviews → Reply). Verify the
> bracketed claims before posting — don't promise a fix that hasn't shipped.

## Billy Wayne — ★★★ (Jul 6, 2026) — duplicated line items + clear-cache

Thanks for the detailed report — this is exactly the kind of feedback that helps.
We're investigating the duplicated rows; it looks related to how order details
are extracted twice on some pages. [When fixed: "This is fixed in vX.Y — please
update the extension and re-download the affected orders."] On "clear cache":
the new version replaces the old cache with a single "Delete all saved data"
button in Settings that verifiably removes everything. Cached data lives only
on your device (browser local storage / IndexedDB) — nothing is stored online.
If the duplicates persist after updating, please open an issue on our GitHub
(github.com/hppanpaliya/Walmart-Invoice-Exporter) so we can trace your case.

## Barb Van — ★★★ (Jun 26, 2026) — Walmart+ / shipping / rush fees missing

Thanks — good catch. Exports include delivery charges, tax, and tip today, but
membership-related fees like under-minimum or rush charges aren't captured as
separate fields yet. We've added this to the roadmap. If you can share (via a
GitHub issue) what those lines look like on your order page — with personal
details removed — that would speed it up.

## tiffani mcmurdy — ★★ (Mar 30, 2026) — collection stops partway

Sorry about that — a Walmart page update in March broke collection midway, and
version 6.x shipped fixes for exactly this (plus a "check only new orders" mode
so a retry doesn't start over). Please update to the latest version and try
again; if it still stalls, the Help & FAQ in the panel has a troubleshooting
section, and we'd love a report on GitHub.

## Woody Baker ★★★★ / Jay Simon ★★★★ — order total repeated on every item row

Thanks! Each item row carries its own per-item price and quantity — the order
total column repeats by design so every row is self-contained when you sort or
filter. [If the new default layout changes this: mention it here.] The new
combined-workbook layout in v7 separates order-level and item-level data more
cleanly — give it a try after updating.

## Deep D v d — ★★★★★ — Sam's Club version request

Reply option: "Great idea — Sam's Club's order pages are indeed similar. No
promises on timing, but it's on our radar. Watch the GitHub repo for updates."
