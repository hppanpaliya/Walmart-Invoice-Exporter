# Edge & Firefox Ports

Tooling to package the extension for Microsoft Edge and Mozilla Firefox
**without modifying any Chrome source file**. All adaptation happens at
build time in `scripts/`.

## Building

Run from the repo root (requires `node`, `zip`):

```bash
bash scripts/build-firefox.sh   # -> dist/firefox/ + dist/Walmart-Invoice-Exporter-firefox-<version>.zip
bash scripts/build-edge.sh      # -> dist/edge/    + dist/Walmart-Invoice-Exporter-edge-<version>.zip
```

Both scripts are idempotent (they wipe their `dist/` subfolder first) and
copy the exact file set used by `.github/workflows/release.yml`. The zips
have `manifest.json` at the zip root, as both stores require.

## Edge

Edge is Chromium: the package is **byte-identical to the Chrome build**
(same MV3 service worker, `chrome.sidePanel`, permissions). Submit the zip
via the [Microsoft Partner Center / Edge Add-ons dashboard](https://partner.microsoft.com/dashboard/microsoftedge).
For local testing: `edge://extensions` → enable Developer mode → "Load
unpacked" → select `dist/edge/`.

## Firefox

Firefox MV3 differs from Chrome in ways the build script handles by
transforming `dist/firefox/manifest.json`:

| Chrome | Firefox | Handled by |
|---|---|---|
| `background.service_worker` | Not supported; MV3 backgrounds are **event pages** via `background.scripts` | `"background": {"scripts": ["firefox-shim.js", "utils.js", "background.js"]}` |
| `importScripts('utils.js')` (background.js line 7) | `importScripts` doesn't exist in event pages | `utils.js` preloaded via `background.scripts`; `firefox-shim.js` defines a no-op `importScripts` |
| `side_panel` key + `sidePanel` permission | Not supported; equivalent is `sidebar_action` (no permission needed) | Key/permission removed; `sidebar_action` added pointing at the same `sidepanel.html` |
| `chrome.sidePanel.open({windowId})` in `action.onClicked` | `browser.sidebarAction.open()` (must run in a user-gesture handler — `onClicked` qualifies) | `firefox-shim.js` polyfills `chrome.sidePanel.open` |
| `minimum_chrome_version` | Chrome-only key (Firefox warns) | Removed |
| — | AMO signing requires a stable add-on ID | `browser_specific_settings.gecko` with id `walmart-invoice-exporter@hppanpaliya.github.io`, `strict_min_version: "128.0"` (ESR) |

Everything else needs no changes: Firefox supports the `chrome.*` namespace
with callback-style APIs, and the code only uses `chrome.tabs`,
`chrome.storage.local`, `chrome.runtime`, and `chrome.action` — all
available in Firefox MV3. Downloads are done via blob anchors and hidden
tabs, not `chrome.downloads`, so no extra permission is required.

### Loading in Firefox

- **Temporary (dev):** `about:debugging#/runtime/this-firefox` → "Load
  Temporary Add-on…" → select `dist/firefox/manifest.json`. Removed on
  browser restart.
- **Permanent:** submit the firefox zip to
  [addons.mozilla.org](https://addons.mozilla.org/developers/) (AMO) for
  signing — Firefox will not permanently install unsigned extensions.

### Known limitations in Firefox

- **UNTESTED LIVE.** The Firefox build has been produced and the manifest
  validated, but it has not been exercised against walmart.com in a real
  Firefox session.
- **Sidebar UX differs from Chrome's side panel.** Firefox's sidebar is a
  global browser sidebar (left/right, shared switcher with bookmarks etc.),
  not a per-window panel tied to the extension icon. Clicking the toolbar
  button opens it via the shim; users can also open it from the sidebar
  switcher. Width and theming behave differently than Chrome's side panel.
- **Host permissions are user-controllable in Firefox MV3.** Firefox treats
  MV3 `host_permissions` as optional-by-design; Firefox 127+ prompts at
  install, but users can revoke `https://www.walmart.com/*` later, which
  silently stops the content scripts. Chrome grants them unconditionally.
- **Event page vs service worker lifetimes differ.** Firefox event pages
  suspend on idle like Chrome service workers, but timing differs; the
  in-memory `CollectionState` is already storage-backed, so this should be
  equivalent, but long multi-page collections are the area to watch.
- **AMO submission note:** new AMO submissions (since late 2025) must
  declare `browser_specific_settings.gecko.data_collection_permissions`
  (this extension collects nothing, so `{"required": ["none"]}`). It is not
  added to the manifest by the build script because it requires a newer
  Firefox than the 128 ESR floor to be recognized — add it at submission
  time if AMO's validator demands it.

### Deliberately NOT changed

- No Chrome source file (`background.js`, `utils.js`, `sidepanel.*`,
  `content.js`, `manifest.json`) was touched — Firefox adaptation is done
  entirely by the build script plus the new `firefox-shim.js`, which is only
  copied into the Firefox package.
- No `webextension-polyfill` / promise migration: Firefox supports the
  callback-style `chrome.*` namespace the code already uses.
- The `.github/workflows/release.yml` Chrome release flow is untouched; the
  new scripts are manual/local for now.
