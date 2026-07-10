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
  chrome.storage.local.get(["exportMode"], (res) => {
    app.exportMode = res.exportMode || CONSTANTS.EXPORT_MODES.MULTIPLE;
    if (exportModeSelect) exportModeSelect.value = app.exportMode;
  });

  if (exportModeSelect) {
    exportModeSelect.addEventListener("change", () => {
      app.exportMode = exportModeSelect.value;
      chrome.storage.local.set({ exportMode: app.exportMode });
      view.updateDownloadButtonLabel(app.exportMode);
    });
  }

  const exportFormatSelect = document.getElementById("exportFormat");
  const csvPresetGroup = document.getElementById("csvPresetGroup");
  const csvPresetSelect = document.getElementById("csvPreset");

  // The CSV preset only applies to CSV exports — hide it otherwise.
  function updateCsvPresetVisibility() {
    if (csvPresetGroup) {
      csvPresetGroup.style.display =
        app.exportFormat === CONSTANTS.EXPORT_FORMATS.CSV ? "" : "none";
    }
  }

  chrome.storage.local.get(["exportFormat"], (res) => {
    app.exportFormat = res.exportFormat || CONSTANTS.EXPORT_FORMATS.XLSX;
    if (exportFormatSelect) exportFormatSelect.value = app.exportFormat;
    updateCsvPresetVisibility();
  });

  if (exportFormatSelect) {
    exportFormatSelect.addEventListener("change", () => {
      app.exportFormat = exportFormatSelect.value;
      chrome.storage.local.set({ exportFormat: app.exportFormat });
      updateCsvPresetVisibility();
    });
  }

  chrome.storage.local.get(["csvPreset"], (res) => {
    app.csvPreset = res.csvPreset || CONSTANTS.CSV_PRESETS.GENERIC;
    if (csvPresetSelect) csvPresetSelect.value = app.csvPreset;
  });

  if (csvPresetSelect) {
    csvPresetSelect.addEventListener("change", () => {
      app.csvPreset = csvPresetSelect.value;
      chrome.storage.local.set({ csvPreset: app.csvPreset });
    });
  }

  const thumbnailToggle = document.getElementById("includeThumbnails");
  chrome.storage.local.get(["includeThumbnails"], (res) => {
    app.includeThumbnails = Boolean(res.includeThumbnails);
    if (thumbnailToggle) thumbnailToggle.checked = app.includeThumbnails;
  });

  if (thumbnailToggle) {
    thumbnailToggle.addEventListener("change", () => {
      app.includeThumbnails = thumbnailToggle.checked;
      chrome.storage.local.set({ includeThumbnails: app.includeThumbnails });
    });
  }

  const incrementalToggle = document.getElementById("incrementalCollect");
  chrome.storage.local.get(["incrementalCollect"], (res) => {
    app.incrementalCollect = Boolean(res.incrementalCollect);
    if (incrementalToggle) incrementalToggle.checked = app.incrementalCollect;
  });

  if (incrementalToggle) {
    incrementalToggle.addEventListener("change", () => {
      app.incrementalCollect = incrementalToggle.checked;
      chrome.storage.local.set({ incrementalCollect: app.incrementalCollect });
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

  // The dashboard is read-only (it only reads the local order database),
  // so opening it never interrupts a running collection or download.
  const dashboardButton = document.getElementById("dashboardButton");
  if (dashboardButton) {
    dashboardButton.addEventListener("click", function (e) {
      e.preventDefault();
      view.switchView("dashboard");
      Sidepanel.dashboard.renderDashboard();
    });
  }

  const dashboardBackButton = document.getElementById("dashboardBackButton");
  if (dashboardBackButton) {
    dashboardBackButton.addEventListener("click", function (e) {
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

  // Visible build version — unpacked-dev testing needs to know which build
  // is actually loaded (chrome://extensions reload is easy to forget).
  const versionBadge = document.getElementById("versionBadge");
  if (versionBadge && chrome.runtime.getManifest) {
    versionBadge.textContent = `v${chrome.runtime.getManifest().version}`;
  }

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
