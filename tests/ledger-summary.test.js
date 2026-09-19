'use strict';

// Card Amount sourcing: the payment section states per-tender amounts on
// clean orders and omits them exactly when the order was adjusted after
// checkout (refund/tip) — the case getOrderLedger covers with bank-final
// per-tender amounts. Both reducers are pure and must fail LOUD (null),
// never guess, on unrecognized shapes (e.g. a rotated persisted query).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSandbox } = require('./helpers/sandbox');

const sandbox = loadSandbox({});

const money = (v) => ({ displayValues: [v] });
const ledgerFixture = {
  paymentMethodsLedgers: [
    {
      paymentType: 'GIFTCARD',
      description: 'Walmart Cash',
      transactions: [
        {
          chargeType: 'FINAL_CHARGES',
          transactionLines: [{ date: 'Aug 16, 2026', rowLines: [{ lineType: 'ORDER_CHARGE', ...money('$1.75') }] }],
        },
      ],
    },
    {
      paymentType: 'CREDITCARD',
      description: 'Ending in 4752',
      transactions: [
        {
          chargeType: 'FINAL_CHARGES',
          transactionLines: [
            { date: 'Aug 18, 2026', rowLines: [{ lineType: 'ORDER_ADJUSTMENT_REFUND', ...money('-$8.29') }] },
            { date: 'Aug 16, 2026', rowLines: [{ lineType: 'ORDER_CHARGE', ...money('$22.42') }] },
            { date: 'Aug 16, 2026', rowLines: [{ lineType: 'ORDER_CHARGE', ...money('$20.58') }] },
            { date: 'Aug 16, 2026', rowLines: [{ lineType: 'ORDER_CHARGE', ...money('$151.80') }] },
          ],
        },
        {
          // Temporary holds must never count.
          chargeType: 'TEMPORARY_HOLDS',
          transactionLines: [{ date: 'Aug 16, 2026', rowLines: [{ lineType: 'HOLD', ...money('$213.83') }] }],
        },
      ],
    },
  ],
};

test('summarizeOrderLedger: final charges only, split by tender, refunds separate', () => {
  const s = sandbox.summarizeOrderLedger(ledgerFixture);
  // Real Aug 16 order: card 22.42+20.58+151.80 = 194.80 (the bank charge),
  // refund 8.29 arrives as its own credit, Walmart Cash 1.75.
  assert.equal(s.cardAmount, 194.8);
  assert.equal(s.cardRefunds, 8.29);
  assert.equal(s.nonCardTenderAmount, 1.75);
});

test('summarizeOrderLedger fails loud (null) on unrecognized shapes', () => {
  assert.equal(sandbox.summarizeOrderLedger(null), null);
  assert.equal(sandbox.summarizeOrderLedger({}), null);
  assert.equal(sandbox.summarizeOrderLedger({ errors: [{ message: 'PersistedQueryNotFound' }] }), null);
});

test('cardAmountFromPaymentDetails: stated amounts sum; absent means null', () => {
  assert.equal(
    sandbox.cardAmountFromPaymentDetails([
      { ending: 'Walmart Cash', amount: '$0.50' },
      { ending: 'Ending in 4752', amount: '$225.01' },
    ]),
    225.01
  );
  // Adjusted orders: tender named, amount omitted → null (ledger territory).
  assert.equal(
    sandbox.cardAmountFromPaymentDetails([
      { ending: 'Walmart Cash', amount: '' },
      { ending: 'Ending in 4752', amount: '' },
    ]),
    null
  );
  assert.equal(sandbox.cardAmountFromPaymentDetails([]), null);
  // Two cards both stated (rare) sum together.
  assert.equal(
    sandbox.cardAmountFromPaymentDetails([
      { ending: 'Ending in 1013', amount: '$10.00' },
      { ending: 'Ending in 3006', amount: '$5.50' },
    ]),
    15.5
  );
});
