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
    currentOrdersUrl: null,
  };

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
