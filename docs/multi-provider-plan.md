# Walmart Invoice Exporter → Multi-Provider (Walmart family) Plan

Scope: add **Walmart.ca** and **Sam's Club** alongside the existing **Walmart.com**
support, using an adapter/provider architecture. All new behavior is **optional and
behind feature flags**, data is read **in-page from the user's own logged-in session
only**, and there is **no token capture, no `webRequest`, no background API replay,
no telemetry**.

## Guiding principles
1. **No token capture, no `webRequest`, no background replay.** Data is read in-page
   from the user's own logged-in session only.
2. **Everything optional and flagged.** Default install behaves exactly as v7.3 does
   today (Walmart.com only). New providers are off until the user opts in.
3. **Permissions acquired on demand.** walmart.ca / samsclub.com host access is
   requested at opt-in time, not forced on update.
4. **Refactor first, expand second.** Prove the adapter pattern with Walmart.com as
   the sole adapter before adding anything new.

## Architecture: provider adapter pattern

Introduce a provider registry that isolates everything site-specific behind one
interface. The shared engine (collection loop, DB, export, UI) stays
provider-agnostic.

```js
// providers/base.js — the interface every adapter implements
{
  id: 'WALMART_US',                 // stable key, also the DB partition
  label: 'Walmart.com',
  flag: 'provider.walmart_us',      // feature-flag key; controls visibility
  defaultEnabled: true,             // only Walmart.com is true
  hostPermissions: ['https://www.walmart.com/*'],
  contentMatches: ['https://www.walmart.com/orders*'],
  ordersListUrl: 'https://www.walmart.com/orders',
  locale: 'en-US', currency: 'USD',
  isOrdersListUrl(url) -> bool,
  collectOrderNumbers(ctx) -> { orderNumbers, summaries, additionalFields, hasNextPage },
  scrapeOrder(ctx) -> normalizedOrder,   // same normalized shape already exported
}
```

Recon finding: all three sites are the same Orchestra / `__NEXT_DATA__` platform, so
`WALMART_CA` and `SAMS_CLUB` are **config variants** of one shared base adapter
(`providers/walmart-family.js`), differing mainly in host, `PurchaseHistory` version,
locale, and currency — not three from-scratch implementations.

## Feature-flag system

- **Storage:** a `settings.flags` object in the existing store (`chrome.storage.local`
  or a `settings` store in IndexedDB). Shape:
  `{ 'provider.walmart_ca': false, 'provider.sams_club': false }`.
- **Registry-driven:** the provider registry declares each flag + `defaultEnabled`.
  A `Flags` helper (`flags.js`) resolves effective state and is the single source of
  truth read by background, content, and UI.
- **Gate at every layer:** background only collects for enabled providers; content.js
  only activates its adapter if that provider's flag is on; the sidepanel only shows
  enabled providers in the picker.
- **Enabling a provider is a transaction:** toggle on → request its optional host
  permission → on grant, persist flag = true and register its content script; on
  denial, revert the toggle. Toggling off → unregister content script,
  `chrome.permissions.remove()`, flag = false (existing data kept unless also deleted).

## Manifest changes

```jsonc
{
  "host_permissions": ["https://www.walmart.com/*"],          // unchanged default
  "optional_host_permissions": [                              // NEW
    "https://www.walmart.ca/*",
    "https://www.samsclub.com/*"
  ],
  "permissions": ["activeTab","storage","sidePanel","scripting"], // +scripting only if content scripts registered dynamically
  "content_scripts": [ /* walmart.com entry stays static */ ]
}
```

- Walmart.com stays a static content script → zero behavior change for current users,
  no re-permission prompt on update.
- walmart.ca / samsclub.com content scripts are **registered dynamically** via
  `chrome.scripting.registerContentScripts()` when their provider is enabled (the only
  reason to add the `scripting` permission). Alternative: declare all three statically
  + optional hosts, trading a cleaner manifest for an upgrade-time prompt.
- **Still no `webRequest`, no broad host grant.**

## Data layer (orderdb.js)

- Bump `DB_VERSION`; migrate the `orders` store from `keyPath: 'orderNumber'` to a
  **compound key `[provider, orderNumber]`**, add a `provider` index.
- Migration: existing rows get `provider: 'WALMART_US'` stamped in the
  `onupgradeneeded` handler. No data loss.
- All `OrderDb` methods (`putSummaries`, `getKnownOrderNumbers`, `getAllOrders`,
  `clearAll`) gain an optional `provider` filter; callers pass the active provider.

## Background (background.js)

- `CollectionState` gains a `provider` field. `handleStartCollection` receives
  `{ provider, ... }` from the panel.
- Replace Walmart literals (`isOrdersListUrl`, `ordersListUrl`) with lookups through
  the active provider adapter.
- The whole collection engine — hidden background tab, pagination, session mirroring,
  incremental early-stop, DB persistence — stays as-is; it just drives
  `provider.ordersListUrl` and messages the content script generically.
- Guard: refuse to start collection for a provider whose flag is off or whose host
  permission isn't granted.

## Content script (content.js / utils.js)

- Split the Walmart-specific extraction (the `__NEXT_DATA__` parser, the in-page fetch
  bridge, DOM fallback, `CONSTANTS.SELECTORS`) into `providers/walmart-family.js`.
- On load, content.js picks the adapter by `location.hostname` and delegates. If no
  adapter or the flag is off, it no-ops.
- **In-page fetch technique** (recon-confirmed): for pages after the first, call the
  site's own `orchestra/cph/graphql/PurchaseHistory…` operation from the page's session
  instead of clicking "next" and re-rendering — faster, and works identically across
  all three since it's the same API family. Keep the DOM / `__NEXT_DATA__` path as
  fallback.
- walmart.ca / Sam's Club deltas to confirm during build: `PurchaseHistoryV2` vs `V3`,
  currency/locale, and (for .ca) whether the OAuth session still lets an in-page
  same-origin fetch through — expected yes, but verified when logged in.

## UI (sidepanel + settings)

- **Provider picker** in the panel header (only shows enabled providers). Single-provider
  users see essentially today's UI.
- **Settings → Advanced → Providers:** a list of Walmart.ca and Sam's Club with
  off-by-default toggles, each with a one-line description. Toggling runs the permission
  transaction above.
- **Dashboard** aggregates across providers with a per-provider filter; currency handling
  becomes provider-aware (USD vs CAD).
- Export code is already format-driven and provider-neutral once orders are normalized —
  minimal change.

## Phased rollout

| Phase | Deliverable | Risk |
|---|---|---|
| 1 | Refactor Walmart.com into the adapter registry; provider-keyed DB migration. **No new provider, no UI change.** Prove parity with v7.3. | Low — pure refactor, fully testable now |
| 2 | Flag system + Advanced settings UI + optional-permission transaction. Walmart.ca / Sam's Club present but behind flags. | Low |
| 3 | Implement `WALMART_CA` and `SAMS_CLUB` as config variants; finish recon on live logged-in pages. | Medium — .ca OAuth + Sam's app-like page need live confirmation |
| 4 | Dashboard multi-provider aggregation + currency; docs, privacy policy, changelog. | Low |

## Testing
- Adapter unit tests with saved `__NEXT_DATA__` / API-response fixtures per provider
  (no live accounts needed in CI).
- Migration test: v7.3 DB → new compound-key schema, assert no data loss.
- Manual: enable each provider, confirm permission prompt, collect, export, then disable
  and confirm permission + content script are removed.

## What explicitly stays out
- No `webRequest`, no token/header capture, no background API replay, no telemetry, no
  servers. The "advanced/token" path is **not** in this plan.

## Open items (need live logged-in pages)
- **Walmart.ca:** confirm an in-page same-origin fetch works under its OAuth/OIDC
  session (login goes through `identity.walmart.com` with PKCE).
- **Sam's Club:** confirm page shape / where order data lives (app-like page; not
  inspected — session was logged out during recon).

## Recon notes (2026-07-18)
- **Walmart.com:** logged in; confirmed. Orders load via same-origin
  `GET /orchestra/cph/graphql/<Operation>/<queryHash>?variables=…`, cookie-authenticated.
  In-page fetch carries the session automatically — no token capture needed. `__NEXT_DATA__`
  holds config/feature-flags, not the order records themselves.
- **Sam's Club:** redirected to login (not signed in) — not inspectable this session.
  Known from platform parity to use `samsclub.com/orchestra/cph/graphql/PurchaseHistoryV2`.
- **Walmart.ca:** redirected to OAuth login (`identity.walmart.com`, PKCE) — not inspectable
  this session. Different auth model than walmart.com; flagged as the most likely to need
  special handling.
