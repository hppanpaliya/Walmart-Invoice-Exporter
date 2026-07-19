(() => {
  const Sidepanel = window.Sidepanel || (window.Sidepanel = {});

  const app = {
    downloadInProgress: false,
    collectionInProgress: false,
    exportMode: CONSTANTS.EXPORT_MODES.MULTIPLE,
    exportFormat: CONSTANTS.EXPORT_FORMATS.XLSX,
    csvPreset: CONSTANTS.CSV_PRESETS.GENERIC,
    includeThumbnails: false,
    legacyExcel: false,
    incrementalCollect: false,
    // Optional pure request-replay collection (direct API requests, no
    // pagination). OFF by default: Walmart bot-challenges blindly-replayed
    // requests, so the reliable default is to paginate and capture the page's
    // OWN (un-challenged) requests for dates. Opt in via Settings.
    fastFetch: false,
    currentOrdersUrl: null,
    // The ACTIVE provider selection driving the whole panel — a provider id,
    // or Sidepanel.providers.PROVIDER_ALL for the combined view. Hydrated from
    // Sidepanel.providers.getActive() on load and updated by the header
    // dropdown (sidepanel.js). Defaults to WALMART_US so the Walmart.com-only
    // flow is byte-for-byte unchanged until the user opts other providers in.
    provider: "WALMART_US",
    // Concrete provider id the last collection started from THIS panel runs
    // for — the fallback scope for GET_PROGRESS responses (which don't name a
    // provider), so one provider's live progress never renders into another
    // provider's view (sidepanel.actions.js's progressMatchesActiveScope).
    collectionProvider: null,
    // Hashed key of the Walmart account currently in view. The order list and
    // exports are scoped to it, so a different account's data doesn't show after
    // a logout/login. null = unknown (no filter — show everything). Hydrated
    // from chrome.storage.local `currentAccountKey` and refreshed when a Walmart
    // orders tab reports its account.
    accountKey: null,
  };

  // Configurable timings (Settings → Advanced) default from the shared
  // spec table; sidepanel.js hydrates the stored values on load.
  CONSTANTS.TIMING_SETTINGS.forEach((spec) => {
    app[spec.key] = spec.defaultMs;
  });

  Sidepanel.state = {
    app,
    ui: {
      mode: null,
    },
    placeholders: {
      initialOrderHtml: "",
    },
  };

  window.AppState = app;
})();
