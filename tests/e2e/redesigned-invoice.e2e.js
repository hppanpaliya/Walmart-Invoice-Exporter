'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launch, ONLINE_ORDER } = require('./helpers/harness');
const root = path.join(__dirname, '..', '..');

test('redesigned Walmart invoice: actual scraper reads modern DOM, excludes uncharged items and reconciles totals', async () => {
  const { context, close } = await launch();
  try {
    const page = await context.newPage();
    await page.goto(`https://www.walmart.com/orders/${ONLINE_ORDER}`);
    await page.setContent(fs.readFileSync(path.join(root, 'tests/fixtures/redesigned-order.html'), 'utf8'));
    for (const script of ['utils.js', 'providers/base.js', 'providers/registry.js', 'providers/walmart-us.js']) {
      await page.addScriptTag({ path: path.join(root, 'public', script) });
    }
    const data = await page.evaluate(() => window.ProviderRegistry.getById('WALMART_US').scrapeOrder({}));
    assert.equal(data.orderNumber, ONLINE_ORDER);
    assert.equal(data.items.length, 2);
    assert.deepEqual(data.items.map(i => i.productName), ['Synthetic Milk', 'Synthetic Produce']);
    assert.deepEqual(data.items.map(i => i.quantity), ['2', '1']);
    assert.equal(data.items[0].productLink, 'https://www.walmart.com/ip/100');
    assert.equal(data.items[0].deliveryStatus, 'Delivered on Oct 06');
    assert.equal(data.subtotalBeforeSavings, '$20.53');
    assert.equal(data.savings, '-$2.00');
    assert.equal(data.orderSubtotal, '$18.53');
    assert.equal(data.deliveryCharges, '$2.95');
    assert.equal(data.bagFee, '$0.40');
    assert.equal(data.tax, '$1.14');
    assert.equal(data.tip, '$4.00');
    assert.equal(data.orderTotal, '$27.02', 'never take the temporary authorization total');
    assert.equal(data.orderType, 'GLASS');
    assert.equal(data.fulfillmentTypes, 'SC_DELIVERY');
    assert.equal(data.paymentSplit, 'Walmart Cash: $8.00; Visa Ending in 1234: $19.02');
    assert.deepEqual(data.extractionWarnings, []);
    const money = value => Number(value.replace(/[^0-9.-]/g, ''));
    assert.equal(Math.round(data.items.reduce((sum, item) => sum + money(item.price), 0) * 100), 1853);
    assert.equal(Math.round(['orderSubtotal', 'deliveryCharges', 'bagFee', 'tax', 'tip'].reduce((sum, key) => sum + money(data[key]), 0) * 100), 2702);

    // Walmart can add new fee rows without changing the surrounding invoice
    // structure. Named fields stay queryable and unfamiliar adjustments are
    // preserved verbatim for the Excel "Other Adjustments" cell.
    await page.evaluate(() => {
      const totals = document.querySelector('.bill-order-payment-spacing');
      const append = (label, amount) => {
        const row = document.createElement('div');
        row.className = 'flex justify-between';
        row.innerHTML = `<span>${label}</span><span>${amount}</span>`;
        totals.appendChild(row);
      };
      append('Promo code', '-$4.00');
      append('3 hours or less fee', '$2.95');
      append('Returned 3 hours or less fee', '-$2.95');
      append('Refund', '-$3.00');
      append('Donations', '$0.25');
      append('Eco handling adjustment', '$0.50');
      // A receipt layout can retain the accessible method label but drop the
      // flex utility classes previously used to locate tender rows.
      document.querySelector('.bill-order-payment-info .flex.items-center.mb3').className = 'payment-method-row';
    });
    const adjusted = await page.evaluate(() => window.ProviderRegistry.getById('WALMART_US').scrapeOrder({}));
    assert.equal(adjusted.promoCodeAmount, '-$4.00');
    assert.equal(adjusted.threeHoursOrLessFee, '$2.95');
    assert.equal(adjusted.returnedThreeHoursOrLessFee, '-$2.95');
    assert.equal(adjusted.refund, '-$3.00', 'a visible refund row must work without JSON');
    assert.equal(adjusted.donations, '$0.25');
    assert.deepEqual(adjusted.financialAdjustments, [{ label: 'Eco handling adjustment', amount: '$0.50' }]);
    assert.equal(adjusted.paymentSplit, 'Walmart Cash: $8.00; Visa Ending in 1234: $19.02');

    // An order absent from the embedded history must never borrow a neighbour's
    // metadata. DOM invoice lines and totals still work without that summary.
    await page.evaluate(() => document.querySelector('script#__NEXT_DATA__').remove());
    const domOnly = await page.evaluate(() => window.ProviderRegistry.getById('WALMART_US').scrapeOrder({}));
    assert.equal(domOnly.items.length, 2);
    assert.equal(domOnly.orderTotal, '$27.02');
    assert.equal(domOnly.fulfillmentTypes, '');

    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.bill-order-payment-spacing .justify-between')).find(n => n.firstElementChild.textContent === 'Delivery from store');
      row.innerHTML = '<div>Free delivery from store</div><span class="ld_Ec">Normally $9.95, Now $0</span><div><span class="strike">$9.95</span><span>$0</span></div>';
    });
    const free = await page.evaluate(() => window.ProviderRegistry.getById('WALMART_US').scrapeOrder({}));
    assert.equal(free.deliveryCharges, '$0', 'the crossed-out delivery price is not charged');

    await page.evaluate(() => {
      const row = document.createElement('div');
      row.className = 'flex justify-between';
      row.innerHTML = '<span>Express delivery</span><span>$5.00</span>';
      document.querySelector('.bill-order-payment-spacing').appendChild(row);
    });
    const express = await page.evaluate(() => window.ProviderRegistry.getById('WALMART_US').scrapeOrder({}));
    assert.equal(express.deliveryCharges, '$5.00', 'express fee is added to free standard delivery');
  } finally {
    await close();
  }
});
