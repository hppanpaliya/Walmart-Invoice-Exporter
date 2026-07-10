# Roadmap

This document records the future plans for the Walmart Invoice Exporter and the status of each. Most of the original list shipped in the 6.5–6.12 release train (one roadmap item per point release). It also records the engineering principles every future change must respect.

Last updated: 2026-07-10

## Features & Status

1. ✅ SHIPPED 6.6 — **Local order database (IndexedDB) + incremental sync** — A durable local store so orders survive across sessions, enabling "sync new orders only" instead of a full re-collect every time. Rationale: re-collecting the entire history is slow and fragile; incremental sync makes everything else on this list cheaper.

2. ✅ SHIPPED 6.7 — **Spend analytics dashboard (side panel)** — Monthly spend, tips paid, fees paid, total savings, most-repurchased items, substitution rate. All computed locally, no servers — privacy-first is a headline feature, not a constraint.

3. ✅ SHIPPED 6.8 — **Price history on repurchases** — Track the same `usItemId` purchased over time: "you paid $4.98, it was $3.98 in March". Rationale: high user value, and the data is already in the payload once a local database exists.

4. ❌ DECLINED by owner (2026-07-10; would require new alarms/downloads permissions) — **Scheduled auto-export** — Monthly Excel dropped into Downloads via `chrome.alarms`. Rationale: set-and-forget bookkeeping for regular users.

5. ⏳ OPEN (needs owner business decisions: pricing, payment provider account, store listing) — **Pro tier / monetization** — Free = quick export; Pro = deep export, dashboard, accounting formats, auto-sync. Likely via ExtensionPay or similar. Rationale: sustainable maintenance funding without ads or data collection.

6. ✅ SHIPPED 6.12 (Firefox untested live; store submissions pending) — **Edge Add-ons + Firefox ports** — Near-zero code change, free distribution channels. Rationale: cheap reach expansion.

7. ✅ SHIPPED 6.9 (Order Type column in every export) — **In-store purchases support** — The payload already exposes `isInStore` / GLASS types / `storePurchase=true` URLs. Goal: "export ALL Walmart spending incl. in-store". Rationale: completes the spending picture for many households.

8. ✅ SHIPPED 6.5 (tests/ + ci.yml, 57 tests) — **CI regression suite** — Sanitized `__NEXT_DATA__` fixture files + extractor unit tests running on every commit (GitHub Actions already exists: `release.yml`). Rationale: prevent the next silent-breakage incident like the one v6.3 fixed.

9. ✅ SHIPPED 6.11 (built-in dependency-free PDF writer) — **True PDF invoice generation per order** — Deferred from v6.4, which ships a printable HTML receipt instead. Rationale: PDF generation adds real complexity; the HTML receipt covers most needs today.

10. ✅ SHIPPED 6.10 — **QuickBooks/Xero-specific export presets** — v6.4 ships a generic accounting-friendly CSV first. Rationale: validate demand with the generic format before committing to per-tool presets.

## Engineering Principles

These apply to all current and future work:

- **Never trust DOM selectors alone.** Extraction order is payload (`__NEXT_DATA__`) → network snapshots → DOM, in that order. Every extraction change must keep all fallback paths working.
- **No `fetch()`/XHR to walmart.com endpoints** (PerimeterX bot detection risk). Data comes only from pages the user actually visits.
- **Everything stays on-device.** No telemetry, no servers.
- **Blank data is a bug, never silence.** Any extraction returning blank critical fields must surface a user-visible warning (tripwire) — never silent garbage.
