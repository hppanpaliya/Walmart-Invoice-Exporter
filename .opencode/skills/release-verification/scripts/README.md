# Verification scripts

Helpers for the release-verification procedure. They drive a built, unpacked
extension in headless Chromium with seeded data and the mock Walmart from
`tests/e2e/helpers/`. None of them touches walmart.com or needs an account.

Build first (`node_modules/.bin/wxt build`), or set `WIE_EXT` to an unpacked
build. Each script prints a JSON report; `WIE_OUT` and `WIE_SHOTS` choose
where results and screenshots go (default: the system temp directory).

| Script | What it checks |
|---|---|
| `launcher.cjs` | Shared launcher (never builds), storage and IndexedDB dump helpers. |
| `settings-sweep.cjs` | Every Settings control: what it stores, persistence, sync to the main view, limits, reset, delete-all. |
| `mcp-sweep.cjs` | The local AI bridge against the published relay. Needs `WIE_RELAY` (path to the installed relay's bin script). |
| `dashboard-views.cjs` | The Categories and Missed items views with seeded invoices, including hostile product names. |
| `dashboard-large-totals.cjs` | Headline figures with a five-digit total at 1024, 1280 and 1440 px. |

```sh
WIE_EXT=dist/chrome-mv3 node .opencode/skills/release-verification/scripts/settings-sweep.cjs
```

These were written during the 8.8 verification on 2026-11-14 and moved here
afterwards. They follow element ids and labels of that build; when the UI
changes, expect to update selectors. Real-order replays are not kept as
scripts because they read captured pages; the procedure is in `../SKILL.md`.
