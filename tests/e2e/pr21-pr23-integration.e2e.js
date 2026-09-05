/**
 * End-to-end browser tests verifying PR #21 and PR #23 in a real Chromium browser context.
 *
 * PR #21:
 * - Extracts split-tender amounts from modern Walmart order DOM (amount has .tr, sibling has flex-auto)
 * - Formats tender labels without duplicate brand names ("Walmart Cash", not "Walmart Cash Walmart Cash")
 * - Flags missing per-tender amounts when split across multiple tenders
 *
 * PR #23:
 * - Traverses categories in __NEXT_DATA__ to exclude UNAVAILABLE / cancelled items from invoice lines
 * - Guards mergeOrderItems from resurrecting excluded items via the DOM print bill
 * - Retries in-store orders with storePurchase=true
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launch } = require('./helpers/harness');

test('PR #21 and PR #23 integration in real Chromium browser', async (t) => {
  const { context, extensionId, panel, close } = await launch();

  try {
    await t.test('PR #21: browser extracts split-tender amounts from modern DOM and formats labels cleanly', async () => {
      const result = await panel.evaluate(() => {
        const provider = window.ProviderRegistry.getById('WALMART_US');
        if (!provider) throw new Error('WALMART_US provider not found');

        // Create synthetic modern Walmart payment row in the document
        const container = document.createElement('div');
        container.className = 'bill-order-payment-info';
        container.innerHTML = `
          <div class="flex items-center mb3">
            <img alt="Walmart Cash" src="icon.png" />
            <div class="flex flex-column flex-auto">
              <span aria-labelledby="card-description-0">Walmart Cash</span>
            </div>
            <span class="ld_Ee ld_Ek ld_Eh tr"><div>$8.00</div></span>
          </div>
          <div class="flex items-center mb3">
            <img alt="Visa" src="icon.png" />
            <div class="flex flex-column flex-auto">
              <span aria-labelledby="card-description-1">Ending in 8527</span>
            </div>
            <span class="ld_Ee ld_Ek ld_Eh tr"><div>$107.75</div></span>
          </div>
        `;
        document.body.appendChild(container);

        try {
          const rows = Array.from(container.querySelectorAll('.flex.items-center.mb3'));
          const extractedMethods = rows.map((row) => {
            const endEl = row.querySelector('[aria-labelledby^="card-description-"]');
            const ending = endEl?.textContent?.trim() || '';
            const brand = row.querySelector('img[alt]')?.alt?.trim() || '';
            const amount = provider.readPaymentRowAmount(row);
            return { brand, ending, amount };
          });

          // Test tender label formatting
          const label1 = provider.buildTenderLabel('Walmart Cash', 'Walmart Cash');
          const label2 = provider.buildTenderLabel('Visa', 'Ending in 8527');

          // Test payment split string via utils
          const paymentSplit = window.formatPaymentMethodDetails
            ? window.formatPaymentMethodDetails({ paymentMethodDetails: extractedMethods })
            : '';

          return { extractedMethods, label1, label2, paymentSplit };
        } finally {
          container.remove();
        }
      });

      // Verify PR #21's readPaymentRowAmount read the right amounts
      assert.equal(result.extractedMethods[0].amount, '$8.00');
      assert.equal(result.extractedMethods[1].amount, '$107.75');

      // Verify PR #21's buildTenderLabel dedupes identical brand/ending
      assert.equal(result.label1, 'Walmart Cash');
      assert.equal(result.label2, 'Visa Ending in 8527');
    });

    await t.test('PR #21: computeExtractionWarnings flags split tender when amounts are absent', async () => {
      const warnings = await panel.evaluate(() => {
        const provider = window.ProviderRegistry.getById('WALMART_US');
        const orderData = {
          orderNumber: '582515916131486157579',
          orderTotal: '$204.26',
          items: [{ productName: 'Fresh Strawberries', price: '$4.34' }],
          paymentMethodDetails: [
            { cardId: 'card-description-0', brand: '', ending: 'Ending in 2043', amount: '' },
            { cardId: 'card-description-1', brand: '', ending: 'Walmart Visa ending in 8527', amount: '' },
          ],
        };
        return provider.computeExtractionWarnings(orderData);
      });

      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /Split tender across 2 payment methods/);
    });

    await t.test('PR #23: extractItemsFromNextData excludes UNAVAILABLE lines and keeps duplicate items', async () => {
      const extraction = await panel.evaluate(() => {
        const provider = window.ProviderRegistry.getById('WALMART_US');
        const mockOrder = {
          id: '200019999999999',
          priceDetails: { subTotal: { value: 24.41 } },
          groups_2101: [
            {
              fulfillmentType: 'DELIVERY',
              categories: [
                {
                  type: 'REGULAR',
                  items: [
                    { name: 'Organic Bananas', quantity: 1, priceInfo: { linePrice: { value: 1.99, displayValue: '$1.99' } } },
                    // Two identical separate lines
                    { name: 'Avocado', quantity: 1, priceInfo: { linePrice: { value: 1.25, displayValue: '$1.25' } } },
                    { name: 'Avocado', quantity: 1, priceInfo: { linePrice: { value: 1.25, displayValue: '$1.25' } } },
                  ],
                },
                {
                  type: 'UNAVAILABLE',
                  name: 'Unavailable items',
                  items: [
                    { name: 'Out of Stock Coffee Beans', quantity: 1, priceInfo: { linePrice: { value: 14.99, displayValue: '$14.99' } } },
                  ],
                },
                {
                  type: 'RETURNED',
                  name: 'Returned items',
                  items: [
                    { name: 'Dish Soap', quantity: 1, priceInfo: { linePrice: { value: 4.93, displayValue: '$4.93' } } },
                  ],
                },
              ],
            },
          ],
        };

        const items = provider.extractItemsFromNextData(mockOrder);
        return {
          itemNames: items.map((i) => i.productName),
          fromChargedCategories: Boolean(items.fromChargedCategories),
          length: items.length,
        };
      });

      // UNAVAILABLE must be excluded
      assert.ok(!extraction.itemNames.includes('Out of Stock Coffee Beans'));
      // Both avocados survive
      assert.equal(extraction.itemNames.filter((n) => n === 'Avocado').length, 2);
      // RETURNED survives because it was originally charged
      assert.ok(extraction.itemNames.includes('Dish Soap'));
      // fromChargedCategories tag is true
      assert.equal(extraction.fromChargedCategories, true);
      assert.equal(extraction.length, 4);
    });

    await t.test('PR #23: mergeOrderItems does not resurrect excluded items from DOM print bill', async () => {
      const merged = await panel.evaluate(() => {
        const provider = window.ProviderRegistry.getById('WALMART_US');
        const payloadItems = [
          { productName: 'Organic Bananas', quantity: '1', price: '$1.99' },
          { productName: 'Avocado', quantity: '1', price: '$1.25' },
        ];
        payloadItems.fromChargedCategories = true;

        // DOM print bill renders the cancelled item
        const domItems = [
          { productName: 'Organic Bananas', quantity: '1', price: '$1.99', productLink: 'https://walmart.com/ip/1' },
          { productName: 'Avocado', quantity: '1', price: '$1.25', productLink: 'https://walmart.com/ip/2' },
          { productName: 'Out of Stock Coffee Beans', quantity: '1', price: '$14.99' },
        ];

        return provider.mergeOrderItems(domItems, payloadItems);
      });

      // Out of Stock Coffee Beans must NOT be resurrected in the merged output
      assert.equal(merged.length, 2);
      assert.ok(!merged.some((i) => i.productName.includes('Coffee Beans')));
      // Backfill should have attached productLink
      assert.equal(merged[0].productLink, 'https://walmart.com/ip/1');
    });
  } finally {
    await close();
  }
});
