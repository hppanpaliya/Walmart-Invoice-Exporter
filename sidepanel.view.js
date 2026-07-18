(() => {
  const Sidepanel = window.Sidepanel || (window.Sidepanel = {});
  const state = Sidepanel.state;

  const UI_MODES = {
    MAIN_ORDERS: "mainOrders",
    SINGLE_ORDER: "singleOrder",
    OFF_TAB: "offTab",
  };

  const UI_STATE = state.ui || { mode: UI_MODES.MAIN_ORDERS };
  UI_STATE.mode = UI_STATE.mode || UI_MODES.MAIN_ORDERS;
  UI_STATE.layouts = {
    [UI_MODES.SINGLE_ORDER]: {
      display: {
        buttonGroup: "none",
        progress: "none",
      },
      // The collect card's only remaining content (collectionOptionsGroup +
      // buttonGroup) is hidden either way in this mode, so hide the whole
      // card rather than leave an empty rounded box on screen.
      cardDisplay: "none",
      checkboxContainerDisplay: "none",
    },
    [UI_MODES.MAIN_ORDERS]: {
      display: {
        buttonGroup: "flex",
      },
      cardDisplay: "block",
      checkboxContainerDisplay: "",
    },
    [UI_MODES.OFF_TAB]: {},
  };

  state.ui = UI_STATE;

  function setInitialPlaceholder(container) {
    if (!container) return;
    if (!state.placeholders.initialOrderHtml) {
      state.placeholders.initialOrderHtml = container.innerHTML;
    }
  }

  /**
   * Switch between the panel's top-level views. (The spending dashboard is
   * no longer a panel view — it lives in its own full page, dashboard.html.)
   * Unknown names fall back to the main view (matching the old behavior).
   * @param {string} viewName - "main", "faq", or "settings"
   * @param {Function} [onMain] - Invoked after switching to the main view
   */
  function switchView(viewName, onMain) {
    const views = {
      main: document.getElementById("mainView"),
      faq: document.getElementById("faqView"),
      settings: document.getElementById("settingsView"),
    };
    const target = views[viewName] ? viewName : "main";

    Object.entries(views).forEach(([name, element]) => {
      if (!element) return;
      element.classList.toggle("active", name === target);
    });

    if (target === "main" && onMain) onMain();
  }

  function showConfirmDialog(message) {
    const confirmDialog = document.getElementById("confirmDialog");
    const confirmDialogMessage = document.getElementById("confirmDialogMessage");
    if (!confirmDialog || !confirmDialogMessage) return;
    confirmDialogMessage.textContent = message;
    confirmDialog.classList.add("active");
  }

  function hideConfirmDialog() {
    const confirmDialog = document.getElementById("confirmDialog");
    if (!confirmDialog) return;
    confirmDialog.classList.remove("active");
  }

  function applyLayout(mode) {
    const layout = UI_STATE.layouts[mode];
    if (!layout) return;
    UI_STATE.mode = mode;

    if (layout.display) {
      Object.entries(layout.display).forEach(([id, value]) => {
        setElementsDisplay([id], value);
      });
    }

    if (layout.cardDisplay !== undefined) {
      const card = document.querySelector(".card");
      if (card) card.style.display = layout.cardDisplay;
    }

    if (layout.checkboxContainerDisplay !== undefined) {
      const checkboxContainer = document.getElementsByClassName("checkbox-container")[0];
      if (checkboxContainer) checkboxContainer.style.display = layout.checkboxContainerDisplay;
    }
  }

  /**
   * The consolidated status strip (spec §5.1): off-tab / filter /
   * extraction warnings and the cache/db-stats/rating-hint notices all
   * render into this one region (between the header and the card) instead
   * of five different ad-hoc insertion points (body-first-child, inside
   * .card before buttonGroup, appended to .card).
   * @returns {HTMLElement|null}
   */
  function getStatusRegion() {
    return document.getElementById("statusRegion");
  }

  /**
   * Create-or-replace a named Banner (spec §5.5) inside the status region,
   * keyed by a stable id — mirrors how each notice already tracked its own
   * single instance via document.getElementById before this refactor.
   * Best-effort: a missing region must never break the panel.
   * @param {string} id
   * @param {Object} bannerOptions - passed through to Sidepanel.components.Banner
   * @returns {HTMLElement|null} the rendered banner, or null if the status
   *   region isn't present.
   */
  function renderStatusBanner(id, bannerOptions) {
    const region = getStatusRegion();
    if (!region) return null;
    const banner = Sidepanel.components.Banner({ ...bannerOptions, id });
    const existing = document.getElementById(id);
    if (existing) {
      existing.replaceWith(banner);
    } else {
      region.appendChild(banner);
    }
    return banner;
  }

  /** Remove a named status banner if present (no-op otherwise). */
  function clearStatusBanner(id) {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
  }

  /**
   * A pure factory (no insertion) for the off-tab warning banner — kept
   * separate from ensureOffTabWarning so callers can still build one
   * without touching the DOM, matching this function's original contract.
   * @param {Function} onReturn - Invoked when the "Walmart Orders" link is clicked.
   * @returns {HTMLElement}
   */
  function createOffTabWarning(onReturn) {
    const banner = Sidepanel.components.Banner({
      variant: "warning",
      message: `Return to <a href="#" id="returnToWalmartLink">Walmart Orders</a> to continue`,
      id: "offTabWarning",
    });

    const returnLink = banner.querySelector("#returnToWalmartLink");
    if (returnLink) {
      returnLink.addEventListener("click", (e) => {
        e.preventDefault();
        if (onReturn) onReturn();
      });
    }

    return banner;
  }

  function ensureOffTabWarning(onReturn) {
    if (document.getElementById("offTabWarning")) return;
    const region = getStatusRegion();
    if (!region) return;
    region.appendChild(createOffTabWarning(onReturn));
  }

  function clearOffTabWarning() {
    clearStatusBanner("offTabWarning");
  }

  function showExtractionWarning() {
    if (document.getElementById("extractionWarning")) return;

    renderStatusBanner("extractionWarning", {
      variant: "warning",
      message: `Walmart may have changed their website — some exported fields came back empty. Please <a href="${CONSTANTS.URLS.GITHUB_ISSUES}" target="_blank">report this</a> so we can fix it quickly.`,
      dismissible: true,
    });
  }

  /**
   * Show (or clear) a notice describing the Walmart filters active on the
   * orders page. Collection paginates the user's filtered view as-is, so the
   * notice tells them only matching orders will be collected.
   * @param {string|null} url - Current orders-page URL, or null to clear
   */
  function updateFilterNotice(url) {
    const filters = url ? describeActiveFilters(url) : [];

    if (filters.length === 0) {
      clearStatusBanner("filterNotice");
      return;
    }

    renderStatusBanner("filterNotice", {
      variant: "info",
      message: `Filtered view — only matching orders will be collected (${escapeHtml(filters.join(", "))})`,
    });
  }

  /**
   * Drive the panel's two macro states (spec v7.1 §A): first-run (no
   * orders anywhere — hero card, everything else hidden) vs. returning
   * (normal collect button, list + download sections visible). Toggling a
   * single body class lets sidepanel.css hide/show every affected section
   * in one place instead of touching each element from JS. Also stamps
   * state.app.hasOrders so setCollectionButtonsState (utils.js) can pick
   * the right default "Collect orders" button label without its own DOM
   * traversal.
   * @param {boolean} hasOrders - OrderDb has ≥1 order, or a collection is
   *   in progress/has results this session.
   */
  function updateMacroState(hasOrders) {
    const has = Boolean(hasOrders);
    document.body.classList.toggle("first-run", !has);
    if (state.app) state.app.hasOrders = has;
    // Keep the collect button's label in sync with the macro state — the
    // label logic lives in setCollectionButtonsState, but not every path
    // that flips hasOrders goes through it (e.g. panel init from the DB).
    if (!state.app || !state.app.collectionInProgress) {
      setCollectionButtonsState({ running: false });
    }
  }

  function setUIEnabled(enabled) {
    const card = document.querySelector(".card");
    if (card) {
      card.style.opacity = enabled ? "1" : "0.6";
      card.classList.toggle("disabled-card", !enabled);
    }

    if (enabled) {
      // Don't force these on — defer to the current selection/running
      // state (spec §5.2: 0 selected or a run in progress must stay
      // disabled even when the tab itself is usable again).
      updateDownloadButtonsState();
    } else {
      ["singleFileDownload", "multiFileDownload"].forEach((buttonId) => {
        const button = document.getElementById(buttonId);
        if (button) {
          button.disabled = true;
          button.style.opacity = "0.6";
          button.style.cursor = "not-allowed";
        }
      });
    }

    setCheckboxesDisabled(!enabled);
  }

  /**
   * Enable/disable the Single file / Multiple files buttons together, and
   * show/hide the "select at least one order" inline reason (spec §5.2
   * button states: 0 selected, or a download already running, both
   * disable the pair — the hint only explains the selection case, since
   * the progress area already explains the running case).
   */
  function updateDownloadButtonsState() {
    const singleButton = document.getElementById("singleFileDownload");
    const multiButton = document.getElementById("multiFileDownload");
    const hint = document.getElementById("downloadDisabledReason");
    if (!singleButton && !multiButton) return;

    const running = Boolean(state.app && state.app.downloadInProgress);
    const selectedCount = getSelectedOrderNumbers().length;
    const disabled = running || selectedCount === 0;

    [singleButton, multiButton].forEach((button) => {
      if (!button) return;
      button.disabled = disabled;
      button.style.opacity = disabled ? "0.6" : "1";
      button.style.cursor = disabled ? "not-allowed" : "pointer";
    });

    if (hint) {
      hint.hidden = running || selectedCount > 0;
    }
  }

  /**
   * @param {number} currentPage
   * @param {number} pageLimit
   * @param {boolean} inProgress
   * @param {number} [orderCount=0] - orderNumbers.length from the GET_PROGRESS
   *   response — surfaced live in the loading text (spec v7.1 §A "Loading
   *   state").
   */
  function updateProgressUI(currentPage, pageLimit, inProgress, orderCount = 0) {
    const progressElement = document.getElementById("progress") || createProgressElement();
    progressElement.style.display = "block";

    const placeholder = document.getElementById("collectionPlaceholder");
    if (placeholder && inProgress) {
      placeholder.style.display = "none";
    }

    if (inProgress) {
      const count = Number(orderCount) || 0;
      progressElement.innerHTML = `
        <span class="loading-spinner" style="border-color: var(--primary); border-top-color: transparent;"></span>
        Loading page ${currentPage}… · ${count} order${count === 1 ? "" : "s"} found
      `;
    } else {
      progressElement.textContent = `Collection ${pageLimit > 0 && currentPage >= pageLimit ? "reached limit" : "completed"}. Total pages: ${currentPage}`;
    }
  }

  function createProgressElement() {
    const progressElement = document.createElement("div");
    progressElement.id = "progress";
    document.body.insertBefore(progressElement, document.getElementById("orderNumbersContainer"));
    return progressElement;
  }

  /** File-extension suffix shown in each download button's label (spec §5.2: "the format is never hidden"). */
  const FORMAT_LABEL_SUFFIX = {
    [CONSTANTS.EXPORT_FORMATS.XLSX]: ".xlsx",
    [CONSTANTS.EXPORT_FORMATS.CSV]: ".csv",
    [CONSTANTS.EXPORT_FORMATS.JSON]: ".json",
    [CONSTANTS.EXPORT_FORMATS.RECEIPT]: ".html",
    [CONSTANTS.EXPORT_FORMATS.PDF]: ".pdf",
  };

  /**
   * Refresh both download buttons' labels to echo the currently-selected
   * export format, e.g. "Single file (.xlsx)" / "Multiple files (.xlsx)".
   * Called on every button (re)creation and whenever the format <select>
   * changes (sidepanel.js), so the two are never out of sync.
   */
  function updateDownloadButtonLabels() {
    const format = (state.app && state.app.exportFormat) || CONSTANTS.EXPORT_FORMATS.XLSX;
    const suffix = FORMAT_LABEL_SUFFIX[format] || "";
    const singleLabel = document.querySelector("#singleFileDownload .btn-text");
    const multiLabel = document.querySelector("#multiFileDownload .btn-text");
    if (singleLabel) singleLabel.textContent = `Single file (${suffix})`;
    if (multiLabel) multiLabel.textContent = `Multiple files (${suffix})`;
  }

  /**
   * Build (once) and return the persistent download-progress area's parts —
   * a StatusLine + ProgressBar + Cancel button (spec §5.2 "Running" state).
   * The area lives outside #orderNumbersContainer (sidepanel.html) so it
   * survives an order-list re-render mid-download; the handle is memoized
   * so repeated calls reuse the same DOM nodes instead of duplicating them.
   */
  let downloadProgressHandle = null;
  function ensureDownloadProgressArea() {
    const area = document.getElementById("downloadProgressArea");
    if (!area) return null;
    if (downloadProgressHandle && downloadProgressHandle.area === area) return downloadProgressHandle;

    area.innerHTML = "";
    const statusLine = Sidepanel.components.StatusLine("");
    const progressBar = Sidepanel.components.ProgressBar(0, 0);
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.id = "downloadCancelButton";
    cancelButton.className = "btn btn-clear download-cancel";
    cancelButton.textContent = "Cancel";

    area.appendChild(statusLine);
    area.appendChild(progressBar);
    area.appendChild(cancelButton);

    downloadProgressHandle = { area, statusLine, progressBar, cancelButton };
    return downloadProgressHandle;
  }

  /**
   * Show the download-progress area and (re)wire Cancel to the given
   * callback — the existing app.downloadInProgress=false cancel path that
   * runDownloadQueue (sidepanel.download.js) already polls for.
   * @param {number} current
   * @param {number} total
   * @param {Object} [options]
   * @param {Function} [options.onCancel]
   * @returns {{area:HTMLElement,statusLine:HTMLElement,progressBar:HTMLElement,cancelButton:HTMLElement}|null}
   */
  function showDownloadProgress(current, total, { onCancel } = {}) {
    const handle = ensureDownloadProgressArea();
    if (!handle) return null;

    handle.area.hidden = false;
    handle.statusLine.hidden = false;
    handle.progressBar.update(current, total);
    handle.cancelButton.disabled = false;
    handle.cancelButton.textContent = "Cancel";
    handle.cancelButton.onclick = () => {
      if (onCancel) onCancel();
      handle.cancelButton.disabled = true;
      handle.cancelButton.textContent = "Cancelling…";
    };
    return handle;
  }

  /** Update the running download's status text + progress percentage. */
  function updateDownloadProgress(current, total, text) {
    if (!downloadProgressHandle) return;
    downloadProgressHandle.statusLine.textContent = text;
    downloadProgressHandle.progressBar.update(current, total);
  }

  /** Hide the download-progress area at the end of a run (success, failure, or cancel). */
  function hideDownloadProgress() {
    if (!downloadProgressHandle) return;
    downloadProgressHandle.area.hidden = true;
  }

  /**
   * In-memory view state for the receipt-style order list (spec v7.1 §B/§D)
   * — NOT persisted (default all-time on every fresh panel open). `rows`
   * holds every row model built by the last displayOrderNumbers() call;
   * changing the "Showing" filter or custom-range dates re-renders from
   * this cached array without hitting OrderDb again. `openRowEl`/
   * `openDetailEl` track the single expanded accordion row (spec §C: one
   * row open at a time) across re-renders.
   */
  const listState = {
    rows: [],
    container: null,
    filter: "all",
    customFrom: "",
    customTo: "",
    openRowEl: null,
    openDetailEl: null,
    // Order numbers the NEXT list render should select exactly (replacing
    // any existing selection), then clear. Set by applyListFilter — the
    // dashboard's "Select & download the missing N" path (v7.2).
    pendingSelection: null,
  };

  /** Filename suffix for the active "Showing" range (spec §D) — read by sidepanel.download.js's single-file export path. */
  function getActiveRangeLabelSuffix() {
    return getRangeLabelSuffix(listState.filter, new Date());
  }

  /** Mirrors OrderDataFetcher.buildOrderUrls' primary URL (sidepanel.download.js) for the row detail's "View on Walmart" action — duplicated per spec v7.1 §C rather than exporting a whole module for one URL string. */
  function buildOrderViewUrl(orderNumber) {
    const baseUrl = `${CONSTANTS.URLS.WALMART_ORDERS}/${orderNumber}`;
    return orderNumber.length >= 20 ? `${baseUrl}?storePurchase=true` : baseUrl;
  }

  /** Build the "Name ×qty [price]" lines + "+ N more" for an expanded row's item list (spec §C). Values are page-derived — always escaped. */
  function itemLinesHtml(items, withPrice) {
    const list = Array.isArray(items) ? items : [];
    const shown = list.slice(0, 3);
    const more = list.length - shown.length;
    let html = shown
      .map((item) => {
        const name = escapeHtml(item.name || "");
        const qty = item.quantity !== "" && item.quantity !== undefined && item.quantity !== null ? ` ×${escapeHtml(String(item.quantity))}` : "";
        const price = withPrice && item.price ? `<span class="mono">${escapeHtml(String(item.price))}</span>` : "";
        return `<div class="order-detail-item"><span class="order-detail-item-name">${name}${qty}</span>${price}</div>`;
      })
      .join("");
    if (more > 0) {
      html += `<div class="order-detail-more">+ ${more} more item${more === 1 ? "" : "s"}</div>`;
    }
    return html;
  }

  /** Build ledger rows, skipping any pair whose value is empty — never fabricates a "$0.00" for an unknown amount (spec §C). */
  function ledgerRowsHtml(pairs) {
    return pairs
      .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
      .map(([label, value]) => `<div class="order-ledger-row"><span>${escapeHtml(label)}</span><span class="mono">${escapeHtml(String(value))}</span></div>`)
      .join("");
  }

  function buildOrderNumberRow(orderNumber) {
    const row = document.createElement("div");
    row.className = "order-detail-number";
    const numberSpan = document.createElement("span");
    numberSpan.className = "mono";
    numberSpan.textContent = `#${orderNumber}`;
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "btn-link order-action-copy";
    copyButton.textContent = "Copy";
    copyButton.dataset.order = orderNumber;
    row.appendChild(numberSpan);
    row.appendChild(copyButton);
    return row;
  }

  /** Wire the copy/re-export/download/view-on-Walmart actions inside one expanded row's detail. */
  function wireDetailActions(detail) {
    const copyButton = detail.querySelector(".order-action-copy");
    if (copyButton) {
      copyButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(copyButton.dataset.order);
          Sidepanel.components.Toast("Copied");
        } catch (error) {
          console.error("Failed to copy order number:", error);
        }
      });
    }

    const exportButton = detail.querySelector(".order-action-reexport, .order-action-download");
    if (exportButton) {
      exportButton.addEventListener("click", (event) => {
        event.stopPropagation();
        // null mode = keep the user's current mode; never changes the
        // persisted exportMode (spec §C).
        Sidepanel.download.downloadSelectedOrders(null, [exportButton.dataset.order]);
      });
    }

    const viewButton = detail.querySelector(".order-action-view");
    if (viewButton) {
      viewButton.addEventListener("click", (event) => {
        event.stopPropagation();
        chrome.tabs.create({ url: buildOrderViewUrl(viewButton.dataset.order) });
      });
    }
  }

  /** Build one row's expanded accordion detail (spec §C): hasInvoice vs. summary-only content. */
  function buildOrderDetailElement(row) {
    const detail = document.createElement("div");
    detail.className = "order-row-detail";
    const orderNumber = escapeHtml(row.orderNumber);

    if (row.hasInvoice) {
      const items = Array.isArray(row.invoice.items) ? row.invoice.items : [];
      const itemsBox = document.createElement("div");
      itemsBox.className = "order-detail-items";
      itemsBox.innerHTML = itemLinesHtml(
        items.map((item) => ({ name: item?.productName, quantity: item?.quantity, price: item?.price })),
        true
      );
      detail.appendChild(itemsBox);

      const ledgerBox = document.createElement("div");
      ledgerBox.className = "order-detail-ledger";
      ledgerBox.innerHTML = ledgerRowsHtml([
        ["Subtotal", row.invoice.orderSubtotal],
        ["Tax", row.invoice.tax],
        ["Tip", row.invoice.tip],
        ["Total", row.invoice.orderTotal],
      ]);
      detail.appendChild(ledgerBox);
      detail.appendChild(buildOrderNumberRow(row.orderNumber));

      const actions = document.createElement("div");
      actions.className = "order-detail-actions";
      actions.innerHTML = `
        <button type="button" class="btn btn-clear order-action-reexport" data-order="${orderNumber}">Re-export</button>
        <button type="button" class="btn btn-clear order-action-view" data-order="${orderNumber}">View on Walmart</button>
      `;
      detail.appendChild(actions);
    } else {
      const itemsBox = document.createElement("div");
      itemsBox.className = "order-detail-items";
      itemsBox.innerHTML = itemLinesHtml(row.summaryItems, false);
      detail.appendChild(itemsBox);

      const summary = row.summary || {};
      const ledgerBox = document.createElement("div");
      ledgerBox.className = "order-detail-ledger";
      ledgerBox.innerHTML = ledgerRowsHtml([
        ["Subtotal", summary.subTotal],
        ["Tip", summary.driverTip],
        ["Total", summary.orderTotal],
      ]);
      detail.appendChild(ledgerBox);

      const hint = document.createElement("p");
      hint.className = "order-detail-hint";
      hint.textContent = "Download this order to get per-item prices, tax, and the full receipt.";
      detail.appendChild(hint);
      detail.appendChild(buildOrderNumberRow(row.orderNumber));

      const actions = document.createElement("div");
      actions.className = "order-detail-actions";
      actions.innerHTML = `
        <button type="button" class="btn btn-clear order-action-download" data-order="${orderNumber}">Download this order</button>
        <button type="button" class="btn btn-clear order-action-view" data-order="${orderNumber}">View on Walmart</button>
      `;
      detail.appendChild(actions);
    }

    wireDetailActions(detail);
    return detail;
  }

  /** Open `rowEl`/`detail`'s accordion, closing whichever other row was open (spec §C: one row open at a time). Honors prefers-reduced-motion via CSS alone (no JS timing here). */
  function toggleRowExpansion(rowEl, detail) {
    const isOpen = !detail.hidden;

    if (listState.openRowEl && listState.openRowEl !== rowEl) {
      listState.openRowEl.setAttribute("aria-expanded", "false");
      listState.openRowEl.classList.remove("expanded");
      if (listState.openDetailEl) listState.openDetailEl.hidden = true;
    }

    if (isOpen) {
      detail.hidden = true;
      rowEl.setAttribute("aria-expanded", "false");
      rowEl.classList.remove("expanded");
      listState.openRowEl = null;
      listState.openDetailEl = null;
    } else {
      detail.hidden = false;
      rowEl.setAttribute("aria-expanded", "true");
      rowEl.classList.add("expanded");
      listState.openRowEl = rowEl;
      listState.openDetailEl = detail;
      // The list box is its own scroll area — an expansion near its fold
      // opens mostly out of view (the action buttons were the casualty).
      detail.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }

  /** Build one order row (checkbox + main/right/chevron) plus its (initially collapsed) detail, wired for tap-to-expand (spec §B/§C). */
  function buildOrderRowElement(row) {
    const hasData = Boolean(row.summary || row.invoice);
    const last4 = row.orderNumber.slice(-4);

    const rowEl = document.createElement("div");
    rowEl.className = "order-row" + (hasData ? "" : " order-row-fallback");
    rowEl.dataset.orderNumber = row.orderNumber;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = row.orderNumber;
    checkbox.value = row.orderNumber;
    checkbox.className = "order-row-checkbox";
    checkbox.setAttribute("aria-label", `Select order ending ${last4}`);
    // A checkbox click must never toggle the row's expansion (spec §C).
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    rowEl.appendChild(checkbox);

    const main = document.createElement("div");
    main.className = "order-row-main";
    const primary = document.createElement("div");
    primary.className = "order-row-primary";
    const fine = document.createElement("div");
    fine.className = "order-row-fine";

    if (hasData) {
      const dateShort = formatRowDateShort(row.normalizedDate);
      const primaryText = [dateShort, row.status].filter(Boolean).join(" · ");
      primary.textContent = primaryText || `Order #…${last4}`;
      const itemLabel =
        row.itemCount !== "" && row.itemCount !== null && row.itemCount !== undefined
          ? `${row.itemCount} item${Number(row.itemCount) === 1 ? "" : "s"}`
          : "";
      fine.textContent = [itemLabel, `#…${last4}`].filter(Boolean).join(" · ");
    } else {
      primary.textContent = `#…${last4}`;
      fine.textContent = "Details arrive on next sync";
      rowEl.classList.add("dimmed");
    }
    main.appendChild(primary);
    main.appendChild(fine);
    rowEl.appendChild(main);

    const right = document.createElement("div");
    right.className = "order-row-right";
    const totalEl = document.createElement("div");
    totalEl.className = "order-row-total mono";
    totalEl.textContent = row.total || "";
    right.appendChild(totalEl);
    if (row.hasInvoice) {
      right.appendChild(createCacheIndicator(row.orderNumber));
    }
    rowEl.appendChild(right);

    const wrapper = document.createElement("div");
    wrapper.className = "order-row-wrapper";
    wrapper.appendChild(rowEl);

    if (hasData) {
      const chevron = document.createElement("span");
      chevron.className = "order-row-chevron";
      chevron.innerHTML = renderIcon("CHEVRON_DOWN");
      rowEl.appendChild(chevron);

      rowEl.setAttribute("role", "button");
      rowEl.setAttribute("tabindex", "0");
      rowEl.setAttribute("aria-expanded", "false");

      const detail = buildOrderDetailElement(row);
      detail.hidden = true;
      wrapper.appendChild(detail);

      const isInteractive = (target) => target === checkbox || Boolean(target.closest && target.closest("button, a"));

      rowEl.addEventListener("click", (event) => {
        if (isInteractive(event.target)) return;
        toggleRowExpansion(rowEl, detail);
      });
      rowEl.addEventListener("keydown", (event) => {
        if (isInteractive(event.target)) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleRowExpansion(rowEl, detail);
        }
      });
    }

    return wrapper;
  }

  /** Group already date-sorted rows under uppercase month labels (spec §B), e.g. "JULY 2026" / "NO DATE". */
  /**
   * Everything about a row that affects its rendered content. When the
   * signature is unchanged the existing DOM node is reused untouched
   * (keeping its checkbox, open state, and scroll); when it changes the
   * node is rebuilt.
   */
  function rowSignature(row) {
    return [
      row.normalizedDate, row.status, row.itemCount, row.total,
      row.hasInvoice, row.title, Boolean(row.summary || row.invoice),
    ].join("|");
  }

  /** Build one row wrapper with its signature and checkbox listener attached. */
  function createRowWrapper(row) {
    const wrapper = buildOrderRowElement(row);
    wrapper.dataset.sig = rowSignature(row);
    const checkbox = wrapper.querySelector('input[type="checkbox"]');
    if (checkbox) {
      checkbox.addEventListener("change", () => {
        updateCheckboxCount(listState.container);
        updateDownloadButtonsState();
      });
    }
    return wrapper;
  }

  function buildOrderListBox(rows) {
    const box = document.createElement("div");
    box.className = "order-list";
    reconcileOrderRows(box, rows);
    return box;
  }

  /**
   * Keyed reconciliation of the order list (v7.3 collection-time fix):
   * bring `box` to exactly the desired sequence of month labels and rows
   * WITHOUT wiping it. Existing row elements are moved, not recreated, so
   * the user's scroll position, checked boxes, and the open accordion row
   * all survive the once-a-second re-render during a live collection —
   * new orders simply appear in place.
   */
  function reconcileOrderRows(box, visibleRows) {
    const existingRows = new Map();
    Array.from(box.querySelectorAll(".order-row-wrapper")).forEach((wrapper) => {
      const key = wrapper.querySelector(".order-row")?.dataset.orderNumber;
      if (key && !existingRows.has(key)) existingRows.set(key, wrapper);
    });

    const labelPool = new Map();
    Array.from(box.querySelectorAll(".order-month-label")).forEach((el) => {
      if (!labelPool.has(el.textContent)) labelPool.set(el.textContent, []);
      labelPool.get(el.textContent).push(el);
    });

    const dropOpenTrackingIfInside = (node) => {
      if (listState.openRowEl && node.contains(listState.openRowEl)) {
        listState.openRowEl = null;
        listState.openDetailEl = null;
      }
    };

    const fragment = document.createDocumentFragment();
    let lastGroup = null;
    visibleRows.forEach((row) => {
      const group = monthGroupLabel(row.normalizedDate);
      if (group !== lastGroup) {
        const pool = labelPool.get(group);
        let labelEl = pool && pool.length ? pool.shift() : null;
        if (!labelEl) {
          labelEl = document.createElement("div");
          labelEl.className = "order-month-label";
          labelEl.textContent = group;
        }
        fragment.appendChild(labelEl);
        lastGroup = group;
      }

      let wrapper = existingRows.get(row.orderNumber);
      if (wrapper) {
        existingRows.delete(row.orderNumber);
        if (wrapper.dataset.sig !== rowSignature(row)) {
          const wasChecked = Boolean(wrapper.querySelector('input[type="checkbox"]:checked'));
          dropOpenTrackingIfInside(wrapper);
          wrapper.remove();
          wrapper = createRowWrapper(row);
          if (wasChecked) {
            const checkbox = wrapper.querySelector('input[type="checkbox"]');
            if (checkbox) checkbox.checked = true;
          }
        }
      } else {
        wrapper = createRowWrapper(row);
      }
      fragment.appendChild(wrapper);
    });

    // Whatever is still keyed here fell out of the visible set.
    existingRows.forEach((wrapper) => {
      dropOpenTrackingIfInside(wrapper);
      wrapper.remove();
    });
    labelPool.forEach((els) => els.forEach((el) => el.remove()));

    box.appendChild(fragment);
  }

  function buildFilterRow(rows) {
    const row = document.createElement("div");
    row.className = "list-filter-row";
    const label = document.createElement("label");
    label.setAttribute("for", "listRangeFilter");
    label.textContent = "Showing";

    const select = document.createElement("select");
    select.id = "listRangeFilter";
    const now = new Date();
    LIST_RANGE_OPTIONS.forEach((option) => {
      const count = option.value === "all" ? rows.length : filterOrderRowsByRange(rows, option.value, { now }).visible.length;
      const optionEl = document.createElement("option");
      optionEl.value = option.value;
      optionEl.textContent = `${option.label} (${count})`;
      if (option.value === listState.filter) optionEl.selected = true;
      select.appendChild(optionEl);
    });
    const customOption = document.createElement("option");
    customOption.value = "custom";
    customOption.textContent = "Custom range…";
    if (listState.filter === "custom") customOption.selected = true;
    select.appendChild(customOption);

    select.addEventListener("change", () => {
      listState.filter = select.value;
      renderFilteredList();
    });

    row.appendChild(label);
    row.appendChild(select);

    // Escape hatch: any non-default filter gets a one-tap way back to
    // "All time" (also clears any custom dates) without hunting through
    // the select — matters most when a dashboard tap-through landed the
    // user on a pre-filtered list.
    if (listState.filter !== "all") {
      const clearButton = document.createElement("button");
      clearButton.type = "button";
      clearButton.id = "listRangeFilterClear";
      clearButton.className = "btn-link list-filter-clear";
      clearButton.textContent = "✕ Clear";
      clearButton.setAttribute("aria-label", "Clear date filter");
      clearButton.addEventListener("click", () => {
        listState.filter = "all";
        listState.customFrom = "";
        listState.customTo = "";
        renderFilteredList();
      });
      row.appendChild(clearButton);
    }
    return row;
  }

  function buildCustomRangeRow() {
    const row = document.createElement("div");
    row.className = "list-filter-custom";

    const fromInput = document.createElement("input");
    fromInput.type = "date";
    fromInput.id = "listFilterFrom";
    fromInput.setAttribute("aria-label", "From date");
    fromInput.value = listState.customFrom || "";
    fromInput.addEventListener("change", () => {
      listState.customFrom = fromInput.value;
      renderFilteredList();
    });

    const toInput = document.createElement("input");
    toInput.type = "date";
    toInput.id = "listFilterTo";
    toInput.setAttribute("aria-label", "To date");
    toInput.value = listState.customTo || "";
    toInput.addEventListener("change", () => {
      listState.customTo = toInput.value;
      renderFilteredList();
    });

    row.appendChild(fromInput);
    row.appendChild(toInput);
    return row;
  }

  function buildHiddenUndatedNote(count) {
    const note = document.createElement("p");
    note.className = "list-filter-hidden-note";
    note.id = "listFilterHiddenNote";
    note.textContent = `${count} order${count === 1 ? "" : "s"} without a date ${count === 1 ? "is" : "are"} hidden`;
    return note;
  }

  function buildSelectRow() {
    const row = document.createElement("div");
    row.className = "list-select-row";

    const checkboxContainer = document.createElement("div");
    checkboxContainer.className = CONSTANTS.CSS_CLASSES.CHECKBOX_CONTAINER;
    const selectAll = document.createElement("input");
    selectAll.type = "checkbox";
    selectAll.id = "selectAll";
    const label = document.createElement("label");
    label.htmlFor = "selectAll";
    // Text content is filled in by updateCheckboxCount (utils.js) right
    // after this row is attached — it's the one source of truth for both
    // this label and #listCountLine.
    checkboxContainer.appendChild(selectAll);
    checkboxContainer.appendChild(label);

    const countLine = document.createElement("div");
    countLine.className = "list-count-line";
    countLine.id = "listCountLine";

    row.appendChild(checkboxContainer);
    row.appendChild(countLine);
    return row;
  }

  function buildActionRow() {
    // Two-button model (spec §5.2): an equal, matched pair — Single file
    // (one workbook with every selected order) and Multiple files (one
    // file per selected order).
    const actionRow = document.createElement("div");
    actionRow.className = "action-row";

    const singleButton = document.createElement("button");
    singleButton.id = "singleFileDownload";
    singleButton.className = "btn btn-accent-pair";
    singleButton.innerHTML = `${renderIcon("DOWNLOAD")}<span class="btn-text">Single file</span>`;
    singleButton.addEventListener("click", () => Sidepanel.download.downloadSelectedOrders(CONSTANTS.EXPORT_MODES.SINGLE));
    actionRow.appendChild(singleButton);

    const multiButton = document.createElement("button");
    multiButton.id = "multiFileDownload";
    multiButton.className = "btn btn-accent-pair";
    multiButton.innerHTML = `${renderIcon("PACKAGE")}<span class="btn-text">Multiple files</span>`;
    multiButton.addEventListener("click", () => Sidepanel.download.downloadSelectedOrders(CONSTANTS.EXPORT_MODES.MULTIPLE));
    actionRow.appendChild(multiButton);

    return actionRow;
  }

  /**
   * Re-render #orderNumbersContainer from listState.rows for the current
   * filter, without re-reading OrderDb (spec §D). Preserves the checked
   * set for rows that stay visible by capturing it from the live DOM
   * before wiping the container — the simplest correct source of truth,
   * since real checkbox elements are the only place selection state lives.
   */
  function renderFilteredList() {
    const { rows, container } = listState;
    if (!container) return;

    const previouslyChecked = new Set(
      Array.from(container.querySelectorAll('input[type="checkbox"]:not(#selectAll):checked')).map((cb) => cb.value)
    );

    const { visible, hiddenUndatedCount } = filterOrderRowsByRange(rows, listState.filter, {
      customFrom: listState.customFrom,
      customTo: listState.customTo,
    });

    container.dataset.totalOrders = String(rows.length);

    let orderListBox = container.querySelector(".order-list");
    if (!orderListBox) {
      // ---- First build this session (coming from the placeholder) ----
      container.innerHTML = "";

      container.appendChild(buildFilterRow(rows));
      if (listState.filter === "custom") {
        container.appendChild(buildCustomRangeRow());
      }
      if (hiddenUndatedCount > 0 && listState.filter !== "all") {
        container.appendChild(buildHiddenUndatedNote(hiddenUndatedCount));
      }

      const selectRow = buildSelectRow();
      container.appendChild(selectRow);
      orderListBox = buildOrderListBox(visible);
      container.appendChild(orderListBox);

      const selectAll = selectRow.querySelector("#selectAll");
      if (selectAll) {
        selectAll.addEventListener("change", () => {
          toggleAllCheckboxes(container.querySelector(".order-list"), selectAll.checked);
          updateCheckboxCount(container);
          updateDownloadButtonsState();
        });
      }
    } else {
      // ---- Incremental update (v7.3): never wipe the container, so the
      // scroll position, checked boxes, and open row survive the
      // once-a-second refresh during a live collection. ----

      // The filter row is tiny and stateless (its state IS listState) —
      // swap it so the per-range counts stay current.
      const oldFilterRow = container.querySelector(".list-filter-row");
      const newFilterRow = buildFilterRow(rows);
      if (oldFilterRow) oldFilterRow.replaceWith(newFilterRow);
      else container.insertBefore(newFilterRow, container.firstChild);

      // Custom-range inputs keep their element (and focus) while relevant.
      const oldCustomRow = container.querySelector(".list-filter-custom");
      if (listState.filter === "custom") {
        if (!oldCustomRow) newFilterRow.after(buildCustomRangeRow());
      } else if (oldCustomRow) {
        oldCustomRow.remove();
      }

      const oldNote = container.querySelector("#listFilterHiddenNote");
      const wantNote = hiddenUndatedCount > 0 && listState.filter !== "all";
      if (wantNote) {
        const note = oldNote || buildHiddenUndatedNote(hiddenUndatedCount);
        note.textContent = `${hiddenUndatedCount} order${hiddenUndatedCount === 1 ? "" : "s"} without a date ${hiddenUndatedCount === 1 ? "is" : "are"} hidden`;
        if (!oldNote) (container.querySelector(".list-filter-custom") || newFilterRow).after(note);
      } else if (oldNote) {
        oldNote.remove();
      }

      reconcileOrderRows(orderListBox, visible);
    }

    const oldActionRow = container.querySelector(".action-row");
    if (visible.length > 0) {
      if (!oldActionRow) container.appendChild(buildActionRow());
      updateDownloadButtonLabels();
    } else if (oldActionRow) {
      oldActionRow.remove();
    }

    if (listState.pendingSelection) {
      // An exact selection (dashboard → "Select & download the missing N")
      // replaces whatever was checked before; rows filtered out of view
      // simply don't get selected.
      const wanted = new Set(listState.pendingSelection);
      container.querySelectorAll('input[type="checkbox"]:not(#selectAll)').forEach((checkbox) => {
        checkbox.checked = wanted.has(checkbox.value);
      });
      listState.pendingSelection = null;
    } else {
      previouslyChecked.forEach((orderNumber) => {
        const checkbox = container.querySelector(`input[value="${orderNumber}"]`);
        if (checkbox) checkbox.checked = true;
      });
    }

    // Row checkbox listeners are attached at element creation
    // (createRowWrapper); the select-all listener on first build above.
    updateCheckboxCount(container);
    updateDownloadButtonsState();
  }

  /**
   * Point the order list at a given range (and optionally an exact
   * selection), re-rendering immediately when the list has already been
   * built this session. The dashboard's tap-through paths (v7.2: tap a
   * month bar, "Export these orders", "Select & download the missing N")
   * call this right before switching to the main view — if the list hasn't
   * rendered yet, the filter/selection stick in listState and apply on the
   * next displayOrderNumbers() render instead.
   * @param {Object} options
   * @param {string} options.filter - LIST_RANGE_OPTIONS value, or 'custom'/'all'
   * @param {string} [options.customFrom] - 'YYYY-MM-DD' when filter === 'custom'
   * @param {string} [options.customTo] - 'YYYY-MM-DD' when filter === 'custom'
   * @param {string[]} [options.selectOrders] - order numbers to select EXACTLY (replaces the current selection)
   */
  function applyListFilter({ filter, customFrom = "", customTo = "", selectOrders = null } = {}) {
    listState.filter = filter || "all";
    listState.customFrom = customFrom;
    listState.customTo = customTo;
    listState.pendingSelection = Array.isArray(selectOrders) ? selectOrders.slice() : null;
    if (listState.container && listState.rows.length > 0) {
      renderFilteredList();
    }
  }

  /**
   * Render the panel's order list (spec v7.1 §B): each orderNumber is
   * enriched from OrderDb into a receipt-style row (date · status, item
   * count, total, an expandable detail) grouped under month labels, newest
   * first. Signature unchanged from the pre-redesign version — the e2e
   * harness and every existing caller (sidepanel.actions.js) keep working
   * unmodified; all the new behavior lives inside.
   * @param {string[]} orderNumbers
   * @param {Object} [additionalFields] - orderNumber → title (from a live GET_PROGRESS overlay)
   */
  async function displayOrderNumbers(orderNumbers, additionalFields = {}) {
    const container = document.getElementById("orderNumbersContainer");
    if (!container) return;

    // The download buttons and the user's selection live INSIDE this
    // container — rebuilding it mid-download orphans the button the run
    // holds a reference to and wipes the selection (review finding; the
    // tab-switch → checkCurrentTab chain reaches here with no guard).
    // A download run owns this container; skip the rebuild until it ends.
    if (state.app && state.app.downloadInProgress) return;

    if (orderNumbers.length === 0) {
      container.innerHTML = state.placeholders.initialOrderHtml || "";
      updateDownloadButtonsState();
      return;
    }

    const records = await OrderDb.getAllOrders();
    const byOrderNumber = new Map(records.map((record) => [record.orderNumber, record]));

    const rows = orderNumbers.map((orderNumber) =>
      buildOrderRowModel(orderNumber, byOrderNumber.get(orderNumber), additionalFields && additionalFields[orderNumber])
    );
    // Newest first; undated rows sink to the end (spec §B).
    rows.sort((a, b) => {
      if (a.normalizedDate && b.normalizedDate) return b.normalizedDate.localeCompare(a.normalizedDate);
      if (a.normalizedDate) return -1;
      if (b.normalizedDate) return 1;
      return 0;
    });

    listState.rows = rows;
    listState.container = container;
    listState.openRowEl = null;
    listState.openDetailEl = null;
    renderFilteredList();
  }

  /**
   * Show (or add) the informational "✓ saved" chip next to one order after
   * its invoice lands in IndexedDB (spec §4.4: info-only, no delete
   * affordance — the only way to remove saved data is Settings' "Delete
   * all saved data"). Looks up the row by data-order-number since rows no
   * longer live inside a .checkbox-container (spec v7.1 §B row layout).
   */
  function updateOrderCacheStatus(orderNumber) {
    const container = document.getElementById("orderNumbersContainer");
    if (!container) return;

    const rowEl = container.querySelector(`.order-row[data-order-number="${orderNumber}"]`);
    if (!rowEl) return;

    const right = rowEl.querySelector(".order-row-right");
    if (!right) return;

    const existingIndicator = right.querySelector(CACHE_INDICATOR_SELECTOR);
    if (existingIndicator) {
      existingIndicator.style.display = "inline-flex";
      return;
    }

    right.appendChild(createCacheIndicator(orderNumber));
  }

  function setButtonLoading(button, isLoading) {
    if (!button) return;
    const btnText = button.querySelector(".btn-text");
    if (isLoading) {
      button.disabled = true;
      if (!button.querySelector(".loading-spinner")) {
        const spinner = document.createElement("span");
        spinner.className = "loading-spinner";
        button.insertBefore(spinner, btnText || button.firstChild);
      }
    } else {
      button.disabled = false;
      const spinner = button.querySelector(".loading-spinner");
      if (spinner) spinner.remove();
    }
  }

  function initFaqAccordion() {
    document.querySelectorAll(".faq-question").forEach((question) => {
      question.addEventListener("click", () => {
        const answer = question.nextElementSibling;
        const arrow = question.querySelector(".arrow");

        answer.classList.toggle("active");
        arrow.classList.toggle("active");

        document.querySelectorAll(".faq-answer").forEach((otherAnswer) => {
          if (otherAnswer !== answer && otherAnswer.classList.contains("active")) {
            otherAnswer.classList.remove("active");
            otherAnswer.previousElementSibling.querySelector(".arrow").classList.remove("active");
          }
        });
      });
    });
  }

  function initCopyLinks() {
    const toast = document.getElementById("toast");
    if (!toast) return;

    document.querySelectorAll(".copy-link").forEach((link) => {
      link.style.cursor = "pointer";
      link.addEventListener("click", async () => {
        const linkText = link.dataset.link;
        try {
          await navigator.clipboard.writeText(linkText);
          Sidepanel.components.Toast("Link copied to clipboard!");
        } catch (err) {
          console.error("Failed to copy text: ", err);
        }
      });
    });
  }

  Sidepanel.view = {
    UI_MODES,
    UI_STATE,
    setInitialPlaceholder,
    switchView,
    showConfirmDialog,
    hideConfirmDialog,
    applyLayout,
    updateMacroState,
    getActiveRangeLabelSuffix,
    applyListFilter,
    getStatusRegion,
    renderStatusBanner,
    clearStatusBanner,
    createOffTabWarning,
    ensureOffTabWarning,
    clearOffTabWarning,
    showExtractionWarning,
    updateFilterNotice,
    setUIEnabled,
    updateDownloadButtonsState,
    updateProgressUI,
    createProgressElement,
    updateDownloadButtonLabels,
    showDownloadProgress,
    updateDownloadProgress,
    hideDownloadProgress,
    displayOrderNumbers,
    updateOrderCacheStatus,
    setButtonLoading,
    initFaqAccordion,
    initCopyLinks,
  };
})();
