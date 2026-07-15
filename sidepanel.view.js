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
   * Switch between the panel's top-level views.
   * Unknown names fall back to the main view (matching the old behavior).
   * @param {string} viewName - "main", "faq", "dashboard", or "settings"
   * @param {Function} [onMain] - Invoked after switching to the main view
   */
  function switchView(viewName, onMain) {
    const views = {
      main: document.getElementById("mainView"),
      faq: document.getElementById("faqView"),
      dashboard: document.getElementById("dashboardView"),
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
   * One-time dismissible tip shown where Quick Export used to be (design
   * spec §7 risk table: "Muscle-memory loss (Quick Export gone)"). Renders
   * once per install into the consolidated status region.
   */
  function maybeShowQuickExportRetiredTip() {
    if (document.getElementById("quickExportRetiredTip")) return;

    chrome.storage.local.get([CONSTANTS.STORAGE_KEYS.QUICK_EXPORT_TIP_DISMISSED], (result) => {
      if (result[CONSTANTS.STORAGE_KEYS.QUICK_EXPORT_TIP_DISMISSED]) return;

      renderStatusBanner("quickExportRetiredTip", {
        variant: "info",
        message: "Quick Export is now built into Download — saved orders re-export instantly.",
        dismissible: true,
        onDismiss: () => {
          chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.QUICK_EXPORT_TIP_DISMISSED]: true });
        },
      });
    });
  }

  async function displayOrderNumbers(orderNumbers, additionalFields = {}) {
    const container = document.getElementById("orderNumbersContainer");
    if (!container) return;

    if (orderNumbers.length === 0) {
      container.innerHTML = state.placeholders.initialOrderHtml || "";
      updateDownloadButtonsState();
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
        checkboxDiv.appendChild(createCacheIndicator(orderNumber));
      }

      orderList.appendChild(checkboxDiv);
    });

    container.appendChild(orderList);

    selectAll.addEventListener("change", function () {
      toggleAllCheckboxes(orderList, selectAll.checked);
      updateCheckboxCount(container);
      updateDownloadButtonsState();
    });

    orderNumbers.forEach((orderNumber) => {
      const checkbox = container.querySelector(`input[value="${orderNumber}"]`);
      if (checkbox) {
        checkbox.addEventListener("change", () => {
          updateCheckboxCount(container);
          updateDownloadButtonsState();
        });
      }
    });

    if (orderNumbers.length > 0 && !document.getElementById("singleFileDownload")) {
      // Two-button model (spec §5.2): an equal, matched pair — Single file
      // (one workbook with every selected order) and Multiple files (one
      // file per selected order) — replacing the old mutating Download
      // button + separate Quick Export button.
      const actionRow = document.createElement("div");
      actionRow.className = "action-row";

      const singleButton = document.createElement("button");
      singleButton.id = "singleFileDownload";
      singleButton.className = "btn btn-accent-pair";
      singleButton.innerHTML = `
        ${renderIcon("DOWNLOAD")}
        <span class="btn-text">Single file</span>
      `;
      singleButton.addEventListener("click", () =>
        Sidepanel.download.downloadSelectedOrders(CONSTANTS.EXPORT_MODES.SINGLE)
      );
      actionRow.appendChild(singleButton);

      const multiButton = document.createElement("button");
      multiButton.id = "multiFileDownload";
      multiButton.className = "btn btn-accent-pair";
      multiButton.innerHTML = `
        ${renderIcon("PACKAGE")}
        <span class="btn-text">Multiple files</span>
      `;
      multiButton.addEventListener("click", () =>
        Sidepanel.download.downloadSelectedOrders(CONSTANTS.EXPORT_MODES.MULTIPLE)
      );
      actionRow.appendChild(multiButton);

      container.appendChild(actionRow);
      updateDownloadButtonLabels();
    }

    updateDownloadButtonsState();
  }

  /**
   * Show (or add) the informational "✓ saved" chip next to one order after
   * its invoice lands in IndexedDB (spec §4.4: info-only, no delete
   * affordance — the only way to remove saved data is Settings' "Delete
   * all saved data").
   */
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
      return;
    }

    checkboxDiv.appendChild(createCacheIndicator(orderNumber));
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
    maybeShowQuickExportRetiredTip,
    displayOrderNumbers,
    updateOrderCacheStatus,
    setButtonLoading,
    initFaqAccordion,
    initCopyLinks,
  };
})();
