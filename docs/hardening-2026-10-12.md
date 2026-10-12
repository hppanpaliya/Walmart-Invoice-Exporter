# Dashboard, export, and capture hardening — October 12, 2026

## Reproduced and fixed

- Explicit zero invoice amounts incorrectly fell back to older summary totals/tips/taxes/refunds. Zero-total orders were omitted from averages and monthly counts. The fallback now distinguishes missing values from zero, including numeric zero in summaries.
- Order tables preferred summary totals even when a full invoice had a newer total. The table now follows the measured invoice, matching dashboard totals and expanded details; zero totals appear in the details ledger.
- Existing-invoice changes could leave the dashboard stale because its change signature ignored record updates. The signature now includes the database's update timestamp. A packaged-extension test rewrites an existing invoice and verifies the refreshed headline, table, and details.
- Invalid ISO calendar dates passed through date normalization, and invalid preferred dates blocked valid fallback dates. Date resolution checks each candidate and rejects impossible ISO/title dates. Rolling ranges previously used overflowing month subtraction (May 31 minus three months became March 3); they now clamp to February 28 and keep comparison periods contiguous.
- A same-origin frame or standalone panel could impersonate dashboard commands. The embedded panel now accepts commands only from its actual parent, and the dashboard accepts refresh messages only from its embedded panel. Prototype keys are rejected for command option lookups. Real browser tests cover legitimate parent commands, standalone self-messages, and sibling-frame messages.
- CSV formula checks missed leading whitespace/control characters. Workbook writers accepted `javascript:`, `data:`, local file, and credential-bearing product links. All four workbook formats now allow ordinary HTTP(S) product hyperlinks only; CSV uses the same URL gate and stronger formula neutralization. Tests reopen actual generated workbooks.

## Reusable capture workflow

See [capture-testing.md](capture-testing.md). Seven offline scenarios cover the observed live redesign, synthetic paid-delivery and legacy layouts, missing totals/items, explicit zero amounts, and hostile seller content. The corpus runs the production provider and reopens actual workbook output. Source provenance is explicit; only one source layout came from a live account page.

The sanitizer uses an inert document in a network-blocked, script-disabled Chromium context. It retains only supported structures and allowlisted values, replaces identifiers and product names, and rejects unsupported or oversized input. It preserves equality between repeated anonymous payment IDs so mobile/desktop copies deduplicate correctly. Raw captures and generated output are gitignored. The full extension harness now removes temporary profiles/certificates and detaches download listeners.

## Dependency audit

The initial `pnpm audit --json` reported 33 advisories (1 critical, 22 high, 9 moderate, 1 low). Updates and pinned patched transitive versions reduce that to **one high advisory**, with zero critical, moderate, or low findings in the installed dependency graph. Both direct upgrades and the lockfile are committed; UUID stays on the CommonJS-compatible 11.x release for existing consumers.

The remaining [node-forge signature-verification advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv) affects `node-forge` 1.4.0 through `wxt → web-ext-run → @devicefarmer/adbkit`. GitHub lists no patched release, and npm's latest published version is 1.4.0 at this check. This is the Android development tooling chain; it is not an application import in the shipped extension. It remains an unresolved dependency finding, not a claim of zero risk. No private crypto patch or audit suppression was introduced.

The 14-day dependency release-age policy and install-script allowlist remain enabled. Two exact, recently published security fixes (`source-map-js@1.2.2`, `shell-quote@1.11.0`) have narrow cooldown exemptions. All other dependencies retain the existing policy. Overrides should be removed as upstream dependency ranges incorporate the fixes.

The audit covers the installed package graph; it is not a comprehensive security certification of the extension or every vendored asset.

## Verification and limits

Final validation: **284 Node tests, 274 Vitest tests, and 36 Chromium integration/end-to-end tests passed**. Chrome and Firefox MV3 builds succeeded. `git diff --check` passed. The live-invoice comparison was rerun with the hardened sanitizer and its generated workbook reopened successfully.

The regressions for zero amounts, averages, invalid dates, month-end ranges, unsafe hyperlinks, whitespace-prefixed CSV formulas, and standalone dashboard impersonation failed before their fixes. The Chromium checks cover all dashboard navigation views and inert rendering of hostile stored seller text. The specific live-invoice before/after comparison still reproduces zero items/no total with the original provider and 20 charged lines/$53.48 with the patch after sanitization.

The GitHub reporter's exact historical payloads remain unavailable. In-store split tender amounts that Walmart does not expose remain unresolved. Issue #22 is not fully fixed by the date-validation improvements. No exhaustive guarantee covers every account, layout, field, or future website change. The user's installed Chrome extension/profile was not modified by the isolated tests.
