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
        pageLimitGroup: "none",
        buttonGroup: "none",
        progress: "none",
        quickExportButton: "none",
      },
      cardDisplay: "block",
      checkboxContainerDisplay: "none",
    },
    [UI_MODES.MAIN_ORDERS]: {
      display: {
        pageLimitGroup: "block",
        buttonGroup: "flex",
        quickExportButton: "",
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
   * Switch between the panel's top-level views.
   * Unknown names fall back to the main view (matching the old behavior).
   * @param {string} viewName - "main", "faq", or "dashboard"
   * @param {Function} [onMain] - Invoked after switching to the main view
   */
  function switchView(viewName, onMain) {
    const views = {
      main: document.getElementById("mainView"),
      faq: document.getElementById("faqView"),
      dashboard: document.getElementById("dashboardView"),
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
   * Show (or refresh) the durable order-database stats line in the status
   * region. Best-effort: IndexedDB problems must never break the panel.
   */
  async function updateDbStats() {
    try {
      const stats = await OrderDb.getStats();

      if (stats.orders === 0) {
        clearStatusBanner("dbStats");
        return;
      }

      const banner = renderStatusBanner("dbStats", {
        variant: "info",
        message: `Order database: ${stats.orders} orders stored (${stats.invoices} with full invoice)`,
        actionHtml: `<button type="button" class="db-clear" title="Delete every stored order from the local database">clear</button>`,
      });
      if (!banner) return;

      const clearButton = banner.querySelector(".db-clear");
      if (clearButton) {
        clearButton.addEventListener("click", async () => {
          const confirmed = window.confirm(
            "Delete all orders stored in the local database? Exports and incremental collection will start from scratch."
          );
          if (!confirmed) return;
          try {
            await OrderDb.clearAll();
          } catch (error) {
            console.error("Failed to clear order database:", error);
          }
          updateDbStats();
        });
      }
    } catch (error) {
      console.warn("Order DB stats unavailable:", error);
    }
  }

  function setUIEnabled(enabled) {
    const card = document.querySelector(".card");
    if (card) {
      card.style.opacity = enabled ? "1" : "0.6";
      card.classList.toggle("disabled-card", !enabled);
    }

    ["downloadButton", "quickExportButton"].forEach((buttonId) => {
      const button = document.getElementById(buttonId);
      if (button) {
        button.disabled = !enabled;
        button.style.opacity = enabled ? "1" : "0.6";
        button.style.cursor = enabled ? "pointer" : "not-allowed";
      }
    });

    setCheckboxesDisabled(!enabled);
  }

  function updateProgressUI(currentPage, pageLimit, inProgress) {
    const progressElement = document.getElementById("progress") || createProgressElement();
    const pageLimitText = pageLimit > 0 ? ` of ${pageLimit}` : "";
    progressElement.style.display = "block";

    const placeholder = document.getElementById("collectionPlaceholder");
    if (placeholder && inProgress) {
      placeholder.style.display = "none";
    }

    if (inProgress) {
      progressElement.innerHTML = `
        <span class="loading-spinner" style="border-color: var(--primary); border-top-color: transparent;"></span>
        Fetching order numbers... Fetching Page ${currentPage}${pageLimitText} 
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

  function getDownloadButtonLabel(exportMode) {
    return exportMode === CONSTANTS.EXPORT_MODES.SINGLE
      ? "Download as Single File"
      : "Download Selected Orders";
  }

  function updateDownloadButtonLabel(exportMode) {
    const btn = document.getElementById("downloadButton");
    if (!btn) return;
    btn.lastChild.nodeValue = ` ${getDownloadButtonLabel(exportMode)}`;
  }

  async function displayOrderNumbers(orderNumbers, additionalFields = {}) {
    const container = document.getElementById("orderNumbersContainer");
    if (!container) return;

    if (orderNumbers.length === 0) {
      container.innerHTML = state.placeholders.initialOrderHtml || "";
      updateClearCacheVisibility();
      return;
    }

    container.innerHTML = `<h3>${CONSTANTS.TEXT.SELECT_ORDERS} (${orderNumbers.length}) - Selected: 0</h3>`;

    const cachedOrders = await getCachedOrderNumbers();
    const cachedSet = new Set(cachedOrders);

    const selectAllDiv = document.createElement("div");
    selectAllDiv.className = CONSTANTS.CSS_CLASSES.CHECKBOX_CONTAINER;
    const selectAll = document.createElement("input");
    selectAll.type = "checkbox";
    selectAll.id = "selectAll";
    const selectAllLabel = document.createElement("label");
    selectAllLabel.htmlFor = "selectAll";
    selectAllLabel.appendChild(document.createTextNode(CONSTANTS.TEXT.SELECT_ALL));
    selectAllDiv.appendChild(selectAll);
    selectAllDiv.appendChild(selectAllLabel);
    container.appendChild(selectAllDiv);

    const orderList = document.createElement("div");
    orderList.className = "order-list";

    orderNumbers.forEach((orderNumber) => {
      const tooltip = additionalFields && additionalFields[orderNumber] ? additionalFields[orderNumber] : null;
      const checkboxDiv = createCheckboxElement({
        id: orderNumber,
        value: orderNumber,
        label: `${CONSTANTS.TEXT.ORDER_PREFIX}${orderNumber}`,
        tooltip: tooltip,
      });

      if (cachedSet.has(orderNumber)) {
        const cacheIndicator = createCacheIndicator(orderNumber, {
          onDelete: () => cachedSet.delete(orderNumber),
          onAfterDelete: updateClearCacheVisibility,
        });
        checkboxDiv.appendChild(cacheIndicator);
      }

      orderList.appendChild(checkboxDiv);
    });

    container.appendChild(orderList);

    selectAll.addEventListener("change", function () {
      toggleAllCheckboxes(orderList, selectAll.checked);
      updateCheckboxCount(container);
    });

    orderNumbers.forEach((orderNumber) => {
      const checkbox = container.querySelector(`input[value="${orderNumber}"]`);
      if (checkbox) {
        checkbox.addEventListener("change", () => updateCheckboxCount(container));
      }
    });

    if (orderNumbers.length > 0 && !document.getElementById("downloadButton")) {
      // Paired action row: full download next to the instant quick export.
      const actionRow = document.createElement("div");
      actionRow.className = "action-row";

      const downloadButton = document.createElement("button");
      downloadButton.id = "downloadButton";
      downloadButton.className = CONSTANTS.CSS_CLASSES.BTN_SUCCESS;
      const label = getDownloadButtonLabel(state.app.exportMode);
      downloadButton.innerHTML = `
        ${renderIcon('DOWNLOAD')}
        ${label}
      `;
      downloadButton.addEventListener("click", Sidepanel.download.downloadSelectedOrders);
      actionRow.appendChild(downloadButton);

      const quickExportButton = document.createElement("button");
      quickExportButton.id = "quickExportButton";
      quickExportButton.className = CONSTANTS.CSS_CLASSES.BTN_PRIMARY;
      quickExportButton.title = "Instantly re-exports the SELECTED orders you have already downloaded — no pages opened, never synthesized data. Not-yet-downloaded orders are skipped.";
      quickExportButton.innerHTML = `
        ${renderIcon("BOLT")}
        <span class="btn-text">${CONSTANTS.TEXT.QUICK_EXPORT}</span>
      `;
      quickExportButton.addEventListener("click", Sidepanel.download.quickExportSummaries);
      actionRow.appendChild(quickExportButton);

      // displayOrderNumbers resolves asynchronously, so the single-order layout
      // may already be active by the time the button is created — hide it then.
      if (UI_STATE.mode === UI_MODES.SINGLE_ORDER) {
        quickExportButton.style.display = "none";
      }

      container.appendChild(actionRow);
    }

    updateClearCacheVisibility();
  }

  async function updateClearCacheVisibility() {
    const clearCacheBtn = document.getElementById("clearCache");
    if (!clearCacheBtn) return;

    const cachedOrders = await getCachedOrderNumbers();
    clearCacheBtn.style.display = "inline-flex";

    if (cachedOrders && cachedOrders.length > 0) {
      clearCacheBtn.classList.remove("muted");
      clearCacheBtn.disabled = false;
      clearCacheBtn.setAttribute("title", "Clear cached invoices");
    } else {
      clearCacheBtn.classList.add("muted");
      clearCacheBtn.disabled = false;
      clearCacheBtn.setAttribute("title", "No invoice cache found — click to ensure caches are cleared");
    }
  }

  function updateOrderCacheStatus(orderNumber) {
    const container = document.getElementById("orderNumbersContainer");
    if (!container) return;

    const checkbox = container.querySelector(`input[value="${orderNumber}"]`);
    if (!checkbox) return;

    const checkboxDiv = checkbox.closest(".checkbox-container");
    if (!checkboxDiv) return;

    const existingIndicator = checkboxDiv.querySelector(CACHE_INDICATOR_SELECTOR);
    if (existingIndicator) {
      existingIndicator.style.display = "inline-flex";
      updateClearCacheVisibility();
      return;
    }

    checkboxDiv.appendChild(
      createCacheIndicator(orderNumber, { onAfterDelete: updateClearCacheVisibility })
    );

    updateClearCacheVisibility();
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

  function maybeShowRatingHint() {
    if (Math.random() > 0.8) return;

    chrome.storage.local.get([CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISSED], function (sessionResult) {
      if (sessionResult[CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISSED]) return;

      chrome.storage.local.get([CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISS_COUNT], function (localResult) {
        const dismissCount = localResult[CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISS_COUNT] || 0;
        if (dismissCount >= 7) return;

        if (document.getElementById("ratingHint")) return;

        // Same trigger/gating as before (20% chance, not dismissed, under
        // the 7-dismiss cap) and the same delay before appearing — only the
        // rendering (Banner instead of a bespoke .rating-hint fade-in) and
        // its consolidated location (the status region, not "wherever the
        // download button happens to be") changed.
        setTimeout(() => {
          renderStatusBanner("ratingHint", {
            variant: "info",
            message: "Find this helpful? Consider rating it",
            actionHtml: `<a href="${CONSTANTS.URLS.WALMART_REVIEWS}" target="_blank">Rate it</a>`,
            dismissible: true,
            onDismiss: () => {
              chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISSED]: true });
              chrome.storage.local.get([CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISS_COUNT], function (result) {
                const newCount = (result[CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISS_COUNT] || 0) + 1;
                chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISS_COUNT]: newCount });
              });
            },
          });
        }, CONSTANTS.TIMING.RATING_DELAY);
      });
    });
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
    getStatusRegion,
    renderStatusBanner,
    clearStatusBanner,
    createOffTabWarning,
    ensureOffTabWarning,
    clearOffTabWarning,
    showExtractionWarning,
    updateFilterNotice,
    updateDbStats,
    setUIEnabled,
    updateProgressUI,
    createProgressElement,
    updateDownloadButtonLabel,
    displayOrderNumbers,
    updateClearCacheVisibility,
    updateOrderCacheStatus,
    setButtonLoading,
    maybeShowRatingHint,
    initFaqAccordion,
    initCopyLinks,
  };
})();
