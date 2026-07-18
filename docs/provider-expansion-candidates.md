# Provider Expansion Candidates

Companion to [`multi-provider-plan.md`](./multi-provider-plan.md). This ranks
retailers we could add **after** the Walmart family, judged against our model:
**in-page extraction from the user's own logged-in session, no token capture, no
`webRequest`, no background replay, everything optional and behind feature flags.**

## Framing

OrderPro (the extension we reverse-engineered) used `webRequest` + token capture for
many sites **only because it replays order APIs from the background**, where the
session isn't automatically available. In our in-page model we never capture anything —
the page's own `fetch` carries the session. So "easy for us" is broader than "easy for
OrderPro." The real difficulty driver for us is: **where does the order data live, and
can we read it from the logged-in page?**

## Tiers (easiest first)

### Tier 1 — Cheapest; same pattern we're already building
| Provider | Why easy |
|---|---|
| **Walmart.ca / Sam's Club** | Same Orchestra / `__NEXT_DATA__` platform — config variants (in progress) |
| **eBay** | Purchase-history pages, cookie-auth, DOM + embedded JSON; very well-trodden |
| **Best Buy** | Same-origin order-history JSON API, cookie session |
| **Home Depot** | Clean same-origin order API (`/api/ordersvc/v1/orders`), cookie |
| **Target** | Next.js + same-origin RedSky order API; the `x-api-key` is in the page, so an in-page fetch just works |

### Tier 2 — Easy, but need a tiny main-world injection to read a page global (still no token capture)
| Provider | Mechanism |
|---|---|
| **Etsy** | Read `Etsy.Context.data` global |
| **Temu** | Read `rawData.store` global |
| **Costco** | Same-origin orders GraphQL; client headers are page-available |
| **Kroger / Harris Teeter** | In-page `fetch`/XHR hook on `/atlas/v1/purchase-history` |

### Tier 3 — Doable but more work / more fragile
OAuth bearer held in JS memory, external API hosts, or heavy anti-bot. This is where
OrderPro leaned hardest on captured tokens; in-page is possible but each is bespoke.
- Nordstrom & Nordstrom Rack
- IKEA
- Sephora
- Wegmans (order data on a **separate** API host — cross-origin, the awkward one)
- Dick's Sporting Goods
- Apple (reportaproblem.apple.com)

### Tier 4 — Pure DOM scrapes, no API (fast to prototype, brittle to redesigns)
Lowe's, Staples, B&H Photo, Bass Pro, Cabela's, Tractor Supply, Rural King, Sweetwater,
At Home.

## Recommendation

After the Walmart family, the natural next adds — same in-page cookie/JSON pattern,
high user overlap, low effort — are **eBay, Target, Best Buy, and Home Depot**. Etsy and
Temu follow once we build the small "read a page global" injection helper (which Tier 2
needs anyway).

## Caveats
1. **Not yet verified per-site.** This is synthesized from the OrderPro bundle plus
   general platform knowledge, not fresh logged-in recon. Each provider needs a quick
   in-session check to confirm the data path (same as the walmart.ca / Sam's Club open
   items in the main plan).
2. **Anti-bot.** Several large sites (Target, Best Buy, Nordstrom) sit behind
   Akamai / PerimeterX bot protection. Our in-page approach is the most resilient option
   against it, but automated pagination can still be throttled.

## Next steps
- Optional: live logged-in recon on the Tier 1 shortlist (eBay / Target / Best Buy /
  Home Depot) to confirm the in-page data path before committing an adapter.
- Each confirmed provider becomes an optional, flagged adapter per the phased rollout in
  the main plan.
