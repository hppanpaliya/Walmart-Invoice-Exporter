# Private capture and offline regression tests

The capture corpus makes invoice bugs reproducible without a Walmart login, cookies, personal order details, or live network calls. It runs the production provider and reopens real Excel output. The packaged-extension tests separately cover collection, caching, both export modes, dashboard navigation/refresh, and the dashboard-to-panel bridge.

## Capture safely

Keep raw saved HTML in `.private-captures/` (gitignored). Never commit raw captures or add account/browser profiles. Save rendered HTML, rather than relying on an SSR response that may lack hydrated invoice content.

```sh
pnpm run capture:invoice .private-captures/order.html tests/fixtures/captures/new-case.html
```

The sanitizer parses HTML in an inert document in a fresh Chromium context, disables page JavaScript and service workers, and blocks every network request. It copies only supported invoice structures, known class names, known labels, amounts, and quantities. It replaces product names, dates, order numbers, product links, and card endings; removes addresses, unknown text, arbitrary attributes, scripts, event handlers, resources, styles, and embedded data; caps input at 8 MiB; and refuses unsupported pages. Output creation is exclusive, so an existing fixture cannot be overwritten accidentally.

Amounts and quantities intentionally remain for reconciliation. These fixtures are reduced regression evidence, not a guarantee of anonymity against correlation with other financial records. Inspect a new fixture before committing it. The sanitizer deliberately discards unknown fields: extend its allowlist and its privacy regression together when a new layout needs support.

## Corpus provenance and expected behavior

`tests/fixtures/captures/manifest.json` names each case and records its source and expected item count, subtotal, total, delivery fee, and warnings. One fixture derives from the observed live redesigned page. The paid-delivery and legacy fixtures are synthetic layouts; missing fields, zero totals, and hostile text are explicitly labelled synthetic scenarios. They are not additional live account captures.

```sh
pnpm run test:captures
pnpm run test:e2e
pnpm test
pnpm run test:vitest
```

The corpus checks charged-item reconciliation, ignores temporary authorizations, exercises incomplete pages, and verifies that generated workbooks have the expected rows/totals without formulas or unsafe hyperlinks. The privacy test includes fake addresses/identifiers, scripts, handlers, hostile resource URLs, and unknown text; verifies deterministic output; and checks size/layout rejection.

Add a manifest entry for a supported fixture with known expected amounts. New fault variants belong in `tests/e2e/capture-corpus.e2e.js`. The full packaged-extension harness serves Walmart requests through a local rejecting proxy, removes its temporary profile and certificates, and detaches download listeners after each operation. CI already runs all `*.e2e.js` files.

`scripts/verify-invoice-capture.cjs` retains the original before/after comparison for the specific 20-line invoice investigated on October 12. Its assertions are invoice-specific; the corpus and capture CLI are the reusable workflow. Generated workbooks under `output/` are gitignored.
