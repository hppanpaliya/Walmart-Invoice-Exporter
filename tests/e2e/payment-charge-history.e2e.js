'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { launch, ONLINE_ORDER } = require('./helpers/harness');
const root = path.join(__dirname, '..', '..');

test('scrapeOrder reads missing split-tender amounts from Walmart charge history', async () => {
  const { context, close } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`https://www.walmart.com/orders/${ONLINE_ORDER}`);
    await page.setContent(`<!doctype html><html><body>
      <div class="print-bill-bar-id">Order# ${ONLINE_ORDER}</div>
      <div class="print-bill-group"><div data-testid="itemtile-stack">
        <div class="print-item-title"><div data-testid="productName">Synthetic item</div></div>
        <div class="bill-item-quantity">Qty 1</div><div data-testid="line-price">$69.41</div>
      </div></div>
      <div class="print-bill-payment-section">
        <div class="bill-order-payment-info">
          <div class="flex items-center mb3"><img alt="Gift Card"><span aria-labelledby="card-description-0">Ending in 2468</span><span class="tr"></span></div>
          <div class="flex items-center mb3"><img alt="PayPal"><span aria-labelledby="card-description-1">Ending in 48QZ</span><span class="tr"></span></div>
        </div>
        <div class="bill-order-payment-spacing">
          <div class="justify-between"><span>Items</span><span>$65.00</span></div>
          <div class="justify-between"><span>Driver tip</span><span>$3.00</span></div>
          <div class="justify-between"><span>Refund</span><span>-$2.00</span></div>
          <div class="justify-between"><span>Total</span><span>$70.41</span></div>
        </div>
        <button id="charge-history" aria-label="Charge history">Charge history</button>
      </div>
      <div id="history" role="dialog" style="display:none">
        <button aria-label="Gift Card Ending in 2468">Gift Card</button>
        <button aria-label="PayPal Ending in 48QZ">PayPal</button>
        <button aria-label="close panel">Close</button>
        <section><h3>Viewing order charge history of Gift Card ending in 2468</h3><h4>Final charges</h4>
          <ul><li><h6>Order charge</h6><span>$19.07 11:26 AM</span></li>
          <li><h6>Refund</h6><span>-$2.00 11:27 AM</span></li></ul>
          <h4>Temporary holds</h4><ul><li><h6>Temporary hold</h6><span>$90.00</span></li></ul>
        </section>
        <section><h3>Viewing order charge history of PayPal Ending in 48QZ</h3><h4>Final charges</h4>
          <ul><li><h6>Order charge</h6><span>$50.34 11:26 AM</span></li>
          <li><h6>Driver tip</h6><span>$3.00 11:27 AM</span></li></ul>
          <h4>Temporary holds</h4><ul><li><h6>Temporary hold</h6><span>$100.00</span></li></ul>
        </section>
      </div>
      <script>document.querySelector('#charge-history').addEventListener('click', () => { document.querySelector('#history').style.display='block'; });
      document.querySelector('[aria-label="close panel"]').addEventListener('click', () => { document.querySelector('#history').style.display='none'; });</script>
    </body></html>`);
    for (const script of ['utils.js', 'providers/base.js', 'providers/registry.js', 'providers/walmart-us.js']) {
      await page.addScriptTag({ path: path.join(root, 'public', script) });
    }

    const result = await page.evaluate(async () => {
      const provider = window.ProviderRegistry.getById('WALMART_US');
      const data = await provider.scrapeOrder({});
      return { data, drawerHidden: document.querySelector('#history').style.display === 'none' };
    });

    assert.equal(result.data.paymentSplit,
      'Gift Card Ending in 2468: $17.07; PayPal Ending in 48QZ: $53.34');
    assert.deepEqual(result.data.extractionWarnings, []);
    assert.equal(result.drawerHidden, true, 'scraping closes the drawer after reading it');
  } finally {
    await close();
  }
});
