// Theme (spec §5.5): apply a persisted appearance preference before first
// paint. Runs synchronously at script-parse time (this file is the last
// <script> in sidepanel.html, so document.documentElement already exists —
// no need to wait for DOMContentLoaded) rather than inside the
// DOMContentLoaded handler below, to keep the flash of the wrong theme as
// short as possible while chrome.storage.local resolves.
//
// "system" (the default, and the only mode reachable today) removes
// data-theme entirely so sidepanel.css's `@media (prefers-color-scheme)`
// rule applies. The Settings view (a later phase) will let a user pin
// "light" or "dark" via chrome.storage.local's "theme" key, stamping
// data-theme so the matching `:root[data-theme=...]` override in
// sidepanel.css wins over the OS preference in both directions.
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "dark" || theme === "light") {
    root.setAttribute("data-theme", theme);
  } else {
    root.removeAttribute("data-theme");
  }
}

if (chrome?.storage?.local?.get) {
  chrome.storage.local.get(["theme"], (result) => {
    applyTheme(result && result.theme);
  });
} else {
  applyTheme("system");
}

// Exposed for reuse once a Settings theme toggle exists (it will call this
// again immediately after writing a new "theme" preference).
window.Sidepanel = window.Sidepanel || {};
window.Sidepanel.applyTheme = applyTheme;

// Global error handler for unhandled promise rejections
window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
});

document.addEventListener("DOMContentLoaded", async function () {
  const Sidepanel = window.Sidepanel;
  const app = Sidepanel.state.app;
  const view = Sidepanel.view;
  const actions = Sidepanel.actions;

  // One-time, idempotent cleanup of retired chrome.storage.local caches
  // (spec §4.5) — awaited before the order list (below) is first rendered
  // from the DB, so a freshly-upgraded user's old invoice cache has
  // already landed in IndexedDB by the time it would otherwise show up.
  await migrateLegacyStorage().catch((error) =>
    console.warn("Legacy storage migration failed:", error)
  );

  const orderNumbersContainer = document.getElementById("orderNumbersContainer");
  view.setInitialPlaceholder(orderNumbersContainer);
  const progressElement = document.getElementById("progress");
  if (progressElement) progressElement.style.display = "none";

  // No <select> anymore — the two download buttons themselves set the mode
  // (spec §5.2). Still read the persisted value on init so a fresh
  // "Retry failed" or any other pre-click read of app.exportMode has a
  // sane default, and still written on every click for upgrade continuity.
  chrome.storage.local.get(["exportMode"], (res) => {
    app.exportMode = res.exportMode || CONSTANTS.EXPORT_MODES.MULTIPLE;
  });

  const exportFormatSelect = document.getElementById("exportFormat");
  const csvPresetGroup = document.getElementById("csvPresetGroup");
  const csvPresetSelect = document.getElementById("csvPreset");
  const legacyExcelToggleGroup = document.getElementById("legacyExcelToggleGroup");

  // The CSV preset only applies to CSV exports, and the legacy-layout
  // toggle only applies to Excel (spec §5.3) — hide each otherwise.
  function updateFormatDependentVisibility() {
    if (csvPresetGroup) {
      csvPresetGroup.style.display =
        app.exportFormat === CONSTANTS.EXPORT_FORMATS.CSV ? "" : "none";
    }
    if (legacyExcelToggleGroup) {
      legacyExcelToggleGroup.style.display =
        app.exportFormat === CONSTANTS.EXPORT_FORMATS.XLSX ? "" : "none";
    }
  }

  chrome.storage.local.get(["exportFormat"], (res) => {
    app.exportFormat = res.exportFormat || CONSTANTS.EXPORT_FORMATS.XLSX;
    if (exportFormatSelect) exportFormatSelect.value = app.exportFormat;
    updateFormatDependentVisibility();
    view.updateDownloadButtonLabels();
  });

  if (exportFormatSelect) {
    exportFormatSelect.addEventListener("change", () => {
      app.exportFormat = exportFormatSelect.value;
      chrome.storage.local.set({ exportFormat: app.exportFormat });
      updateFormatDependentVisibility();
      view.updateDownloadButtonLabels();
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

  // Legacy Excel layout (spec §5.3): opt-in, Excel-only, default off.
  // Only exportCombinedOrders/exportOneOrder (sidepanel.download.js) branch
  // on this — every other format ignores it, and the default writers are
  // completely untouched when it's off.
  const legacyExcelToggle = document.getElementById("legacyExcel");
  chrome.storage.local.get([CONSTANTS.STORAGE_KEYS.LEGACY_EXCEL], (res) => {
    app.legacyExcel = Boolean(res[CONSTANTS.STORAGE_KEYS.LEGACY_EXCEL]);
    if (legacyExcelToggle) legacyExcelToggle.checked = app.legacyExcel;
  });

  if (legacyExcelToggle) {
    legacyExcelToggle.addEventListener("change", () => {
      app.legacyExcel = legacyExcelToggle.checked;
      chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.LEGACY_EXCEL]: app.legacyExcel });
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

  // Both FAQ and Settings are navigated-away-from-main views guarded by the
  // same "operation in progress" confirm dialog (spec P4: Settings "respects
  // the existing operation-in-progress guard, like the FAQ nav does").
  // The dialog's own markup only has one Proceed button, so remember which
  // view was actually requested and send Proceed there instead of assuming FAQ.
  let pendingNavTarget = "faq";
  const NAV_TARGET_LABELS = { faq: "FAQ", settings: "Settings" };

  function requestViewSwitch(viewName) {
    if (actions.isOperationRunning()) {
      const opType = app.collectionInProgress ? "collection" : "download";
      pendingNavTarget = viewName;
      view.showConfirmDialog(
        `A ${opType} is currently running. Navigating to ${NAV_TARGET_LABELS[viewName] || viewName} will stop the operation. Your collected data will be preserved.`
      );
    } else {
      view.switchView(viewName, actions.checkCurrentTab);
    }
  }

  if (faqButton) {
    faqButton.addEventListener("click", function (e) {
      e.preventDefault();
      requestViewSwitch("faq");
    });
  }

  const settingsButton = document.getElementById("settingsButton");
  if (settingsButton) {
    settingsButton.addEventListener("click", function (e) {
      e.preventDefault();
      requestViewSwitch("settings");
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

  const settingsBackButton = document.getElementById("settingsBackButton");
  if (settingsBackButton) {
    settingsBackButton.addEventListener("click", function (e) {
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
      view.switchView(pendingNavTarget, actions.checkCurrentTab);
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

  // One-time tip (spec §7 risk table) telling returning users where Quick
  // Export went — not gated on order count like the rating hint, since
  // this is about orientation, not "you've used this enough to rate it".
  view.maybeShowQuickExportRetiredTip();

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
