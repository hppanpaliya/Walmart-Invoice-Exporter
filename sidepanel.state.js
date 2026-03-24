(() => {
  const Sidepanel = window.Sidepanel || (window.Sidepanel = {});

  const app = {
    downloadInProgress: false,
    collectionInProgress: false,
    exportMode: CONSTANTS.EXPORT_MODES.MULTIPLE,
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
