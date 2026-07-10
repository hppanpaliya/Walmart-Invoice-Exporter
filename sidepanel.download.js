(() => {
  const Sidepanel = window.Sidepanel || (window.Sidepanel = {});
  const app = Sidepanel.state.app;
  const view = Sidepanel.view;

  const OrderDataFetcher = (() => {
    let downloadTab = null;
    const MIN_ORDER_SCHEMA_VERSION = 1;

    const hasUsableOrderItems = (data) => {
      if (!Array.isArray(data?.items) || data.items.length === 0) {
        return false;
      }

      return data.items.some((item) => {
        const productName = String(item?.productName || "").trim();
        const quantity = String(item?.quantity || "").trim();
        const price = String(item?.price || "").trim();
        return Boolean(productName) && (Boolean(quantity) || Boolean(price));
      });
    };

    const isValidInvoiceData = (data) => {
      if (!data || typeof data !== "object") {
        return false;
      }

      const schemaVersion = Number(data.schemaVersion || 0);
      if (schemaVersion < MIN_ORDER_SCHEMA_VERSION) {
        return false;
      }

      const normalizedOrderNumber = String(data.orderNumber || "").replace(/[^\d]/g, "");
      const orderTotal = String(data.orderTotal || "").trim();

      return hasUsableOrderItems(data) && (Boolean(normalizedOrderNumber) || Boolean(orderTotal));
    };

    const buildOrderUrls = (orderNumber) => {
      const baseUrl = `${CONSTANTS.URLS.WALMART_ORDERS}/${orderNumber}`;
      const isLongOrderNumber = orderNumber.length >= 20;
      if (isLongOrderNumber) {
        return [`${baseUrl}?storePurchase=true`, baseUrl];
      }
      return [baseUrl, `${baseUrl}?storePurchase=true`];
    };

    const createTabLoadWaiter = (tabId, expectedUrl = "") => {
      let listener = null;
      let resolved = false;
      let resolvePromise = () => {};

      const normalizeUrl = (value) => String(value || "").replace(/\/$/, "");

      const cleanup = () => {
        if (listener) {
          chrome.tabs.onUpdated.removeListener(listener);
          listener = null;
        }
      };

      const finish = () => {
        if (resolved) {
          return;
        }
        resolved = true;
        cleanup();
        resolvePromise();
      };

      const promise = new Promise((resolve) => {
        resolvePromise = resolve;
        listener = (updatedTabId, info) => {
          if (updatedTabId === tabId && info.status === "complete") {
            finish();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });

      ChromeApi.tabsGet(tabId)
        .then((tab) => {
          if (
            tab?.status === "complete" &&
            (!expectedUrl || normalizeUrl(tab.url) === normalizeUrl(expectedUrl))
          ) {
            finish();
          }
        })
        .catch(() => {
          if (!resolved) {
            cleanup();
          }
        });

      return { promise, cleanup };
    };

    const waitForTabLoad = async (tab, url, timeoutMs) => {
      const { promise, cleanup } = createTabLoadWaiter(tab.id, url);
      try {
        await promiseWithTimeout(promise, timeoutMs, `Timeout loading ${url}`);
      } finally {
        cleanup();
      }
    };

    const ensureTab = async (url, timeoutMs) => {
      if (!downloadTab) {
        downloadTab = await ChromeApi.tabsCreate({ url, active: false });
        await waitForTabLoad(downloadTab, url, timeoutMs);
        return downloadTab;
      }

      try {
        await ChromeApi.tabsGet(downloadTab.id);
        const { promise, cleanup } = createTabLoadWaiter(downloadTab.id, url);
        try {
          downloadTab = await ChromeApi.tabsUpdate(downloadTab.id, { url });
          await promiseWithTimeout(promise, timeoutMs, `Timeout loading ${url}`);
        } finally {
          cleanup();
        }
      } catch (error) {
        downloadTab = await ChromeApi.tabsCreate({ url, active: false });
        await waitForTabLoad(downloadTab, url, timeoutMs);
      }

      return downloadTab;
    };

    const fetchFromUrl = async (orderNumber, url, options = {}) => {
      const { timeoutMs = CONSTANTS.TIMING.DOWNLOAD_TIMEOUT, stabilizeDelayMs = 1000 } = options;
      const tab = await ensureTab(url, timeoutMs);

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
        if (isValidInvoiceData(cachedData)) {
          view.updateOrderCacheStatus(orderNumber);
          return cachedData;
        }

        // Auto-heal stale cache entries created with outdated selectors.
        await deleteInvoiceCache(orderNumber);
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

  /**
   * Logs any extraction warnings attached to an order's data and reports
   * whether the order looks like it was affected by a Walmart site change.
   * @param {string} orderNumber - The order the data belongs to.
   * @param {object} data - Order data returned by the content script.
   * @returns {boolean} True when the order carries extraction warnings.
   */
  function checkExtractionWarnings(orderNumber, data) {
    const warnings = Array.isArray(data?.extractionWarnings) ? data.extractionWarnings : [];
    if (warnings.length === 0) {
      return false;
    }
    console.warn(`Extraction warnings for order #${orderNumber}:`, warnings);
    return true;
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

  /**
   * Fetch the background collection snapshot (order numbers, titles, summaries).
   * @returns {Promise<Object>} GET_PROGRESS response from the service worker
   */
  function getCollectionSnapshot() {
    return chromeCallbackPromise((callback) =>
      chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.GET_PROGRESS }, callback)
    );
  }

  /**
   * Format an ISO order date for humans (e.g. "Jul 9, 2026").
   * Falls back to the raw value when it does not parse as a date.
   * @param {string} isoDate - ISO 8601 date string from the payload
   * @returns {string}
   */
  function formatSummaryDate(isoDate) {
    if (!isoDate) return "";
    const parsed = new Date(isoDate);
    if (isNaN(parsed.getTime())) return String(isoDate);
    return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  /**
   * Join summary items into a readable list, e.g. "2× Milk; Bread".
   * @param {Array} items - Items from an order summary
   * @returns {string}
   */
  function formatSummaryItemNames(items) {
    if (!Array.isArray(items)) return "";
    return items
      .filter((item) => item && item.name)
      .map((item) => {
        const quantity = Number(item.quantity);
        return quantity > 1 ? `${quantity}× ${item.name}` : item.name;
      })
      .join("; ");
  }

  /**
   * Build Quick Export rows for every collected order. Orders collected via the
   * DOM fallback have no payload summary — those degrade to order number plus
   * the cached title, leaving the remaining cells blank.
   * @param {string[]} orderNumbers - All collected order numbers
   * @param {Object} additionalFields - Order number → title map
   * @param {Object} orderSummaries - Order number → summary map
   * @returns {Object[]} Rows for convertOrderSummariesToXlsx
   */
  function buildQuickExportRows(orderNumbers, additionalFields, orderSummaries) {
    return orderNumbers.map((orderNumber) => {
      const summary = orderSummaries[orderNumber];
      if (!summary) {
        return { orderNumber, itemNames: additionalFields[orderNumber] || "" };
      }
      return {
        orderNumber,
        orderDate: formatSummaryDate(summary.orderDate),
        orderDateIso: summary.orderDate || "",
        itemCount: summary.itemCount,
        itemNames: formatSummaryItemNames(summary.items) || additionalFields[orderNumber] || "",
        status: summary.status || "",
        fulfillment: summary.fulfillmentTypes || "",
        subTotal: summary.subTotal || "",
        driverTip: summary.driverTip || "",
        orderTotal: summary.orderTotal || "",
      };
    });
  }

  /**
   * Export a one-row-per-order summary spreadsheet straight from the collected
   * purchase-history payload — no order detail pages are opened.
   */
  async function quickExportSummaries() {
    if (app && app.downloadInProgress) {
      alert("Downloads are already in progress. Please wait.");
      return;
    }

    const quickExportButton = document.getElementById("quickExportButton");
    view.setButtonLoading(quickExportButton, true);
    const progressDiv = createDownloadProgressElement();

    try {
      const response = await getCollectionSnapshot();
      const orderNumbers = (response && response.orderNumbers) || [];
      if (orderNumbers.length === 0) {
        showTimedProgressMessage(
          progressDiv,
          createErrorMessage("No collected orders to export. Run Start Collection first."),
          CONSTANTS.TIMING.EXPORT_FAIL_DISPLAY
        );
        return;
      }

      const orderSummaries = response.orderSummaries || {};
      const summaryCount = orderNumbers.filter((orderNumber) => orderSummaries[orderNumber]).length;
      if (summaryCount === 0) {
        showTimedProgressMessage(
          progressDiv,
          createErrorMessage(
            "The cached orders have no summary data (they were collected by an older version). Click Clear Cache, run Start Collection again, then retry Quick Export."
          ),
          CONSTANTS.TIMING.ERROR_DISPLAY_DURATION
        );
        return;
      }

      const rows = buildQuickExportRows(orderNumbers, response.additionalFields || {}, orderSummaries);
      await convertOrderSummariesToXlsx(rows, ExcelJS);

      const missingCount = orderNumbers.length - summaryCount;
      const message =
        missingCount > 0
          ? `${CONSTANTS.TEXT.QUICK_EXPORT_SUCCESS}\n${missingCount} of ${orderNumbers.length} orders had no summary data — only their order number and title were exported.`
          : CONSTANTS.TEXT.QUICK_EXPORT_SUCCESS;
      showTimedProgressMessage(
        progressDiv,
        createSuccessMessage(message),
        CONSTANTS.TIMING.SUCCESS_DISPLAY_DURATION
      );
      view.maybeShowRatingHint();
    } catch (error) {
      console.error("Quick Export failed:", error);
      showTimedProgressMessage(
        progressDiv,
        createErrorMessage(`Quick Export failed: ${error.message}`),
        CONSTANTS.TIMING.ERROR_DISPLAY_DURATION
      );
    } finally {
      view.setButtonLoading(quickExportButton, false);
    }
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
      let extractionWarningsDetected = false;

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
              if (checkExtractionWarnings(orderNumber, data)) {
                extractionWarningsDetected = true;
              }
              collectedOrdersData.push(data);
            },
          });

          if (cancelled) return;

          // Warn once (not per order) when any order came back with blank fields.
          if (extractionWarningsDetected) {
            view.showExtractionWarning();
          }

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
              if (checkExtractionWarnings(orderNumber, data)) {
                extractionWarningsDetected = true;
              }
              await convertToXlsx(data, ExcelJS, { mode: "single" });
            },
          });

          if (cancelled) return;

          // Warn once (not per order) when any order came back with blank fields.
          if (extractionWarningsDetected) {
            view.showExtractionWarning();
          }

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
    quickExportSummaries,
  };
})();
