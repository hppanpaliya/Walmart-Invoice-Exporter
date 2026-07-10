# Roadmap

This document records **deferred and future plans** for the Walmart Invoice Exporter — features that are explicitly *not yet implemented*. Current work (v6.3 payload-based extraction; v6.4 tripwire, Quick Export, filter awareness, richer columns, CSV/JSON, thumbnails, barcode + printable receipt) is tracked elsewhere. It also records the engineering principles every future change must respect.

Last updated: 2026-07-09

## Deferred / Future Features

1. **Local order database (IndexedDB) + incremental sync** — A durable local store so orders survive across sessions, enabling "sync new orders only" instead of a full re-collect every time. Rationale: re-collecting the entire history is slow and fragile; incremental sync makes everything else on this list cheaper.

2. **Spend analytics dashboard (side panel)** — Monthly spend, tips paid, fees paid, total savings, most-repurchased items, substitution rate. All computed locally, no servers — privacy-first is a headline feature, not a constraint.

3. **Price history on repurchases** — Track the same `usItemId` purchased over time: "you paid $4.98, it was $3.98 in March". Rationale: high user value, and the data is already in the payload once a local database exists.

4. **Scheduled auto-export** — Monthly Excel dropped into Downloads via `chrome.alarms`. Rationale: set-and-forget bookkeeping for regular users.

5. **Pro tier / monetization** — Free = quick export; Pro = deep export, dashboard, accounting formats, auto-sync. Likely via ExtensionPay or similar. Rationale: sustainable maintenance funding without ads or data collection.

6. **Edge Add-ons + Firefox ports** — Near-zero code change, free distribution channels. Rationale: cheap reach expansion.

7. **In-store purchases support** — The payload already exposes `isInStore` / GLASS types / `storePurchase=true` URLs. Goal: "export ALL Walmart spending incl. in-store". Rationale: completes the spending picture for many households.

8. **CI regression suite** — Sanitized `__NEXT_DATA__` fixture files + extractor unit tests running on every commit (GitHub Actions already exists: `release.yml`). Rationale: prevent the next silent-breakage incident like the one v6.3 fixed.

9. **True PDF invoice generation per order** — Deferred from v6.4, which ships a printable HTML receipt instead. Rationale: PDF generation adds real complexity; the HTML receipt covers most needs today.

10. **QuickBooks/Xero-specific export presets** — v6.4 ships a generic accounting-friendly CSV first. Rationale: validate demand with the generic format before committing to per-tool presets.

## Engineering Principles

These apply to all current and future work:

- **Never trust DOM selectors alone.** Extraction order is payload (`__NEXT_DATA__`) → network snapshots → DOM, in that order. Every extraction change must keep all fallback paths working.
- **No `fetch()`/XHR to walmart.com endpoints** (PerimeterX bot detection risk). Data comes only from pages the user actually visits.
- **Everything stays on-device.** No telemetry, no servers.
- **Blank data is a bug, never silence.** Any extraction returning blank critical fields must surface a user-visible warning (tripwire) — never silent garbage.
