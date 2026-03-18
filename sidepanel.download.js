(() => {
  const Sidepanel = window.Sidepanel || (window.Sidepanel = {});
  const app = Sidepanel.state.app;
  const view = Sidepanel.view;

  const OrderDataFetcher = (() => {
    let downloadTab = null;

    const buildOrderUrls = (orderNumber) => {
      const baseUrl = `${CONSTANTS.URLS.WALMART_ORDERS}/${orderNumber}`;
      const isLongOrderNumber = orderNumber.length >= 20;
      if (isLongOrderNumber) {
        return [`${baseUrl}?storePurchase=true`, baseUrl];
      }
      return [baseUrl, `${baseUrl}?storePurchase=true`];
    };

    const ensureTab = async (url) => {
      if (!downloadTab) {
        downloadTab = await ChromeApi.tabsCreate({ url, active: false });
        return downloadTab;
      }

      try {
        await ChromeApi.tabsGet(downloadTab.id);
        await ChromeApi.tabsUpdate(downloadTab.id, { url });
      } catch (error) {
        downloadTab = await ChromeApi.tabsCreate({ url, active: false });
      }

      return downloadTab;
    };

    const createTabLoadWaiter = (tabId) => {
      let listener = null;
      const promise = new Promise((resolve) => {
        listener = (updatedTabId, info) => {
          if (updatedTabId === tabId && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });

      const cleanup = () => {
        if (listener) {
          chrome.tabs.onUpdated.removeListener(listener);
          listener = null;
        }
      };

      return { promise, cleanup };
    };

    const fetchFromUrl = async (orderNumber, url, options = {}) => {
      const { timeoutMs = CONSTANTS.TIMING.DOWNLOAD_TIMEOUT, stabilizeDelayMs = 1000 } = options;
      const tab = await ensureTab(url);

      const { promise, cleanup } = createTabLoadWaiter(tab.id);
      try {
        await promiseWithTimeout(promise, timeoutMs, `Timeout loading order #${orderNumber}`);
      } finally {
        cleanup();
      }

      try {
        await ChromeApi.tabsSendMessage(tab.id, { action: CONSTANTS.MESSAGES.BLOCK_IMAGES });
      } catch (error) {
        console.error("Error blocking images:", error);
      }

      await delay(stabilizeDelayMs);

      const response = await promiseWithTimeout(
        ChromeApi.tabsSendMessage(tab.id, { method: CONSTANTS.MESSAGES.GET_ORDER_DATA }),
        timeoutMs,
        `Timeout getting data for order #${orderNumber}`
      );

      if (!response || !response.data) {
        throw new Error(`No data received for order #${orderNumber}`);
      }

      await cacheInvoice(orderNumber, response.data);
      view.updateOrderCacheStatus(orderNumber);
      return response.data;
    };

    const fetchOrderData = async (orderNumber, options = {}) => {
      const cachedData = await getCachedInvoice(orderNumber);
      if (cachedData) {
        view.updateOrderCacheStatus(orderNumber);
        return cachedData;
      }

      const [primaryUrl, fallbackUrl] = buildOrderUrls(orderNumber);
      try {
        return await fetchFromUrl(orderNumber, primaryUrl, options);
      } catch (error) {
        console.error(`Primary fetch failed for order #${orderNumber}:`, error);
        return await fetchFromUrl(orderNumber, fallbackUrl, options);
      }
    };

    const cleanup = async () => {
      if (!downloadTab) return;
      try {
        await ChromeApi.tabsRemove(downloadTab.id);
      } catch (error) {
        // Tab may already be closed
      }
      downloadTab = null;
    };

    return { fetchOrderData, cleanup };
  })();

  function formatFailedOrders(failedOrders) {
    return failedOrders.map((order) => `#${order}`).join(", ");
  }

  function showTimedProgressMessage(progressDiv, messageHtml, durationMs) {
    if (!progressDiv) return;
    progressDiv.innerHTML = messageHtml;
    setTimeout(() => {
      if (progressDiv.parentNode) {
        progressDiv.remove();
      }
    }, durationMs);
  }

  async function runDownloadQueue({ selectedOrders, progressDiv, actionText, options, onOrder, errorPrefix }) {
    const failedOrders = [];

    for (let i = 0; i < selectedOrders.length; i++) {
      if (!app || !app.downloadInProgress) {
        if (progressDiv && progressDiv.parentNode) {
          progressDiv.remove();
        }
        return { failedOrders, cancelled: true };
      }

      const orderNumber = selectedOrders[i];
      if (progressDiv) {
        progressDiv.innerHTML = createProgressMessage(
          i + 1,
          selectedOrders.length,
          actionText,
          orderNumber
        );
      }

      try {
        await onOrder(orderNumber, options);
      } catch (error) {
        console.error(`${errorPrefix} #${orderNumber}:`, error);
        failedOrders.push(orderNumber);
      }

      await delay(CONSTANTS.TIMING.RETRY_DELAY);
    }

    return { failedOrders, cancelled: false };
  }

  async function downloadSelectedOrders() {
    try {
      if (app && app.downloadInProgress) {
        alert("Downloads are already in progress. Please wait.");
        return;
      }

      const selectedOrders = getSelectedOrderNumbers();
      if (selectedOrders.length === 0) {
        alert("Please select at least one order to download.");
        return;
      }

      const downloadButton = document.getElementById("downloadButton");
      if (downloadButton) {
        downloadButton.disabled = true;
        view.setButtonLoading(downloadButton, true);
      }

      if (app) {
        app.downloadInProgress = true;
      }

      const progressDiv = createDownloadProgressElement();

      try {
        if (app && app.exportMode === CONSTANTS.EXPORT_MODES.SINGLE) {
          const collectedOrdersData = [];
          const { failedOrders, cancelled } = await runDownloadQueue({
            selectedOrders,
            progressDiv,
            actionText: CONSTANTS.TEXT.COLLECTING,
            options: { timeoutMs: CONSTANTS.TIMING.COLLECTION_TIMEOUT, stabilizeDelayMs: CONSTANTS.TIMING.PAGE_LOAD_WAIT },
            errorPrefix: "Failed to collect data for order",
            onOrder: async (orderNumber, options) => {
              const data = await OrderDataFetcher.fetchOrderData(orderNumber, options);
              collectedOrdersData.push(data);
            },
          });

          if (cancelled) return;

          try {
            await convertMultipleOrdersToXlsx(collectedOrdersData, ExcelJS, "Walmart_Orders.xlsx");
          } catch (e) {
            console.error("Failed to export to XLSX:", e);
            showTimedProgressMessage(
              progressDiv,
              createErrorMessage(`Export failed: ${e.message}`),
              CONSTANTS.TIMING.EXPORT_FAIL_DISPLAY
            );
            return;
          }

          if (failedOrders.length === 0) {
            showTimedProgressMessage(
              progressDiv,
              createSuccessMessage(CONSTANTS.TEXT.EXPORT_SUCCESS),
              CONSTANTS.TIMING.SUCCESS_DISPLAY_DURATION
            );
            view.maybeShowRatingHint();
          } else {
            showTimedProgressMessage(
              progressDiv,
              createErrorMessage(
                `Export completed with ${failedOrders.length} failures: ${formatFailedOrders(failedOrders)}`
              ),
              CONSTANTS.TIMING.ERROR_DISPLAY_DURATION
            );
          }
        } else {
          const { failedOrders, cancelled } = await runDownloadQueue({
            selectedOrders,
            progressDiv,
            actionText: CONSTANTS.TEXT.DOWNLOADING,
            options: { timeoutMs: CONSTANTS.TIMING.DOWNLOAD_TIMEOUT, stabilizeDelayMs: 1000 },
            errorPrefix: "Error downloading order",
            onOrder: async (orderNumber, options) => {
              const data = await OrderDataFetcher.fetchOrderData(orderNumber, options);
              convertToXlsx(data, ExcelJS, { mode: "single" });
            },
          });

          if (cancelled) return;

          if (failedOrders.length === 0) {
            showTimedProgressMessage(
              progressDiv,
              createSuccessMessage("All downloads completed successfully!"),
              CONSTANTS.TIMING.SUCCESS_DISPLAY_DURATION
            );
            view.maybeShowRatingHint();
          } else {
            showTimedProgressMessage(
              progressDiv,
              createErrorMessage(
                `Downloads completed with ${failedOrders.length} failed orders:\nFailed orders: ${formatFailedOrders(failedOrders)}`
              ),
              CONSTANTS.TIMING.ERROR_DISPLAY_DURATION
            );
          }
        }
      } catch (error) {
        console.error("Download error:", error);
        alert("An error occurred during download process. Some orders may have failed.");
      } finally {
        await OrderDataFetcher.cleanup();
        if (downloadButton) {
          downloadButton.disabled = false;
          view.setButtonLoading(downloadButton, false);
        }
        if (app) {
          app.downloadInProgress = false;
        }
      }
    } catch (outerError) {
      console.error("Error in downloadSelectedOrders:", outerError);
    }
  }

  Sidepanel.download = {
    OrderDataFetcher,
    downloadSelectedOrders,
  };
})();
