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
      },
      cardDisplay: "block",
      checkboxContainerDisplay: "none",
    },
    [UI_MODES.MAIN_ORDERS]: {
      display: {
        pageLimitGroup: "block",
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

  function switchView(viewName, onMain) {
    const mainView = document.getElementById("mainView");
    const faqView = document.getElementById("faqView");
    if (!mainView || !faqView) return;

    if (viewName === "faq") {
      mainView.classList.remove("active");
      faqView.classList.add("active");
    } else {
      faqView.classList.remove("active");
      mainView.classList.add("active");
      if (onMain) onMain();
    }
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

  function createOffTabWarning(onReturn) {
    const warningBanner = document.createElement("div");
    warningBanner.id = "offTabWarning";
    warningBanner.className = "off-tab-warning";
    warningBanner.innerHTML = `
      <div class="warning-content">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <span>Return to <a href="#" id="returnToWalmartLink">Walmart Orders</a> to continue</span>
      </div>
    `;

    const returnLink = warningBanner.querySelector("#returnToWalmartLink");
    if (returnLink) {
      returnLink.addEventListener("click", (e) => {
        e.preventDefault();
        if (onReturn) onReturn();
      });
    }

    return warningBanner;
  }

  function ensureOffTabWarning(onReturn) {
    if (!document.getElementById("offTabWarning")) {
      const warningBanner = createOffTabWarning(onReturn);
      document.body.insertBefore(warningBanner, document.body.firstChild);
    }
  }

  function clearOffTabWarning() {
    const existingBanner = document.getElementById("offTabWarning");
    if (existingBanner) existingBanner.remove();
  }

  function setUIEnabled(enabled) {
    const card = document.querySelector(".card");
    if (card) {
      card.style.opacity = enabled ? "1" : "0.6";
      card.classList.toggle("disabled-card", !enabled);
    }

    const downloadButton = document.getElementById("downloadButton");
    if (downloadButton) {
      downloadButton.disabled = !enabled;
      downloadButton.style.opacity = enabled ? "1" : "0.6";
      downloadButton.style.cursor = enabled ? "pointer" : "not-allowed";
    }

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
      const downloadButton = document.createElement("button");
      downloadButton.id = "downloadButton";
      downloadButton.className = CONSTANTS.CSS_CLASSES.BTN_SUCCESS;
      const label = getDownloadButtonLabel(state.app.exportMode);
      downloadButton.innerHTML = `
        ${renderIcon('DOWNLOAD')}
        ${label}
      `;
      downloadButton.addEventListener("click", Sidepanel.download.downloadSelectedOrders);
      container.appendChild(downloadButton);
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

        let ratingHint = document.getElementById("ratingHint");
        if (!ratingHint) {
          ratingHint = document.createElement("div");
          ratingHint.id = "ratingHint";
          ratingHint.className = "rating-hint";
          ratingHint.innerHTML = `
            <a href="${CONSTANTS.URLS.WALMART_REVIEWS}" target="_blank">
              ${renderIcon("STAR")}
              Find this helpful? Consider rating it
            </a>
            <button class="dismiss-hint" title="Don't show again">
              ${renderIcon("X_CLOSE")}
            </button>
          `;

          const downloadButton = document.getElementById("downloadButton");
          if (downloadButton) {
            downloadButton.insertAdjacentElement("afterend", ratingHint);
          }

          ratingHint.querySelector(".dismiss-hint").addEventListener("click", function () {
            ratingHint.classList.remove("show");
            chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISSED]: true });

            chrome.storage.local.get([CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISS_COUNT], function (result) {
              const newCount = (result[CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISS_COUNT] || 0) + 1;
              chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISS_COUNT]: newCount });
            });
          });
        }

        setTimeout(() => {
          ratingHint.classList.add("show");
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
          toast.classList.add("show");
          setTimeout(() => {
            toast.classList.remove("show");
          }, 2000);
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
    createOffTabWarning,
    ensureOffTabWarning,
    clearOffTabWarning,
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
