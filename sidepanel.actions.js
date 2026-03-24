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
          view.displayOrderNumbers([orderNumber]);
          view.applyLayout(view.UI_MODES.SINGLE_ORDER);
        } else {
          view.applyLayout(view.UI_MODES.MAIN_ORDERS);
          app.currentOrdersUrl = url;
          loadCacheOnMainPage();
        }
      } else {
        app.currentOrdersUrl = null;
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

  function loadCacheOnMainPage() {
    chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.GET_PROGRESS }, function (response) {
      if (response && response.orderNumbers && response.orderNumbers.length > 0) {
        view.displayOrderNumbers(response.orderNumbers, response.additionalFields);

        const cachePages = Object.keys(response.pagesCached || {}).length;
        const cacheInfo = document.createElement("div");
        cacheInfo.className = "cache-info";

        let cacheTimeInfo = "";
        if (response.pagesCached && Object.keys(response.pagesCached).length > 0) {
          const timestamps = Object.values(response.pagesCached)
            .map((page) => page.timestamp)
            .filter((ts) => ts);

          if (timestamps.length > 0) {
            const earliestTimestamp = Math.min(...timestamps);
            const cacheDate = new Date(earliestTimestamp);
            const formattedDate = cacheDate.toLocaleString();
            cacheTimeInfo = `<div class="cache-time">Cached on: ${formattedDate}</div>`;
          }
        }

        cacheInfo.innerHTML = `
          <div>
            <span>${CONSTANTS.TEXT.USING_CACHE} ${response.orderNumbers.length} ${CONSTANTS.TEXT.ORDERS} ${cachePages} ${CONSTANTS.TEXT.PAGES}</span>
            ${cacheTimeInfo}
          </div>
        `;

        const cardClass = document.querySelector(".card");
        if (cardClass && !cardClass.querySelector(".cache-info")) {
          cardClass.appendChild(cacheInfo);
        }

        if (response.orderNumbers.length > 4) {
          view.maybeShowRatingHint();
        }
      }
    });
  }

  function updateProgress() {
    chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.GET_PROGRESS }, function (response) {
      if (response && response.isCollecting) {
        app.collectionInProgress = true;
        setCollectionButtonsState({ running: true });
        view.updateProgressUI(response.currentPage, response.pageLimit, true);
        view.displayOrderNumbers(response.orderNumbers, response.additionalFields);
        setTimeout(updateProgress, 1000);
        setCheckboxesDisabled(true);
      } else if (response) {
        app.collectionInProgress = false;
        view.updateProgressUI(response.currentPage, response.pageLimit, false);
        view.displayOrderNumbers(response.orderNumbers, response.additionalFields);
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
    loadCacheOnMainPage,
    updateProgress,
  };
})();
