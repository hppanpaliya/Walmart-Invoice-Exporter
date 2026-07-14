(() => {
  const Sidepanel = window.Sidepanel || (window.Sidepanel = {});
  const app = Sidepanel.state.app;
  const view = Sidepanel.view;

  function isOperationRunning() {
    return app.downloadInProgress || app.collectionInProgress;
  }

  function switchToWalmartOrdersTab() {
    chrome.tabs.query({ url: `${CONSTANTS.URLS.WALMART_ORDERS}*` }, function (tabs) {
      if (tabs && tabs.length > 0) {
        chrome.tabs.update(tabs[0].id, { active: true });
        chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        chrome.tabs.create({ url: CONSTANTS.URLS.WALMART_ORDERS });
      }
    });
  }

  function showOffTabWarning() {
    view.setUIEnabled(false);
    view.applyLayout(view.UI_MODES.OFF_TAB);
    view.ensureOffTabWarning(switchToWalmartOrdersTab);

    chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.GET_PROGRESS }, function (response) {
      if (response && response.orderNumbers && response.orderNumbers.length > 0) {
        const container = document.getElementById("orderNumbersContainer");
        if (!container) return;
        if (!container.querySelector(".order-list") || container.querySelector(".order-list").children.length === 0) {
          view.displayOrderNumbers(response.orderNumbers, response.additionalFields);
        }
      }
    });
  }

  function checkCurrentTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || tabs.length === 0) {
        showOffTabWarning();
        return;
      }

      const tab = tabs[0];
      const url = tab.url;
      view.clearOffTabWarning();

      if (url && url.startsWith(CONSTANTS.URLS.WALMART_ORDERS)) {
        const cleanUrl = url.replace(/\/$/, "");
        const orderPath = cleanUrl.split("/orders/")[1];
        app.currentOrdersUrl = null;

        view.setUIEnabled(true);

        if (orderPath && /^\d{10,}$/.test(orderPath.split("?")[0])) {
          const orderNumber = orderPath.split("?")[0];
          view.updateFilterNotice(null);
          view.displayOrderNumbers([orderNumber]);
          view.applyLayout(view.UI_MODES.SINGLE_ORDER);
        } else {
          view.applyLayout(view.UI_MODES.MAIN_ORDERS);
          app.currentOrdersUrl = url;
          view.updateFilterNotice(url);
          view.updateDbStats();
          loadCacheOnMainPage();
        }
      } else {
        app.currentOrdersUrl = null;
        view.updateFilterNotice(null);
        showOffTabWarning();
      }
    });
  }

  function handleStartCollection() {
    if (!app.currentOrdersUrl) {
      showOffTabWarning();
      return;
    }

    const pageLimitInput = document.getElementById("pageLimit");
    const startButton = document.getElementById("startCollection");
    const pageLimit = parseInt(pageLimitInput ? pageLimitInput.value : "0", 10);
    setCollectionButtonsState({ running: true });
    view.setButtonLoading(startButton, true);

    chrome.runtime.sendMessage(
      {
        action: CONSTANTS.MESSAGES.START_COLLECTION,
        url: app.currentOrdersUrl,
        pageLimit: pageLimit,
        incremental: Boolean(app.incrementalCollect),
      },
      function (response) {
        if (response && response.status === "started") {
          updateProgress();
        }
        view.setButtonLoading(startButton, false);
      }
    );
  }

  function stopCollection({ startLabel = "Restart Collection", showLoading = true } = {}) {
    const stopButton = document.getElementById("stopCollection");
    if (showLoading) {
      view.setButtonLoading(stopButton, true);
    }

    chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.STOP_COLLECTION }, function (response) {
      if (response && response.status === "stopped") {
        app.collectionInProgress = false;
        setCollectionButtonsState({ running: false, startLabel });
      }
      if (showLoading) {
        view.setButtonLoading(stopButton, false);
      }
    });
  }

  function handleStopCollection() {
    stopCollection({ startLabel: "Restart Collection", showLoading: true });
  }

  /**
   * The panel's order list is derived from the durable database — the
   * source of truth for anything collected in any prior run — optionally
   * overlaid with order numbers an in-progress (or just-finished-this-
   * session) collection has found that haven't landed in the DB yet.
   * Replaces the old "cache snapshot, DB only as a fallback" fork
   * (spec §4.3). Collection still upserts every page into OrderDb via
   * putSummaries as it goes, so the overlay only ever needs to cover a
   * short lag, not the whole in-progress result set.
   * @param {Object|null} [progress] - a GET_PROGRESS response to overlay
   * @returns {Promise<boolean>} whether anything was rendered
   */
  async function displayOrdersFromDb(progress = null) {
    try {
      const records = await OrderDb.getAllOrders();
      const withData = records.filter((record) => record.summary || record.invoice);
      withData.sort((a, b) => String(b.orderDate).localeCompare(String(a.orderDate)));

      const orderNumbers = withData.map((record) => record.orderNumber);
      const titles = Object.fromEntries(withData.map((record) => [record.orderNumber, record.title || ""]));

      if (progress && Array.isArray(progress.orderNumbers)) {
        const known = new Set(orderNumbers);
        progress.orderNumbers.forEach((orderNumber) => {
          if (known.has(orderNumber)) return;
          known.add(orderNumber);
          orderNumbers.unshift(orderNumber);
          titles[orderNumber] = (progress.additionalFields && progress.additionalFields[orderNumber]) || "";
        });
      }

      if (orderNumbers.length === 0) return false;

      await view.displayOrderNumbers(orderNumbers, titles);

      if (!document.getElementById("cacheInfo")) {
        view.renderStatusBanner("cacheInfo", {
          variant: "info",
          message: `Loaded ${orderNumbers.length} orders from the local database`,
        });
      }
      return true;
    } catch (error) {
      console.warn("Could not load orders from the DB:", error);
      return false;
    }
  }

  /**
   * Render the panel's order list for a GET_PROGRESS response: DB history
   * overlaid with whatever this response's live/session order numbers add
   * (displayOrdersFromDb). Falls back to the raw response list when the DB
   * has nothing yet — e.g. a brand new user, first page of a first-ever
   * collection, before that page's OrderDb.putSummaries write has landed.
   * @param {Object} response - a GET_PROGRESS response
   * @returns {Promise<void>}
   */
  async function renderOrderList(response) {
    const shown = await displayOrdersFromDb(response);
    if (!shown && response && response.orderNumbers && response.orderNumbers.length > 0) {
      await view.displayOrderNumbers(response.orderNumbers, response.additionalFields);
    }
  }

  function loadCacheOnMainPage() {
    chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.GET_PROGRESS }, function (response) {
      renderOrderList(response).then(() => {
        if (response && response.orderNumbers && response.orderNumbers.length > 4) {
          view.maybeShowRatingHint();
        }
      });
    });
  }

  function updateProgress() {
    chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.GET_PROGRESS }, function (response) {
      if (!response) return;

      if (response.isCollecting) {
        app.collectionInProgress = true;
        setCollectionButtonsState({ running: true });
        view.updateProgressUI(response.currentPage, response.pageLimit, true);
        // Checkboxes are disabled during collection (below), so the order
        // list re-render always lands on 0 selected — updateDownloadButtonsState
        // (called from within displayOrderNumbers) already reflects that.
        renderOrderList(response);
        setTimeout(updateProgress, 1000);
        setCheckboxesDisabled(true);
      } else {
        app.collectionInProgress = false;
        view.updateProgressUI(response.currentPage, response.pageLimit, false);
        renderOrderList(response);
        setCollectionButtonsState({ running: false, startLabel: "Start Collection" });
        setCheckboxesDisabled(false);
      }
    });
  }

  Sidepanel.actions = {
    isOperationRunning,
    switchToWalmartOrdersTab,
    showOffTabWarning,
    checkCurrentTab,
    handleStartCollection,
    handleStopCollection,
    stopCollection,
    displayOrdersFromDb,
    renderOrderList,
    loadCacheOnMainPage,
    updateProgress,
  };
})();
