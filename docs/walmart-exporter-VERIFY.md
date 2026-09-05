# Verifying the split-tender fix against a real order page

Two routes. The console one needs nothing installed and tests the exact code path that
matters, so do that first; the build is only worth it if you want the whole pipeline
proven end to end.

---

## 1. Console check (no build, ~20 seconds per order)

Open a Walmart order page and paste the block below. It runs the **patched** extraction
logic — the same selectors and the same money-shape guard — over the real DOM and prints
what the extension would now export, next to what it exports today.

```js
(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // NEW: every candidate must look like money, so a stray .tr can't be exported as one.
  const readAmount = (row) => {
    const cands = [row.querySelector('.tr.flex-auto'), ...row.querySelectorAll('.tr')];
    for (const c of cands) {
      const t = clean(c?.textContent);
      if (/-?\$\s*\d|\d+\.\d{2}/.test(t)) return t;
    }
    return '';
  };
  const readAmountOld = (row) => clean(row.querySelector('.tr.flex-auto')?.textContent);

  const rows = Array.from(
    document.querySelectorAll('.bill-order-payment-info .flex.items-center.mb3'));

  const collect = (read) => {
    const seen = new Set(), out = [];
    rows.forEach((row) => {
      const endEl = row.querySelector('[aria-labelledby^="card-description-"]');
      const ending = clean(endEl?.textContent);
      const cardId = clean(endEl?.getAttribute('aria-labelledby')) || ending;
      if (!cardId && !ending) return;
      const brand = clean(row.querySelector('img[alt]')?.alt);
      const amount = read(row);
      const key = `${cardId}|${brand}|${ending}|${amount}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ brand, ending, amount });
    });
    return out;
  };

  // Same shape buildPaymentSplit() produces, including buildTenderLabel() — which
  // avoids "Walmart Cash Walmart Cash" when img[alt] and the description agree.
  const tenderLabel = (b, e) => {
    b = clean(b); e = clean(e);
    if (!b) return e;
    if (!e) return b;
    return e.toLowerCase().includes(b.toLowerCase()) ? e : `${b} ${e}`;
  };
  const split = (ms) => ms.filter((m) => m.amount)
    .map((m) => `${tenderLabel(m.brand, m.ending)}: ${m.amount}`).join('; ');

  const now = collect(readAmountOld), fixed = collect(readAmount);
  const sum = fixed.reduce((n, m) =>
    n + (parseFloat((m.amount || '').replace(/[^0-9.]/g, '')) || 0), 0);

  const out = {
    orderType: document.body.innerText.match(/Store purchase|Delivery from store|Shipped|Pickup/)?.[0] || '?',
    paymentRows: rows.length,
    BEFORE_paymentSplit: split(now) || '(empty)',
    AFTER_paymentSplit: split(fixed) || '(empty)',
    tenders: fixed,
    tenderSum: sum.toFixed(2),
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
})()
```

**What to look for**

- `AFTER_paymentSplit` populated while `BEFORE_paymentSplit` is `(empty)` — the fix working.
- `tenderSum` equal to the order total shown on the page.
- On an **in-store** order both stay empty and `tenderSum` is `0.00`. That is correct and
  expected: Walmart does not publish the split there, which is what the new warning covers.

**Worth running on one of each**, because that is what varies the markup — not the order:

- [ ] Delivery from store
- [ ] Shipped / marketplace seller
- [ ] Pickup
- [ ] In-store

---

## 2. Full build (proves the whole export pipeline)

Only needed if you want to see the amounts land in an actual `.xlsx`.

```powershell
cd X:\Personal\walmart-invoice-exporter
npm install -g pnpm          # not currently installed
pnpm install --frozen-lockfile
pnpm exec wxt build          # writes .output\chrome-mv3
```

Then in Edge or Chrome:

1. `edge://extensions` (or `chrome://extensions`)
2. Turn on **Developer mode**
3. **Load unpacked** → `X:\Personal\walmart-invoice-exporter\.output\chrome-mv3`
4. **Disable the Web Store copy** first, or two of them will both act on the page
5. Re-export a split-tender order and check the `Payment Split` column

Turn the store version back on afterwards.

---

## Orders to test with

Known split-tender, from `X:\Finance\personal\reports\receipt-gaps.md`:

| Order | Total | Expected split |
|---|---:|---|
| [200014001429225](https://www.walmart.com/orders/200014001429225) | 115.75 | Walmart Cash 8.00 + Visa 8527 107.75 — **confirmed** |
| [200013039996427](https://www.walmart.com/orders/200013039996427) | 93.57 | gap 3.50 |
| [200014610875731](https://www.walmart.com/orders/200014610875731) | 37.54 | gap 6.00 |
| [200013677297165](https://www.walmart.com/orders/200013677297165) | 53.08 | gap 4.00 |

And an in-store one, which should stay empty and trigger the warning:
[582515916131486157579](https://www.walmart.com/orders/582515916131486157579) — 204.26,
true split 3.75 rewards + 200.51 card, visible only on the printed receipt image.
