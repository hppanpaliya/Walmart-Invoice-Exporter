/**
 * Item-level budget breakdown and product categorization controls.
 * Assignments are saved locally, scoped to the selected Walmart site/account,
 * and follow the product name across every invoice in that scope.
 */
(() => {
  'use strict';
  if (typeof WIEDash === 'undefined' || typeof ItemStats === 'undefined' || typeof CategoryStats === 'undefined') return;

  const STORAGE_KEY = 'wieCategoryAssignmentsV1';
  const state = { loadedFor: null, assignmentsByScope: {}, loading: false, lastCtx: null, saving: false, query: '' };
  const $ = (root, selector) => root.querySelector(selector);
  const plural = (count, singular, pluralValue) => `${count} ${count === 1 ? singular : (pluralValue || `${singular}s`)}`;

  function scopeKey(ctx) {
    const provider = String((ctx.state && ctx.state.provider) || 'default');
    const account = String((ctx.state && ctx.state.account) || 'all-accounts');
    return `${provider}::${account}`;
  }

  function loadAssignments(ctx, scope) {
    if (state.loadedFor === scope || state.loading) return;
    state.loading = true;
    ctx.storageGet([STORAGE_KEY]).then((stored) => {
      state.assignmentsByScope = (stored && stored[STORAGE_KEY] && typeof stored[STORAGE_KEY] === 'object')
        ? stored[STORAGE_KEY] : {};
      state.loadedFor = scope;
      state.loading = false;
      if (state.lastCtx) render(state.lastCtx);
    }).catch(() => {
      state.assignmentsByScope = {};
      state.loadedFor = scope;
      state.loading = false;
      if (state.lastCtx) render(state.lastCtx);
    });
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes || !changes[STORAGE_KEY]) return;
      state.assignmentsByScope = changes[STORAGE_KEY].newValue || {};
      if (!state.saving && state.lastCtx) render(state.lastCtx);
    });
  }

  function assignmentSelect(ctx, product, currentId) {
    const esc = ctx.escapeHtml;
    const options = [
      `<option value="automatic"${product.manual ? '' : ' selected'}>Suggested: ${esc(CategoryStats.CATEGORIES.find((item) => item.id === product.suggestedCategoryId)?.label || 'Needs a category')}</option>`,
      ...CategoryStats.CATEGORIES.map((category) => `<option value="${esc(category.id)}"${product.manual && currentId === category.id ? ' selected' : ''}>${esc(category.label)}</option>`),
    ];
    return `<label class="cat-select-wrap"><span class="sr-only">Category for ${esc(product.name)}</span><select class="cat-select" data-category-key="${esc(product.key)}" data-category-name="${esc(product.nameKey)}" aria-label="Category for ${esc(product.name)}">${options.join('')}</select></label>`;
  }

  function productTable(ctx, products, assignments, readOnly = false) {
    const esc = ctx.escapeHtml;
    if (!products.length) return '<div class="cat-empty-products">No products in this category for the selected period.</div>';
    const rows = products.map((product) => `<tr>
      <td class="cat-product-name"><span>${esc(product.name || 'Unnamed product')}</span>${product.manual ? '<small class="cat-you-set">You set this</small>' : ''}</td>
      <td class="cat-product-orders">${esc(plural(product.timesBought, 'purchase'))}</td>
      <td class="cat-product-qty">${esc(plural(product.totalQty, 'item'))}</td>
      <td class="cat-product-spend mono">${esc(ctx.formatMoney(product.totalSpent))}</td>
      <td>${readOnly ? '<span class="cat-refund-label">Refunded</span>' : assignmentSelect(ctx, product, assignments[product.key] || '')}</td>
    </tr>`).join('');
    return `<div class="cat-product-scroll"><table class="cat-products"><thead><tr><th>Product</th><th>${readOnly ? 'Refunds' : 'Purchases'}</th><th>Qty</th><th class="num">${readOnly ? 'Returned' : 'Spent'}</th><th>${readOnly ? 'Status' : 'Category'}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function categoryCard(ctx, category, assignments, open = false) {
    const esc = ctx.escapeHtml;
    const products = category.products.filter((product) => !state.query || product.name.toLowerCase().includes(state.query));
    const isRefunded = category.id === 'refunded';
    const share = isRefunded ? 'excluded from item spend' : `${category.percent}% of item spend`;
    const flag = category.id === 'uncategorized' ? ' cat-review' : '';
    const title = category.id === 'uncategorized' ? 'Needs a category' : category.label;
    return `<details class="cat-category${flag}"${open ? ' open' : ''}>
      <summary class="cat-category-head">
        <span class="cat-dot" style="--cat-color:${esc(category.color)}" aria-hidden="true"></span>
        <span class="cat-category-title">${esc(title)}<small>${esc(plural(category.itemCount, 'product'))} · ${esc(plural(category.orderCount, 'order'))}</small></span>
        <span class="cat-category-meter" aria-hidden="true"><span style="--cat-color:${esc(category.color)};width:${category.percent}%"></span></span>
        <span class="cat-category-share">${esc(share)}</span>
        <strong class="cat-category-total mono">${esc(ctx.formatMoney(category.totalSpent))}</strong>
        <span class="cat-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div class="cat-category-body">
        ${isRefunded ? `<p class="cat-review-hint cat-refund-hint">These returned items are shown for reference and excluded from the item-spending total and category percentages.</p>` : ''}
        ${category.id === 'uncategorized' ? `<p class="cat-review-hint">Choose a category beside each product. Your choice applies to this product across its purchase history and is saved on this device.</p>` : ''}
        ${productTable(ctx, products, assignments, isRefunded)}
      </div>
    </details>`;
  }

  function bindControls(root, ctx, scope) {
    const search = $(root, '[data-cat-search]');
    if (search) {
      search.value = state.query;
      search.addEventListener('input', () => {
        state.query = search.value.trim().toLowerCase();
        render(ctx);
        const nextSearch = $(root, '[data-cat-search]');
        nextSearch?.focus();
        if (nextSearch) nextSearch.setSelectionRange(nextSearch.value.length, nextSearch.value.length);
      });
    }
    root.querySelectorAll('[data-category-key]').forEach((select) => {
      select.addEventListener('change', async () => {
        const key = select.getAttribute('data-category-key');
        const nameKey = select.getAttribute('data-category-name');
        const value = select.value;
        state.saving = true;
        const current = state.assignmentsByScope;
        const latest = await ctx.storageGet([STORAGE_KEY]);
        const allScopes = (latest && latest[STORAGE_KEY] && typeof latest[STORAGE_KEY] === 'object')
          ? latest[STORAGE_KEY] : current;
        const nextScope = { ...(allScopes[scope] || {}) };
        if (value === 'automatic') {
          delete nextScope[key];
          delete nextScope[nameKey];
        } else {
          nextScope[key] = value;
          nextScope[nameKey] = value;
        }
        const nextAll = { ...allScopes };
        if (Object.keys(nextScope).length) nextAll[scope] = nextScope;
        else delete nextAll[scope];
        state.assignmentsByScope = nextAll;
        await ctx.storageSet({ [STORAGE_KEY]: nextAll });
        state.saving = false;
        render(ctx);
      });
    });
  }

  function render(ctx) {
    const root = document.getElementById('viewCategories');
    if (!root) return;
    state.lastCtx = ctx;
    if (ctx.combined) {
      root.innerHTML = `<section class="cat-empty"><span class="cat-empty-icon">◷</span><h2>Choose one Walmart site</h2><p>Category budgets use the site's own currency. Select a single site in the dashboard header to see its item spending.</p></section>`;
      return;
    }
    if (!ctx.model) {
      root.innerHTML = `<section class="cat-empty"><span class="cat-empty-icon">▤</span><h2>Your item budget starts with a full invoice</h2><p>Fetch item details from the Orders view. Once saved, each product purchase will contribute to the category breakdown here.</p></section>`;
      return;
    }
    const scope = scopeKey(ctx);
    if (state.loadedFor !== scope) {
      loadAssignments(ctx, scope);
      root.innerHTML = `<section class="cat-loading"><span class="cat-spinner" aria-hidden="true"></span><span>Loading your category choices…</span></section>`;
      return;
    }

    const assignments = state.assignmentsByScope[scope] || {};
    const itemIndex = ItemStats.buildItemIndex(ctx.scopedRecords);
    const summary = CategoryStats.buildCategorySummary(itemIndex, assignments);
    const esc = ctx.escapeHtml;
    const range = ctx.scopeEchoLabel(ctx.now);
    if (!(summary.totalSpend > 0) && !(summary.refundedTotal > 0)) {
      root.innerHTML = `<section class="cat-empty"><span class="cat-empty-icon">◌</span><h2>No item purchases in this view yet</h2><p>Try another date range, or fetch detailed invoices for orders in ${esc(range)}.</p></section>`;
      return;
    }

    const segments = summary.categories.filter((category) => category.id !== 'refunded' && category.totalSpent > 0).map((category) =>
      `<span title="${esc(category.label)} · ${category.percent}%" style="--cat-color:${esc(category.color)};width:${category.percent}%"></span>`
    ).join('');
    const reviewCategory = summary.categories.find((category) => category.id === 'uncategorized');
    const categories = summary.categories;
    const q = state.query;

    root.innerHTML = `<div class="cat-page">
      <section class="cat-intro">
        <div><span class="cat-kicker">YOUR SPENDING, SORTED</span><h1>Category budget</h1><p>See where your Walmart basket goes. Each order is split by product, so mixed carts still make sense.</p></div>
        <div class="cat-period"><span class="cat-period-dot"></span><span>${esc(range)}</span></div>
      </section>

      <section class="cat-budget-card">
        <div class="cat-budget-top">
          <div><span class="cat-eyebrow">ITEM SPEND · REFUNDS EXCLUDED</span><div class="cat-total mono">${esc(ctx.formatMoney(summary.totalSpend))}</div><div class="cat-total-caption">${esc(plural(summary.itemCount, 'product'))} across ${esc(plural(summary.orderCount, 'order'))}</div>${summary.refundedTotal > 0 ? `<div class="cat-refund-total">${esc(ctx.formatMoney(summary.refundedTotal))} refunded · excluded from spend</div>` : ''}</div>
          <div class="cat-review-stat"><span class="cat-review-icon">✳</span><div><strong>${summary.reviewItemCount ? esc(plural(summary.reviewItemCount, 'product')) : 'All sorted'}</strong><small>${summary.reviewItemCount ? `${esc(ctx.formatMoney(summary.needsReviewSpend))} still needs a category` : 'Every product has a category'}</small></div></div>
        </div>
        <div class="cat-allocation" role="img" aria-label="Item spending allocation by category">${segments}</div>
        <div class="cat-budget-legend"><span><i class="cat-legend-dot" style="--cat-color:#6884a6"></i>${summary.reviewItemCount ? `${esc(plural(summary.reviewItemCount, 'product'))} to review` : 'Categories assigned'}</span><span>Amounts are item totals before tax and fees; refunded items are excluded</span></div>
      </section>

      <section class="cat-section-head"><div><span class="cat-kicker">THE BREAKDOWN</span><h2>Where it went</h2></div><label class="cat-search"><span aria-hidden="true">⌕</span><input data-cat-search type="search" placeholder="Find a product" aria-label="Find a product" value="${esc(q)}"></label></section>
      ${reviewCategory ? `<section class="cat-review-callout"><div class="cat-review-mark">✳</div><div><strong>${esc(plural(reviewCategory.itemCount, 'product'))} waiting for you</strong><p>These names do not give a clear category yet. Your choices will carry across past and future purchases of the same product.</p></div><button type="button" class="cat-review-button" data-review-open>Review products <span aria-hidden="true">→</span></button></section>` : `<section class="cat-complete-note"><span>✓</span> Your products are categorized. You can still change any suggestion in a product's category menu.</section>`}
      <section class="cat-category-grid" aria-label="Category spending breakdown">
        ${categories.map((category) => categoryCard(ctx, category, assignments, category.id === 'uncategorized')).join('')}
      </section>
      <p class="cat-footnote">A product's category comes from Walmart's own department when the saved invoice has it, and from the item description otherwise. You can change any of them. Your edits are stored on this device for the selected site and account. Refunded items are separated when Walmart marks them as returned; re-fetch older invoices to capture that status.</p>
    </div>`;

    const reviewButton = $(root, '[data-review-open]');
    if (reviewButton) reviewButton.addEventListener('click', () => {
      const review = $(root, '.cat-review');
      if (review) {
        review.open = true;
        review.scrollIntoView({ behavior: 'smooth', block: 'start' });
        review.querySelector('[data-category-key]')?.focus();
      }
    });
    bindControls(root, ctx, scope);
  }

  WIEDash.registerView('categories', { render });
})();
