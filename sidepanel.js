// Global error handler for unhandled promise rejections
window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
});

document.addEventListener("DOMContentLoaded", function () {
  const Sidepanel = window.Sidepanel;
  const app = Sidepanel.state.app;
  const view = Sidepanel.view;
  const actions = Sidepanel.actions;

  const orderNumbersContainer = document.getElementById("orderNumbersContainer");
  view.setInitialPlaceholder(orderNumbersContainer);
  const progressElement = document.getElementById("progress");
  if (progressElement) progressElement.style.display = "none";

  const exportModeSelect = document.getElementById("exportMode");
  const collectionSourceSelect = document.getElementById("collectionSourceMode");
  chrome.storage.local.get(["exportMode", "collectionSourceMode"], (res) => {
    app.exportMode = res.exportMode || CONSTANTS.EXPORT_MODES.MULTIPLE;
    app.collectionSourceMode = normalizeCollectionSourceMode(res.collectionSourceMode);
    if (exportModeSelect) exportModeSelect.value = app.exportMode;
    if (collectionSourceSelect) collectionSourceSelect.value = app.collectionSourceMode;

    if (res.collectionSourceMode !== app.collectionSourceMode) {
      chrome.storage.local.set({ collectionSourceMode: app.collectionSourceMode });
    }
  });

  if (exportModeSelect) {
    exportModeSelect.addEventListener("change", () => {
      app.exportMode = exportModeSelect.value;
      chrome.storage.local.set({ exportMode: app.exportMode });
      view.updateDownloadButtonLabel(app.exportMode);
    });
  }

  if (collectionSourceSelect) {
    collectionSourceSelect.addEventListener("change", () => {
      app.collectionSourceMode = collectionSourceSelect.value;
      chrome.storage.local.set({ collectionSourceMode: app.collectionSourceMode });
    });
  }

  const faqButton = document.getElementById("faqButton");
  const backButton = document.getElementById("backButton");
  const confirmDialog = document.getElementById("confirmDialog");
  const confirmDialogCancel = document.getElementById("confirmDialogCancel");
  const confirmDialogProceed = document.getElementById("confirmDialogProceed");

  if (faqButton) {
    faqButton.addEventListener("click", function (e) {
      e.preventDefault();
      if (actions.isOperationRunning()) {
        const opType = app.collectionInProgress ? "collection" : "download";
        view.showConfirmDialog(
          `A ${opType} is currently running. Navigating to FAQ will stop the operation. Your collected data will be preserved.`
        );
      } else {
        view.switchView("faq", actions.checkCurrentTab);
      }
    });
  }

  if (backButton) {
    backButton.addEventListener("click", function (e) {
      e.preventDefault();
      view.switchView("main", actions.checkCurrentTab);
    });
  }

  if (confirmDialogCancel) {
    confirmDialogCancel.addEventListener("click", view.hideConfirmDialog);
  }

  if (confirmDialogProceed) {
    confirmDialogProceed.addEventListener("click", function () {
      view.hideConfirmDialog();
      if (app.collectionInProgress) {
        actions.stopCollection({ startLabel: "Restart Collection", showLoading: false });
      }
      app.downloadInProgress = false;
      view.switchView("faq", actions.checkCurrentTab);
    });
  }

  if (confirmDialog) {
    confirmDialog.addEventListener("click", function (e) {
      if (e.target === confirmDialog) {
        view.hideConfirmDialog();
      }
    });
  }

  view.initFaqAccordion();
  view.initCopyLinks();

  const startButton = document.getElementById("startCollection");
  const stopButton = document.getElementById("stopCollection");
  if (startButton) startButton.addEventListener("click", actions.handleStartCollection);
  if (stopButton) stopButton.addEventListener("click", actions.handleStopCollection);

  actions.checkCurrentTab();

  chrome.tabs.onActivated.addListener(actions.checkCurrentTab);
  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (changeInfo.status === "complete") {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs[0] && tabs[0].id === tabId) {
          actions.checkCurrentTab();
        }
      });
    }
  });

  const clearCacheButton = document.createElement("button");
  clearCacheButton.id = "clearCache";
  clearCacheButton.className = CONSTANTS.CSS_CLASSES.BTN_CLEAR;
  clearCacheButton.style.display = "inline-flex";
  clearCacheButton.innerHTML = `
    ${renderIcon("TRASH")}
    <span class="btn-text">${CONSTANTS.TEXT.CLEAR_CACHE_BTN}</span>
  `;

  const buttonGroup = document.querySelector(".button-group");
  if (buttonGroup) {
    buttonGroup.appendChild(clearCacheButton);
  }

  view.updateClearCacheVisibility();

  clearCacheButton.addEventListener("click", async function () {
    view.setButtonLoading(clearCacheButton, true);
    await clearAllInvoiceCache();

    chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.CLEAR_CACHE }, function (response) {
      if (response && response.status === "cache_cleared") {
        view.setButtonLoading(clearCacheButton, false);
        view.displayOrderNumbers([]);
        view.updateClearCacheVisibility();

        const progressElement = document.getElementById("progress");
        if (progressElement) {
          progressElement.textContent = "Cache cleared successfully";
          progressElement.style.display = "block";
          setTimeout(() => {
            progressElement.style.display = "none";
          }, 2000);
        }
      }
    });
  });
});
