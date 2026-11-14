'use strict';

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadSandbox, toPlain } from './helpers/sandbox';

function loadCategoryStatsSandbox() {
  return loadSandbox({
    scripts: ['utils.js', 'sidepanel.dashboard.js', 'dashboard.itemstats.js', 'dashboard.categorystats.js'],
  });
}

function invoiceRecord(orderNumber, isoDate, items, schemaVersion = 3) {
  return {
    orderNumber,
    orderDate: `${isoDate}T10:00:00.000Z`,
    summary: { orderDate: `${isoDate}T10:00:00.000Z` },
    invoice: { schemaVersion, items },
  };
}

test('classifyName normalizes names and ranks product evidence', () => {
  const { CategoryStats } = loadCategoryStatsSandbox();

  assert.equal(CategoryStats.classifyName('Great Value Whole Milk, 1 Gallon'), 'groceries');
  assert.equal(CategoryStats.classifyName('Tide PODS Laundry Detergent, 42 ct'), 'household');
  assert.equal(CategoryStats.classifyName('Baby Wipes, Fragrance-Free'), 'baby');
  assert.equal(CategoryStats.classifyName('Premium Dog Food with Chicken'), 'pets');
  assert.equal(CategoryStats.classifyName('Full Synthetic Motor Oil'), 'auto');
  assert.equal(CategoryStats.classifyName('USB-C Phone Charger'), 'electronics');
  assert.equal(CategoryStats.classifyName('Unclear Multipurpose Thing'), 'uncategorized');
});

test('classifyName uses word boundaries instead of loose substrings', () => {
  const { CategoryStats } = loadCategoryStatsSandbox();

  assert.equal(CategoryStats.classifyName('Eggs, Large, 12 ct'), 'groceries');
  // "eggshell" and "carrot costume" must not read as food.
  assert.notEqual(CategoryStats.classifyName('Legacy Eggshell Paint Sample'), 'groceries');
  assert.notEqual(CategoryStats.classifyName('Novelty Carrot Costume'), 'groceries');
});

test('buildCategorySummary reuses ItemStats measured data and reconciles positive item spend', () => {
  const { ItemStats, CategoryStats } = loadCategoryStatsSandbox();
  const records = [
    invoiceRecord('1001', '2026-01-10', [
      { productName: 'Whole Milk', usItemId: 'milk', quantity: '2', price: '$7.00' },
      { productName: 'Tide PODS Laundry Detergent', usItemId: 'tide', quantity: '1', price: '$12.00' },
      { productName: 'Mystery Item', usItemId: 'mystery', quantity: '1', price: '$5.00' },
      { productName: 'Unpriced Bread', usItemId: 'bread', quantity: '1', price: '' },
    ]),
    invoiceRecord('1002', '2026-02-10', [
      { productName: 'Whole Milk', usItemId: 'milk', quantity: '1', price: '$4.00' },
      { productName: 'Tide PODS Laundry Detergent', usItemId: 'tide', quantity: '1', price: '$13.00' },
    ]),
    invoiceRecord('1003', '2026-03-10', [
      { productName: 'Whole Milk', quantity: '1', price: '$99.00' },
    ], 2),
  ];

  const index = ItemStats.buildItemIndex(records);
  const result = toPlain(CategoryStats.buildCategorySummary(index));

  assert.equal(result.totalSpend, 41);
  assert.equal(result.categorizedSpend, 36);
  assert.equal(result.uncategorizedSpend, 5);
  assert.equal(result.coveragePercent, 87.8);
  assert.equal(result.itemCount, 3);
  assert.equal(result.orderCount, 2);

  const groceries = result.categories.find((category) => category.id === 'groceries');
  assert.deepEqual(
    { spent: groceries.totalSpent, items: groceries.itemCount, orders: groceries.orderCount },
    { spent: 11, items: 1, orders: 2 }
  );
  const household = result.categories.find((category) => category.id === 'household');
  assert.equal(household.totalSpent, 25);
  assert.equal(household.products[0].timesBought, 2);

  const reconciled = result.categories.reduce((sum, category) => sum + category.totalSpent, 0);
  assert.equal(reconciled, result.totalSpend);
});

test('buildCategorySummary counts each contributing order once per category', () => {
  const { ItemStats, CategoryStats } = loadCategoryStatsSandbox();
  const index = ItemStats.buildItemIndex([
    invoiceRecord('2001', '2026-04-01', [
      { productName: 'Milk', quantity: '1', price: '$4.00' },
      { productName: 'Eggs', quantity: '1', price: '$3.00' },
    ]),
    invoiceRecord('2002', '2026-04-02', [
      { productName: 'Bread', quantity: '1', price: '$2.00' },
    ]),
  ]);
  const result = toPlain(CategoryStats.buildCategorySummary(index));
  const groceries = result.categories.find((category) => category.id === 'groceries');

  assert.equal(groceries.itemCount, 3);
  assert.equal(groceries.orderCount, 2);
  assert.equal(result.orderCount, 2);
});

test('buildCategorySummary returns an honest zero state', () => {
  const { CategoryStats } = loadCategoryStatsSandbox();
  assert.deepEqual(toPlain(CategoryStats.buildCategorySummary([])), {
    totalSpend: 0,
    refundedTotal: 0,
    categorizedSpend: 0,
    uncategorizedSpend: 0,
    needsReviewSpend: 0,
    reviewItemCount: 0,
    manualItemCount: 0,
    coveragePercent: 0,
    itemCount: 0,
    orderCount: 0,
    categories: [],
  });
});

test('Walmart department outranks the name guess; a manual choice outranks both', () => {
  const { ItemStats, CategoryStats } = loadCategoryStatsSandbox();
  const records = [invoiceRecord('2001', '2026-04-10', [
    // The name alone says nothing; Walmart files it under Food.
    { productName: 'Mystery Item', usItemId: 'm1', quantity: '1', price: '$5.00', categoryPathId: '0:976759:976794' },
    // The name says groceries; Walmart files it under Pets.
    { productName: 'Whole Milk for Kittens', usItemId: 'm2', quantity: '1', price: '$4.00', categoryPathId: '0:5440:202072' },
    // A department that is not in the table falls back to the name.
    { productName: 'Tide PODS Laundry Detergent', usItemId: 'm3', quantity: '1', price: '$12.00', categoryPathId: '0:424242' },
    // No category path at all: the name decides, as before.
    { productName: 'Premium Dog Food with Chicken', usItemId: 'm4', quantity: '1', price: '$20.00' },
  ])];
  const index = ItemStats.buildItemIndex(records);
  const find = (summary, name) => summary.categories.flatMap((category) => category.products.map((product) => ({ ...product, categoryId: category.id }))).find((product) => product.name === name);

  const summary = CategoryStats.buildCategorySummary(index);
  assert.equal(find(summary, 'Mystery Item').categoryId, 'groceries');
  assert.equal(find(summary, 'Mystery Item').source, 'walmart');
  assert.equal(find(summary, 'Whole Milk for Kittens').categoryId, 'pets');
  assert.equal(find(summary, 'Tide PODS Laundry Detergent').categoryId, 'household');
  assert.equal(find(summary, 'Tide PODS Laundry Detergent').source, 'name');
  assert.equal(find(summary, 'Premium Dog Food with Chicken').categoryId, 'pets');
  assert.equal(summary.totalSpend, 41);

  const manual = CategoryStats.buildCategorySummary(index, { 'name:mystery item': 'household' });
  assert.equal(find(manual, 'Mystery Item').categoryId, 'household');
  assert.equal(find(manual, 'Mystery Item').source, 'manual');

  assert.equal(CategoryStats.departmentCategory('976759:1'), 'groceries');
  for (const value of ['', null, undefined, '0', 'abc', {}]) assert.equal(CategoryStats.departmentCategory(value), null);
});

test('a returned line is shown as refunded and left out of category spend', () => {
  const { ItemStats, CategoryStats } = loadCategoryStatsSandbox();
  const index = ItemStats.buildItemIndex([invoiceRecord('3001', '2026-05-10', [
    { productName: 'Whole Milk', usItemId: 'milk', quantity: '1', price: '$4.00' },
    { productName: 'Toaster', usItemId: 'toaster', quantity: '1', price: '$20.00', fulfillment: 'Returned' },
  ])]);
  const summary = CategoryStats.buildCategorySummary(index);
  assert.equal(summary.totalSpend, 4);
  assert.equal(summary.refundedTotal, 20);
  const refunded = summary.categories.find((category) => category.id === 'refunded');
  assert.deepEqual(toPlain(refunded.products.map((product) => product.name)), ['Toaster']);
});
