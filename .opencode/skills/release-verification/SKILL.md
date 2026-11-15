---
name: Release verification
description: Verify a Walmart Invoice Exporter build end to end before a store release - test suites, the packaged extension on real order pages served locally, settings, the local AI bridge, an update from the previous store version, and the release zip.
---

# Release verification

Use this before merging a release branch or uploading a zip. Read `AGENTS.md`
at the repository root first: its privacy rules and test-harness traps apply
to every step here.

Report only what you observed. "Passed" means the packaged build did it in a
browser; a unit test or a code reading is a weaker claim and should be
labeled as such. Say plainly what you could not verify.

## 1. Build and suites, on a clean worktree

Untracked files in `public/` are packaged, so never build a release from a
working tree with drafts in it.

```sh
git worktree add --detach <dir> <commit>
ln -s <repo>/node_modules <dir>/node_modules
cd <dir>
node --test tests/*.test.js
node_modules/.bin/vitest run
node_modules/.bin/wxt build && node_modules/.bin/wxt build -b firefox --mv3
node --test --test-concurrency=1 tests/e2e/*.e2e.js
node_modules/.bin/wxt zip
```

## 2. The packaged build on real order pages

Walmart challenges automated browsers, and the user's everyday browser cannot
load an unpacked build through automation. So: capture real pages in the
user's signed-in browser, serve them locally, and run the packaged build
against them.

1. Ask the user before reading their order pages. Capture a mix: delivered,
   partly canceled, fully canceled, one with a refund, one with substituted or
   weight-adjusted items. The order list needs paging to find these (5 orders
   per page; listen for the `orchestra` responses while clicking "Next page").
2. For each page save `document.documentElement.outerHTML` with every script
   removed except `type="application/json"`. Write them to a temporary
   directory outside the repository with owner-only permissions.
3. Build the order-list page from the list payload: put the chosen order
   objects in the `orders` array and set `pageInfo` to `{}`.
4. Serve both through a local HTTPS server behind a CONNECT proxy (copy the
   pattern from `tests/e2e/helpers/mock-walmart.js`); pass
   `*.walmartimages.com` through so stylesheets load; refuse everything else.
5. Drive the panel as `tests/e2e/helpers/harness.js` does and check:
   - every export format produces a file that parses and contains every order;
   - charged line counts and unfulfilled line counts equal an independent
     count from the payload's categories;
   - the dashboard total equals the sum of exported order totals, and the
     average leaves out fully canceled orders;
   - no extraction warning asks for a report.
6. Delete the captured pages. Print counts and booleans only.

Known limit: saved pages cannot open Walmart's charge-history panel, so an
order paid with two methods shows the "amount per method unavailable" notice.

## 3. Settings

For every control in Settings: change it through the UI, diff
`chrome.storage.local` to see what was written, reload, and confirm the value
and the matching main-view control. Then check limits (timings, retention
days, port), "Reset settings to defaults", and "Delete all saved data" with
both dialog buttons.

## 4. Local AI bridge

Install the published relay in a scratch directory
(`npm install walmart-invoice-mcp --ignore-scripts`), start it with
`--token <token from Settings> --port <port>`, and speak MCP to it over stdio.
Set `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK=1` or the extension
cannot reach it. Check: nothing connects while the toggle is off; pairing;
every read tool against seeded data; action tools refused until "Allow AI
tools to collect data" is on; a wrong token is rejected; the relay listens on
`127.0.0.1` only.

## 5. Update from the previous store version

Download the previous release zip, unpack it into a directory, run it with a
persistent profile, save data and change settings. Replace the directory's
contents with the new build (same path keeps the extension ID) and start
again on the same profile. Compare every IndexedDB record and every storage
key before and after, and the dashboard figures.

Do not start a collection on the reused profile: headless Chromium crashes
there with any version. Render the list from the database instead.

## 6. The release zip

Compare `unzip -v` listings (name and CRC) of the zip GitHub built with the
zip from the tested worktree. They must be identical. Check the manifest's
version and that permissions did not grow.

## 7. After pushing

Each push publishes branch releases. Run `gh release edit latest-main --latest`
so the badge stays on `main` until the merge.
