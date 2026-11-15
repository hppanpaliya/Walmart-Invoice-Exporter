# Working in this repository

Walmart Invoice Exporter is a Chrome (MV3) and Firefox extension that collects a
user's Walmart order history, saves invoices on the device, exports them
(Excel, CSV, JSON, printable receipt, PDF) and shows a spending dashboard.
Everything runs locally; the only optional network feature is a relay on
`127.0.0.1` for local AI tools.

Read this file first. Deeper notes live in `docs/` (see the end).

## Commands

CI uses pnpm (`pnpm test`, `pnpm run test:vitest`, `pnpm run test:e2e`,
`pnpm run build`, `pnpm run zip`). Where pnpm is not available, the same
things run straight from `node_modules`:

```sh
node --test tests/*.test.js                               # Node unit tests
node_modules/.bin/vitest run                              # same tests, Vitest runner
node --test --test-concurrency=1 tests/e2e/*.e2e.js       # packaged extension in Chromium
node_modules/.bin/wxt build                               # dist/chrome-mv3
node_modules/.bin/wxt build -b firefox --mv3              # dist/firefox-mv3
node_modules/.bin/wxt zip                                 # store zip
bash store-assets/scripts/generate-store-assets.sh        # listing screenshots and tiles
```

## Layout

| Path | What it is |
|---|---|
| `public/` | Shipped as is. WXT copies the whole folder, so any file left here ends up in the store zip. |
| `public/providers/walmart-us.js`, `walmart-ca.js` | Extraction from Walmart's page payload and DOM. |
| `public/background-main.js` | Collection loop (order history pages), session state. |
| `public/content.js`, `walmart-mainworld.js` | Content script and its main-world bridge. |
| `public/sidepanel.*.js` | The panel: actions, downloads queue, settings, view. |
| `public/utils.js` | Constants and every export writer. |
| `public/dashboard.*.js`, `entrypoints/dashboard/` | Dashboard page, view modules, pure stats modules. |
| `public/mcp-bridge.js` | Extension half of the local AI bridge (`walmart-invoice-mcp` on npm is the relay). |
| `tests/`, `tests-vitest/` | Twin unit suites. A change to one file needs the same change in its twin when the twin exists. |
| `tests/e2e/` | Drives the packaged build against a local mock of walmart.com. |
| `store-assets/` | Listing media, description, and the scripts that generate them. |

## Rules that are easy to break

**Data safety**
- Only three things fail an order: a missing or wrong order number, no usable
  item lines (unless `noChargedItems` is set), or no order total. See
  `invoiceProblems` in `public/sidepanel.download.js`.
- Everything else is optional. Read it best effort, leave it off when Walmart
  does not send it, and never let it throw. `extractItemExtras` and
  `extractOrderExtras` in `walmart-us.js` are the pattern.
- `items` means charged lines and feeds every total. Lines that were never
  charged go in `unfulfilledItems`, never in `items`.
- Unknown money stays blank in exports. A made-up `0` corrupts spreadsheets
  and bank imports.

**Alerts**
- Ask the user to report only for an unexpected problem. Things Walmart did
  not provide, a refused refresh, a human check, or a collection that stopped
  early are notices that say what happened and what to do.

**Exports**
- `tests/golden.test.js` pins the output of every format. New columns are
  appended after the existing ones so users' spreadsheets keep working.
- Accounting presets (QuickBooks, Xero) skip orders with an unknown or zero
  total.

**Saved data**
- `CONSTANTS.WALMART_US_EXTRACTION_VERSION` marks what an invoice was read
  with. Raise it whenever extraction output changes: saved invoices below the
  current version are fetched again on their next export. Users notice that
  first export being slow, so say so in the changelog.
- Never change the IndexedDB layout or rename a `chrome.storage.local` key
  without a migration and a test in `tests/storage-migration.test.js`.

**Privacy**
- No real order data in the repository: order numbers, names, addresses, card
  endings, emails. Fixtures are synthetic. Raw captures belong in
  `.private-captures/` (ignored). History was rewritten once to remove real
  card endings; do not repeat the mistake.
- Never print personal data in tool output, logs or CI. Report counts and
  booleans.
- Store media shows the demo catalog in `store-assets/scripts/demo-seed.js`.

**GitHub**
- Every push to any branch runs `.github/workflows/release.yml`, which
  publishes public releases named `v<version>-<branch>` and `latest-<branch>`.
  After pushing a branch other than `main`, put the badge back:
  `gh release edit latest-main --latest`.
- Do not push branches named `backup/pre-sanitize-*`.

**Walmart's human check**
- Walmart shows "Robot or human?" to automated browsers. Do not disguise the
  browser to get past it. Verify against captured pages instead (below).

## What Walmart's order payload looks like

- The order lives in `script#__NEXT_DATA__`. Line items are under
  `order.groups_2101[].categories[].items`. The flat `groups_2101[].items`
  list also contains items that were never charged, and
  `subGroups[].categories` is a duplicate of `categories`.
- Category types: `REGULAR`, `SUBSTITUTED`, `WEIGHT_ADJUSTED`, `RETURNED`
  (charged, then refunded), `UNAVAILABLE` and `CANCELED` (never charged).
- Prices per item: `priceInfo.linePrice` is the line total, `itemPrice` is the
  price of one ("$3.98 ea"), `unitPrice` is the comparison price
  ("24.9¢/oz"), `strikethroughPrice` is the "was" price.
- `productInfo.categoryPathId` is `0:<department id>:…`. Department names are
  in `WALMART_DEPARTMENTS` (`utils.js`). There is no brand field.
- The order total is already net of refunds.
- The order list shows 5 orders per page; its payload sits under
  `props.pageProps.phRedesignInitialData`.
- The human check is at `/blocked`, has the title "Robot or human?" and an
  element `#px-captcha`.

## Verifying against real data without touching Walmart

1. In the user's own signed-in browser, save the rendered order pages: the
   document's outer HTML with every `<script>` removed except
   `type="application/json"`. Keep them out of the repository.
2. Serve them from a local HTTPS server behind a CONNECT proxy (the pattern
   in `tests/e2e/helpers/mock-walmart.js`), and let `*.walmartimages.com`
   through so stylesheets load.
3. Run the packaged build against that, read the exported files, and compare
   with what the payload says. Delete the pages afterwards.

Saved pages cannot open Walmart's charge-history panel, so an order paid with
two methods shows the "amount per method unavailable" notice offline.

## Test-harness traps

- `launch()` in `tests/e2e/helpers/harness.js` rebuilds `dist/`. Never run two
  harness jobs in the same checkout at once.
- Build release artifacts from a clean worktree: untracked files in `public/`
  are packaged.
- Playwright sends loopback traffic through the proxy. Set
  `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK=1` when the extension
  must reach a local port (the MCP relay).
- Headless Chromium crashes (SIGSEGV) when a collection starts on the second
  launch of a persistent profile. It happens with any extension version.
  On a reused profile, render the order list from the database instead.
- An unpacked extension's ID comes from its path. To test an update, put the
  new build in the same directory and reuse the profile.
- Values from the `vm` sandbox fail `deepStrictEqual` against local literals.
  Convert with `toPlain` or `Array.from` first.
- The dashboard keeps its view in the URL hash. A test that reloads the page
  must click the view it needs.

## Releasing

1. Tests, e2e and both builds pass on the release commit, locally and on GitHub.
2. The zip GitHub builds matches the tested build (compare `unzip -v` listings).
3. Merge to `main`; GitHub publishes "Release v<version> - main".
4. Upload the zip to the Chrome Web Store, replace screenshots and tiles from
   `store-assets/`, paste `store-assets/description.md`.

## More

- `docs/release-8.8-verification.md`: what was checked for 8.8, how, and what was not.
- `docs/capture-testing.md`: sanitized capture corpus.
- `docs/reliability-audit-2026-10-14.md`, `docs/hardening-2026-10-12.md`: earlier audits.
- `docs/ROADMAP.md`: feature status.
- `.opencode/skills/`: step-by-step procedures for release verification and listing media.
