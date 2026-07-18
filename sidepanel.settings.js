/**
 * Settings view (design spec §5.4) — Appearance, Collection, Export
 * defaults, Data on this device, About.
 *
 * Deliberately reads/writes the SAME individual chrome.storage.local keys
 * the main view already uses (exportFormat, includeThumbnails, legacyExcel,
 * incrementalCollect, pageLimit, theme) rather than a consolidated
 * `settings` object — that migration is a separate, riskier change and is
 * out of scope here. Settings is the DEFAULTS editor; the main view's own
 * Options disclosure / format controls stay the per-run overrides, reading
 * and writing the exact same keys so a change made in either place takes
 * effect in the other immediately (no reload needed).
 *
 * Rendered fresh every time the header gear is opened (sidepanel.js's
 * settingsButton handler), matching the Dashboard's render-on-open pattern
 * — always reflects the latest storage/DB state rather than a stale
 * page-load snapshot.
 */
(() => {
  const Sidepanel = window.Sidepanel || (window.Sidepanel = {});
  const state = Sidepanel.state;

  /**
   * Restored by "Reset settings to defaults" (spec §5.4) — mirrors
   * sidepanel.state.js's app defaults, plus theme/pageLimit (which live
   * only in chrome.storage.local, not in-memory app state).
   */
  const SETTINGS_DEFAULTS = {
    exportMode: CONSTANTS.EXPORT_MODES.MULTIPLE,
    exportFormat: CONSTANTS.EXPORT_FORMATS.XLSX,
    csvPreset: CONSTANTS.CSV_PRESETS.GENERIC,
    includeThumbnails: false,
    incrementalCollect: false,
    fastFetch: false,
    theme: "system",
    pageLimit: 0,
  };
  SETTINGS_DEFAULTS[CONSTANTS.STORAGE_KEYS.LEGACY_EXCEL] = false;

  const THEME_OPTIONS = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];

  /**
   * Push a Settings-made change into the main view's own controls + the
   * in-memory app state, so it takes effect immediately without a reload
   * (spec §5.4: "changing a default reflects on the main view and
   * vice-versa"). The main view's own change handlers (sidepanel.js) already
   * do the reverse — this just closes the loop from the Settings side.
   */
  function syncMainView(key, value) {
    const app = state.app;
    switch (key) {
      case "exportFormat": {
        app.exportFormat = value;
        const select = document.getElementById("exportFormat");
        if (select) select.value = value;
        if (Sidepanel.syncExportFormatVisibility) Sidepanel.syncExportFormatVisibility();
        if (Sidepanel.view) Sidepanel.view.updateDownloadButtonLabels();
        break;
      }
      case "includeThumbnails": {
        app.includeThumbnails = value;
        const checkbox = document.getElementById("includeThumbnails");
        if (checkbox) checkbox.checked = value;
        break;
      }
      case CONSTANTS.STORAGE_KEYS.LEGACY_EXCEL: {
        app.legacyExcel = value;
        const checkbox = document.getElementById("legacyExcel");
        if (checkbox) checkbox.checked = value;
        break;
      }
      case "incrementalCollect": {
        app.incrementalCollect = value;
        const checkbox = document.getElementById("incrementalCollect");
        if (checkbox) checkbox.checked = value;
        break;
      }
      case "pageLimit": {
        const input = document.getElementById("pageLimit");
        if (input) input.value = value;
        break;
      }
      default:
        break;
    }
  }

  /** Write one setting key to storage and immediately reflect it on the main view. */
  function persist(key, value) {
    chrome.storage.local.set({ [key]: value });
    syncMainView(key, value);
  }

  function themeSectionHtml(current) {
    const options = THEME_OPTIONS.map(
      (opt) =>
        `<button type="button" class="segmented-option${opt.value === current ? " active" : ""}" data-theme-choice="${opt.value}">${opt.label}</button>`
    ).join("");
    return `
      <div class="settings-section">
        <h3 class="settings-section-title">Appearance</h3>
        <div class="segmented-control" id="themeControl" role="group" aria-label="Theme">${options}</div>
      </div>
    `;
  }

  function collectionSectionHtml(pageLimit, incrementalCollect, fastFetch) {
    return `
      <div class="settings-section">
        <h3 class="settings-section-title">Collection</h3>
        <div class="input-group">
          <label for="settingsPageLimit">Default pages to scan (0 = all)</label>
          <input type="number" id="settingsPageLimit" min="0" value="${Number(pageLimit) || 0}">
        </div>
        <div class="toggle-group">
          <input type="checkbox" id="settingsIncrementalCollect" ${incrementalCollect ? "checked" : ""}>
          <label for="settingsIncrementalCollect">Only new orders by default</label>
        </div>
        <div class="toggle-group">
          <input type="checkbox" id="settingsFastFetch" ${fastFetch ? "checked" : ""}>
          <label for="settingsFastFetch" title="Experimental: tries to pull your whole history via direct API requests instead of paginating. Walmart may challenge blindly-replayed requests, so this can stop after the first page — the default paginating method is more reliable. Nothing leaves this device.">Try direct-request collection (experimental)</label>
        </div>
        <p class="settings-about-note">Off by default. The normal method pages through your history and reads each page's real order date from your browser's own requests — reliable, and it keeps the dates. This experimental option instead replays the API directly; it can be faster but Walmart sometimes blocks it after the first page.</p>
      </div>
    `;
  }

  function exportDefaultsSectionHtml({ exportFormat, includeThumbnails, legacyExcel }) {
    const formatOptions = [
      [CONSTANTS.EXPORT_FORMATS.XLSX, "Excel (.xlsx)"],
      [CONSTANTS.EXPORT_FORMATS.CSV, "CSV (.csv)"],
      [CONSTANTS.EXPORT_FORMATS.JSON, "JSON (.json)"],
      [CONSTANTS.EXPORT_FORMATS.RECEIPT, "Printable receipt (.html)"],
      [CONSTANTS.EXPORT_FORMATS.PDF, "PDF receipt (.pdf)"],
    ]
      .map(([value, label]) => `<option value="${value}"${value === exportFormat ? " selected" : ""}>${label}</option>`)
      .join("");

    return `
      <div class="settings-section">
        <h3 class="settings-section-title">Export defaults</h3>
        <div class="input-group">
          <label for="settingsExportFormat">Default format</label>
          <select id="settingsExportFormat">${formatOptions}</select>
        </div>
        <div class="toggle-group">
          <input type="checkbox" id="settingsIncludeThumbnails" ${includeThumbnails ? "checked" : ""}>
          <label for="settingsIncludeThumbnails" title="Embeds product images in Excel exports.">Include product photos</label>
        </div>
        <div class="toggle-group toggle-group-minor">
          <input type="checkbox" id="settingsLegacyExcel" ${legacyExcel ? "checked" : ""}>
          <label for="settingsLegacyExcel" title="Single-sheet workbook like older versions (before the Orders/Items split).">Legacy Excel layout</label>
        </div>
      </div>
    `;
  }

  function dataSectionHtml(stats) {
    const line =
      stats.orders === 0
        ? "No orders saved on this device yet."
        : `${stats.orders} order${stats.orders === 1 ? "" : "s"} saved · ${stats.invoices} with full invoice`;
    return `
      <div class="settings-section">
        <h3 class="settings-section-title">Data on this device</h3>
        <p class="settings-stats-line" id="settingsStatsLine">${escapeHtml(line)}</p>
        <div class="settings-actions">
          <button type="button" id="deleteAllDataButton" class="btn btn-danger" ${stats.orders === 0 ? "disabled" : ""}>
            ${renderIcon("TRASH")}
            <span class="btn-text">Delete all saved data</span>
          </button>
          <button type="button" id="resetSettingsButton" class="btn btn-clear">Reset settings to defaults</button>
        </div>
      </div>
    `;
  }

  /**
   * The single honest clear-data control's actual effect (spec §4.4): wipes
   * IndexedDB (OrderDb.clearAll — orders + invoices) AND
   * chrome.storage.session's live collection progress (RESET_SESSION_STATE,
   * background.js), then refreshes both Settings' own stats line and the
   * main view/dashboard so every surface lands on a true empty state.
   * Separated from the Dialog confirmation UI (confirmDeleteAllData, below)
   * so it can be exercised directly in tests without a real DOM.
   * @returns {Promise<void>}
   */
  async function deleteAllSavedData() {
    try {
      await OrderDb.clearAll();
    } catch (error) {
      console.error("Failed to clear the order database:", error);
    }
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.RESET_SESSION_STATE }, () => resolve());
    });

    if (Sidepanel.components) Sidepanel.components.Toast("Saved data cleared");
    renderSettings();
    if (Sidepanel.actions && Sidepanel.actions.checkCurrentTab) {
      Sidepanel.actions.checkCurrentTab();
    }
  }

  /**
   * Confirmation UI for deleteAllSavedData: a focus-trapped Dialog whose
   * confirm button echoes the exact count about to be deleted.
   */
  function confirmDeleteAllData(stats) {
    const count = stats.orders;
    Sidepanel.components.Dialog({
      title: "Delete all saved data",
      bodyHtml:
        "Removes all saved orders, invoices, and dashboard data from this device. Exports, the dashboard, and collection start over. This can't be undone.",
      confirmLabel: `Delete ${count} order${count === 1 ? "" : "s"}`,
      confirmVariant: "danger",
      cancelLabel: "Cancel",
      onConfirm: deleteAllSavedData,
    });
  }

  /**
   * Restore every settings key (NOT stored data — see deleteAllSavedData
   * above for that) to its default, then refresh both Settings and the
   * main view's own controls so the reset is visible immediately.
   * @returns {Promise<void>}
   */
  async function resetSettingsToDefaults() {
    await new Promise((resolve) => chrome.storage.local.set(SETTINGS_DEFAULTS, resolve));

    const app = state.app;
    app.exportMode = SETTINGS_DEFAULTS.exportMode;
    app.exportFormat = SETTINGS_DEFAULTS.exportFormat;
    app.csvPreset = SETTINGS_DEFAULTS.csvPreset;
    app.includeThumbnails = SETTINGS_DEFAULTS.includeThumbnails;
    app.incrementalCollect = SETTINGS_DEFAULTS.incrementalCollect;
    app.fastFetch = SETTINGS_DEFAULTS.fastFetch;
    app.legacyExcel = SETTINGS_DEFAULTS[CONSTANTS.STORAGE_KEYS.LEGACY_EXCEL];

    if (Sidepanel.applyTheme) Sidepanel.applyTheme(SETTINGS_DEFAULTS.theme);

    const mainCsvPresetSelect = document.getElementById("csvPreset");
    if (mainCsvPresetSelect) mainCsvPresetSelect.value = app.csvPreset;

    syncMainView("exportFormat", app.exportFormat);
    syncMainView("includeThumbnails", app.includeThumbnails);
    syncMainView(CONSTANTS.STORAGE_KEYS.LEGACY_EXCEL, app.legacyExcel);
    syncMainView("incrementalCollect", app.incrementalCollect);
    syncMainView("pageLimit", SETTINGS_DEFAULTS.pageLimit);

    if (Sidepanel.components) Sidepanel.components.Toast("Settings reset to defaults");
    renderSettings();
  }

  function wireDataControls(container, stats) {
    const deleteButton = container.querySelector("#deleteAllDataButton");
    if (deleteButton) {
      deleteButton.addEventListener("click", () => confirmDeleteAllData(stats));
    }

    const resetButton = container.querySelector("#resetSettingsButton");
    if (resetButton) {
      resetButton.addEventListener("click", () => resetSettingsToDefaults());
    }
  }

  /**
   * About section (spec §5.4): version, an on-device/no-telemetry note, and
   * the "Rate this extension" link — relocated here from the random
   * Math.random()>0.8-gated banner that used to appear near the download
   * actions (view.maybeShowRatingHint, removed). Same rating URL, but now a
   * single, always-available, non-nagging link.
   */
  function aboutSectionHtml() {
    const version =
      typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest
        ? chrome.runtime.getManifest().version
        : "";
    return `
      <div class="settings-section">
        <h3 class="settings-section-title">About</h3>
        <p class="settings-about-line">Version ${escapeHtml(version)}</p>
        <p class="settings-about-note">All data stays on this device — no telemetry, no accounts, nothing sent anywhere.</p>
        <a href="${CONSTANTS.URLS.WALMART_REVIEWS}" target="_blank" class="rating-button">
          ${renderIcon("STAR")}
          Rate on Chrome Web Store
        </a>
      </div>
    `;
  }

  /**
   * "Advanced · Providers" opt-in section: one toggle per registered adapter
   * whose defaultEnabled is false (never WALMART_US — it's always on and not
   * shown). Each toggle reflects Flags.isEnabled(id). Turning one ON requests
   * that adapter's host permission from within the user-gesture click handler;
   * on grant the flag is set, on denial the toggle reverts. Turning one OFF
   * clears the flag and best-effort removes the host permission.
   * @returns {Promise<string>} section HTML ('' when no optional providers)
   */
  async function providersSectionHtml() {
    const adapters = (typeof ProviderRegistry !== "undefined" ? ProviderRegistry.list() : []).filter(
      (adapter) => adapter && adapter.defaultEnabled === false
    );
    if (adapters.length === 0) return "";

    const rows = await Promise.all(
      adapters.map(async (adapter) => {
        let enabled = false;
        try {
          enabled = await Flags.isEnabled(adapter.id);
        } catch (error) {
          console.warn(`Settings: could not read flag for ${adapter.id}:`, error);
        }
        return `
          <div class="toggle-group">
            <input type="checkbox" id="providerToggle_${adapter.id}" data-provider-id="${adapter.id}" ${enabled ? "checked" : ""}>
            <label for="providerToggle_${adapter.id}">${escapeHtml(adapter.label)}</label>
          </div>
        `;
      })
    );

    return `
      <div class="settings-section">
        <h3 class="settings-section-title">Advanced · Providers</h3>
        <p class="settings-about-note">Collect orders from other retailers. Turning one on asks Chrome for permission to that site; everything still stays on this device.</p>
        ${rows.join("")}
      </div>
    `;
  }

  function wireProvidersControls(container) {
    container.querySelectorAll("[data-provider-id]").forEach((toggle) => {
      toggle.addEventListener("change", () => {
        const providerId = toggle.dataset.providerId;
        const adapter = typeof ProviderRegistry !== "undefined" ? ProviderRegistry.getById(providerId) : null;
        if (!adapter) return;
        const origins = adapter.hostPermissions || [];

        // A flag flip changes what Sidepanel.providers.selectable() returns —
        // refresh the header provider dropdown's options right away (the
        // chrome.storage.onChanged echo in sidepanel.js also covers changes
        // made from other contexts).
        const refreshDropdown = () => {
          if (Sidepanel.refreshProviderOptions) Sidepanel.refreshProviderOptions();
        };

        if (toggle.checked) {
          // Must run inside this user-gesture handler for the prompt to appear.
          chrome.permissions.request({ origins }, (granted) => {
            if (chrome.runtime.lastError || !granted) {
              // Denied (or errored) — revert the toggle, leave the flag off.
              toggle.checked = false;
              return;
            }
            Flags.setEnabled(providerId, true).then(refreshDropdown);
          });
        } else {
          Flags.setEnabled(providerId, false).then(() => {
            // Best-effort: revoke the host permission we no longer need.
            chrome.permissions.remove({ origins }, () => {
              void chrome.runtime.lastError;
            });
            refreshDropdown();
          });
        }
      });
    });
  }

  function wireThemeControl(container) {
    const control = container.querySelector("#themeControl");
    if (!control) return;
    control.querySelectorAll(".segmented-option").forEach((button) => {
      button.addEventListener("click", () => {
        const value = button.dataset.themeChoice;
        chrome.storage.local.set({ theme: value });
        Sidepanel.applyTheme(value);
        control.querySelectorAll(".segmented-option").forEach((b) => b.classList.toggle("active", b === button));
      });
    });
  }

  function wireCollectionControls(container) {
    const pageLimitInput = container.querySelector("#settingsPageLimit");
    if (pageLimitInput) {
      pageLimitInput.addEventListener("change", () => {
        const value = parseInt(pageLimitInput.value, 10) || 0;
        persist("pageLimit", value);
      });
    }

    const incrementalToggle = container.querySelector("#settingsIncrementalCollect");
    if (incrementalToggle) {
      incrementalToggle.addEventListener("change", () => {
        persist("incrementalCollect", incrementalToggle.checked);
      });
    }

    const fastFetchToggle = container.querySelector("#settingsFastFetch");
    if (fastFetchToggle) {
      fastFetchToggle.addEventListener("change", () => {
        chrome.storage.local.set({ fastFetch: fastFetchToggle.checked });
        // Mirror into app state so a collection started right after toggling
        // (no reload) picks it up synchronously.
        state.app.fastFetch = fastFetchToggle.checked;
      });
    }
  }

  function wireExportDefaultsControls(container) {
    const formatSelect = container.querySelector("#settingsExportFormat");
    if (formatSelect) {
      formatSelect.addEventListener("change", () => {
        persist("exportFormat", formatSelect.value);
      });
    }

    const thumbnailsToggle = container.querySelector("#settingsIncludeThumbnails");
    if (thumbnailsToggle) {
      thumbnailsToggle.addEventListener("change", () => {
        persist("includeThumbnails", thumbnailsToggle.checked);
      });
    }

    const legacyToggle = container.querySelector("#settingsLegacyExcel");
    if (legacyToggle) {
      legacyToggle.addEventListener("change", () => {
        persist(CONSTANTS.STORAGE_KEYS.LEGACY_EXCEL, legacyToggle.checked);
      });
    }
  }

  /**
   * Render the Settings view content from current storage state. Called
   * every time the header gear is opened — never cached, so every control
   * (including the "Data on this device" stats line) always reflects the
   * latest state rather than a page-load snapshot.
   */
  async function renderSettings() {
    const container = document.getElementById("settingsContent");
    if (!container) return;

    const keys = [
      "theme",
      "pageLimit",
      "incrementalCollect",
      "fastFetch",
      "exportFormat",
      "includeThumbnails",
      CONSTANTS.STORAGE_KEYS.LEGACY_EXCEL,
    ];
    const stored = await new Promise((resolve) => chrome.storage.local.get(keys, resolve));

    const theme = stored.theme || "system";
    const pageLimit = Number.isFinite(stored.pageLimit) ? stored.pageLimit : 0;
    const incrementalCollect = Boolean(stored.incrementalCollect);
    const fastFetch = Boolean(stored.fastFetch);
    const exportFormat = stored.exportFormat || CONSTANTS.EXPORT_FORMATS.XLSX;
    const includeThumbnails = Boolean(stored.includeThumbnails);
    const legacyExcel = Boolean(stored[CONSTANTS.STORAGE_KEYS.LEGACY_EXCEL]);

    let stats = { orders: 0, invoices: 0 };
    try {
      stats = await OrderDb.getStats();
    } catch (error) {
      console.warn("Settings: order database unavailable for stats:", error);
    }

    const providersHtml = await providersSectionHtml();

    container.innerHTML = [
      themeSectionHtml(theme),
      collectionSectionHtml(pageLimit, incrementalCollect, fastFetch),
      exportDefaultsSectionHtml({ exportFormat, includeThumbnails, legacyExcel }),
      providersHtml,
      dataSectionHtml(stats),
      aboutSectionHtml(),
    ].join("");

    wireThemeControl(container);
    wireCollectionControls(container);
    wireExportDefaultsControls(container);
    wireProvidersControls(container);
    wireDataControls(container, stats);
  }

  Sidepanel.settings = {
    renderSettings,
    SETTINGS_DEFAULTS,
    deleteAllSavedData,
    resetSettingsToDefaults,
  };
})();
