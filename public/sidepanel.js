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
  // The theme can now change from another live context (the full-page
  // dashboard, or a second panel's Settings) — follow it without a reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.theme) applyTheme(changes.theme.newValue);
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
  const thumbnailToggleGroup = document.getElementById("thumbnailToggleGroup");

  // The CSV preset only applies to CSV exports; the legacy-layout toggle and
  // product thumbnails only apply to Excel (spec §5.3) — hide each otherwise.
  function updateFormatDependentVisibility() {
    const isCsv = app.exportFormat === CONSTANTS.EXPORT_FORMATS.CSV;
    const isXlsx = app.exportFormat === CONSTANTS.EXPORT_FORMATS.XLSX;
    if (csvPresetGroup) {
      csvPresetGroup.style.display = isCsv ? "" : "none";
    }
    if (legacyExcelToggleGroup) {
      legacyExcelToggleGroup.style.display = isXlsx ? "" : "none";
    }
    if (thumbnailToggleGroup) {
      thumbnailToggleGroup.style.display = isXlsx ? "" : "none";
    }
  }

  // Exposed so a Settings-made "Default format" change (sidepanel.settings.js)
  // can immediately refresh the main view's own dependent controls without
  // waiting for a reload.
  Sidepanel.syncExportFormatVisibility = updateFormatDependentVisibility;

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

  // Configurable timings (Settings → Advanced): hydrate the in-memory app
  // state the download queue reads. Clamped through the shared spec table
  // so a corrupt stored value can't hang a download.
  chrome.storage.local.get(CONSTANTS.TIMING_SETTINGS.map((spec) => spec.key), (res) => {
    CONSTANTS.TIMING_SETTINGS.forEach((spec) => {
      app[spec.key] = resolveTimingSetting(spec, res[spec.key]);
    });
  });

  // Hydrate the account the list is scoped to (last one collected/detected), so
  // the very first render already shows only that account's orders. A live
  // Walmart orders tab refreshes it (actions.checkCurrentTab).
  chrome.storage.local.get(["currentAccountKey"], (res) => {
    app.accountKey = res.currentAccountKey || null;
  });

  const incrementalToggle = document.getElementById("incrementalCollect");
  chrome.storage.local.get(["incrementalCollect", "fastFetch"], (res) => {
    app.incrementalCollect = Boolean(res.incrementalCollect);
    if (incrementalToggle) incrementalToggle.checked = app.incrementalCollect;
    // Mirror the optional pure request-replay flag (OFF by default; the
    // reliable pagination+capture path is the default collection method).
    app.fastFetch = Boolean(res.fastFetch);
  });

  if (incrementalToggle) {
    incrementalToggle.addEventListener("change", () => {
      app.incrementalCollect = incrementalToggle.checked;
      chrome.storage.local.set({ incrementalCollect: app.incrementalCollect });
    });
  }

  // Walmart order-history filters (Options): persisted like the other
  // collection options so the choice survives panel reopens. Read fresh off
  // the DOM at collection start (sidepanel.actions.js handleStartCollection).
  const collectFilterSelect = document.getElementById("collectFilter");
  const collectFromInput = document.getElementById("collectFrom");
  const collectToInput = document.getElementById("collectTo");
  chrome.storage.local.get(["collectFilterType", "collectFromDate", "collectToDate"], (res) => {
    if (collectFilterSelect && res.collectFilterType) collectFilterSelect.value = res.collectFilterType;
    if (collectFromInput && res.collectFromDate) collectFromInput.value = res.collectFromDate;
    if (collectToInput && res.collectToDate) collectToInput.value = res.collectToDate;
  });
  if (collectFilterSelect) {
    collectFilterSelect.addEventListener("change", () => {
      chrome.storage.local.set({ collectFilterType: collectFilterSelect.value });
    });
  }
  if (collectFromInput) {
    collectFromInput.addEventListener("change", () => {
      chrome.storage.local.set({ collectFromDate: collectFromInput.value });
    });
  }
  if (collectToInput) {
    collectToInput.addEventListener("change", () => {
      chrome.storage.local.set({ collectToDate: collectToInput.value });
    });
  }

  // Default page limit (spec §5.4 Settings "Collection" section) — same
  // "pageLimit" storage key Settings reads/writes; this is the first phase
  // this value is persisted at all (previously read fresh off the DOM at
  // collection start with no default carried between sessions).
  const pageLimitInput = document.getElementById("pageLimit");
  chrome.storage.local.get(["pageLimit"], (res) => {
    const stored = Number(res.pageLimit);
    if (pageLimitInput && Number.isFinite(stored) && stored >= 0) {
      pageLimitInput.value = stored;
    }
  });

  if (pageLimitInput) {
    pageLimitInput.addEventListener("change", () => {
      const value = parseInt(pageLimitInput.value, 10) || 0;
      chrome.storage.local.set({ pageLimit: value });
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
  let pendingNavCallback = null;
  const NAV_TARGET_LABELS = { faq: "FAQ", settings: "Settings" };

  /**
   * @param {string} viewName
   * @param {Function} [onSwitched] - Invoked right after the view actually
   *   becomes active, whether that happens immediately or (once the
   *   operation-in-progress confirm dialog resolves) after Proceed is
   *   clicked. Settings uses this to render fresh content on every open
   *   (spec §5.4), matching the Dashboard's render-on-open pattern.
   */
  function requestViewSwitch(viewName, onSwitched) {
    if (actions.isOperationRunning()) {
      const opType = app.collectionInProgress ? "collection" : "download";
      pendingNavTarget = viewName;
      pendingNavCallback = onSwitched || null;
      view.showConfirmDialog(
        `A ${opType} is currently running. Navigating to ${NAV_TARGET_LABELS[viewName] || viewName} will stop the operation. Your collected data will be preserved.`
      );
    } else {
      view.switchView(viewName, actions.checkCurrentTab);
      if (onSwitched) onSwitched();
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
      requestViewSwitch("settings", () => Sidepanel.settings && Sidepanel.settings.renderSettings());
    });
  }

  if (backButton) {
    backButton.addEventListener("click", function (e) {
      e.preventDefault();
      view.switchView("main", actions.checkCurrentTab);
    });
  }

  // The spending dashboard is a full extension page (dashboard.html) now,
  // not a panel view. Opening it never interrupts a running collection or
  // download; if a dashboard tab is already open, focus it instead of
  // stacking duplicates.
  const dashboardButton = document.getElementById("dashboardButton");
  if (dashboardButton) {
    if (window.self !== window.top) {
      // This panel is embedded in the dashboard's rail — you're already on the
      // dashboard, so the button does nothing (and looks disabled).
      dashboardButton.disabled = true;
      dashboardButton.title = "You're already on the dashboard";
    } else {
      dashboardButton.addEventListener("click", function (e) {
        e.preventDefault();
        const dashboardUrl = chrome.runtime.getURL("dashboard.html");
        chrome.tabs.query({ url: dashboardUrl }, function (tabs) {
          const existing = tabs && tabs[0];
          if (existing) {
            chrome.tabs.update(existing.id, { active: true });
            if (existing.windowId !== undefined) {
              chrome.windows.update(existing.windowId, { focused: true });
            }
          } else {
            chrome.tabs.create({ url: dashboardUrl });
          }
          // The full-page dashboard embeds this same panel, so keep the side
          // panel from lingering behind it — close it once the tab is up.
          try {
            window.close();
          } catch (_) {}
        });
      });
    }
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
      const callback = pendingNavCallback;
      pendingNavCallback = null;
      if (callback) callback();
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

  // Active-provider dropdown (header, sidepanel.html): the panel's single
  // provider switch — the active provider is first-class global state that
  // scopes the WHOLE panel (order list, collection target, export). Always
  // visible; with only Walmart enabled it renders just "Walmart.com" and
  // everything behaves exactly as the Walmart-only tool always has.
  const providerSelect = document.getElementById("providerSelect");

  /**
   * (Re)build the dropdown's options from Sidepanel.providers.selectable()
   * — every enabled provider, plus "All providers" when more than one is —
   * and sync app.provider to the persisted active selection. Re-run whenever
   * a provider is enabled/disabled in Settings (spec: the options must stay
   * current). When a flag flip retires the current selection (getActive
   * falls back to WALMART_US), the whole panel re-renders for the fallback.
   */
  async function refreshProviderOptions() {
    if (!providerSelect || !Sidepanel.providers) return;
    let options;
    let active;
    try {
      options = await Sidepanel.providers.selectable();
      active = await Sidepanel.providers.getActive();
    } catch (error) {
      console.warn("Provider selector: could not load providers:", error);
      return;
    }

    const previous = app.provider;
    app.provider = active;
    providerSelect.innerHTML = options
      .map(
        (option) =>
          `<option value="${option.id}"${option.id === active ? " selected" : ""}>${escapeHtml(option.label)}</option>`
      )
      .join("");
    providerSelect.value = active;
    if (previous !== active) renderPanelForProvider();
  }

  // Exposed so Settings' provider toggles (sidepanel.settings.js) can refresh
  // the options immediately after a flag flips, without waiting for the
  // chrome.storage.onChanged echo below.
  Sidepanel.refreshProviderOptions = refreshProviderOptions;

  /**
   * Re-render the ENTIRE panel for the active selection: the order list and
   * collection target re-derive from app.provider via checkCurrentTab —
   * never blocked by whatever tab is focused, since saved data comes
   * straight from OrderDb. The dashboard renders itself; its entry point is
   * just poked when present (separate module — no assumption about it).
   */
  function renderPanelForProvider() {
    // A previous provider's stale progress line must not linger while the
    // new selection's first render is in flight.
    const progressEl = document.getElementById("progress");
    if (progressEl) progressEl.style.display = "none";
    view.clearStatusBanner("cacheInfo");
    actions.checkCurrentTab();
    if (Sidepanel.dashboard && typeof Sidepanel.dashboard.render === "function") {
      Sidepanel.dashboard.render();
    }
  }

  if (providerSelect) {
    providerSelect.addEventListener("change", async () => {
      const id =
        providerSelect.value || (Sidepanel.providers && Sidepanel.providers.DEFAULT_PROVIDER) || "WALMART_US";
      if (Sidepanel.providers) await Sidepanel.providers.setActive(id);
      app.provider = id;
      renderPanelForProvider();
    });
  }

  // Provider flags live under the "settings" storage key (flags.js) and the
  // persisted selection under "active_provider" (sidepanel.providers.js) —
  // follow changes from any context (this panel's Settings, a second panel,
  // the dashboard) so the options and selection never go stale.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.settings || changes.active_provider)) {
      refreshProviderOptions();
    }
  });

  // Resolve the persisted selection BEFORE the first checkCurrentTab()
  // below, so the panel's very first paint is already scoped to it.
  await refreshProviderOptions();

  // Embed bridge: the full-page dashboard (dashboard.html) embeds this
  // panel in a same-origin iframe and drives a fixed set of actions via
  // postMessage. Strictly gated — same-origin only, a required source tag,
  // and a closed set of message types. Payload values are only ever
  // validated against existing controls/handlers; nothing from the message
  // is evaluated or reflected into the DOM.
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== "wie-dashboard") return;

    switch (data.type) {
      case "START_COLLECTION":
        // Same handler as the collect button — keeps every existing guard
        // (refuses during downloads; tab-independent, so it collects for
        // the active provider from anywhere).
        actions.handleStartCollection();
        break;

      case "EXPORT_ORDERS": {
        const modeMap = {
          single: CONSTANTS.EXPORT_MODES.SINGLE,
          multiple: CONSTANTS.EXPORT_MODES.MULTIPLE,
        };
        const exportMode = modeMap[data.mode];
        const orderNumbers = Array.isArray(data.orderNumbers)
          ? data.orderNumbers.filter((n) => typeof n === "string" && n.length > 0)
          : [];
        if (!exportMode || orderNumbers.length === 0) return;
        // The same pipeline the Single file / Multiple files buttons run —
        // it persists the mode and refuses while a download is in progress.
        Sidepanel.download.downloadSelectedOrders(exportMode, orderNumbers);
        break;
      }

      case "SAVE_TO_LIBRARY": {
        // "Fetch data" on the dashboard: fetch full invoice details into the
        // library without downloading a file — the same pipeline as the
        // panel's "Save details to library" button.
        const orderNumbers = Array.isArray(data.orderNumbers)
          ? data.orderNumbers.filter((n) => typeof n === "string" && n.length > 0)
          : [];
        if (orderNumbers.length === 0) return;
        Sidepanel.download.loadSelectedOrdersToDb(orderNumbers);
        break;
      }

      case "OPEN_SETTINGS":
        // Mirrors the header gear, including the operation-in-progress
        // confirm-dialog guard.
        requestViewSwitch("settings", () => Sidepanel.settings && Sidepanel.settings.renderSettings());
        break;

      case "SET_EXPORT_FORMAT": {
        if (!exportFormatSelect) return;
        const isKnown = Array.from(exportFormatSelect.options).some(
          (option) => option.value === data.format
        );
        if (!isKnown) return; // unknown formats are ignored
        exportFormatSelect.value = data.format;
        // Dispatch a real change event so every existing listener
        // (persistence, dependent-control visibility, button labels) runs.
        exportFormatSelect.dispatchEvent(new Event("change", { bubbles: true }));
        break;
      }

      case "SET_EXPORT_OPTION": {
        if (typeof data.value !== "boolean") return;
        const optionToggles = {
          thumbnails: thumbnailToggle,
          legacyExcel: legacyExcelToggle,
        };
        const toggle = optionToggles[data.option];
        if (!toggle) return; // unknown options are ignored
        toggle.checked = data.value;
        toggle.dispatchEvent(new Event("change", { bubbles: true }));
        break;
      }

      default:
        // No other message types are handled.
        break;
    }
  });

  // Visible build version — unpacked-dev testing needs to know which build
  // is actually loaded (chrome://extensions reload is easy to forget).
  const versionBadge = document.getElementById("versionBadge");
  if (versionBadge && chrome.runtime.getManifest) {
    versionBadge.textContent = `v${chrome.runtime.getManifest().version}`;
  } else if (versionBadge) {
    // No manifest (e.g. the page opened outside the extension) — an empty
    // pill just looks broken, so hide it.
    versionBadge.style.display = "none";
  }

  // Inactivity retention (on by default): if the extension was abandoned past
  // the window, wipe saved data BEFORE the first render (so it never flashes),
  // then mark this open as "use" (resets the clock) and re-render.
  OrderDb.enforceInactivityRetention()
    .catch(() => 0)
    .then(() => OrderDb.markUsed())
    .then(() => actions.checkCurrentTab())
    .catch(() => {});

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

  // Keep the panel's account view in sync with the dashboard (and a second
  // panel window): both write the shared CURRENT_ACCOUNT / ACCOUNT_LABELS /
  // ACCOUNT_ORDINALS keys, and this reacts to the OTHER surface's writes.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local") return;
      const currentChange = changes[CONSTANTS.STORAGE_KEYS.CURRENT_ACCOUNT];
      if (currentChange) {
        const next = currentChange.newValue != null ? currentChange.newValue : null;
        if (next !== app.accountKey) {
          app.accountKey = next;
          actions.loadCacheOnMainPage(); // re-scope the list + re-render the switcher
          return;
        }
      }
      // A label/ordinal change from elsewhere only needs the switcher redrawn.
      if (
        changes[CONSTANTS.STORAGE_KEYS.ACCOUNT_LABELS] ||
        changes[CONSTANTS.STORAGE_KEYS.ACCOUNT_ORDINALS]
      ) {
        actions.renderAccountSwitcher();
      }
    });
  }
});
