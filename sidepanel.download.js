(() => {
  const Sidepanel = window.Sidepanel || (window.Sidepanel = {});
  const app = Sidepanel.state.app;
  const view = Sidepanel.view;

  const OrderDataFetcher = (() => {
    let downloadTab = null;
    // Older cached invoices (pre-v3 item-dedup fix) may contain doubled
    // items with $0.00 prices — they are re-fetched, never trusted.
    const MIN_ORDER_SCHEMA_VERSION = CONSTANTS.ORDER_SCHEMA_VERSION;

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

    // Valid under any schema version — used to decide whether stale cached
    // data is still worth returning when a forced re-fetch fails.
    const isUsableInvoiceData = (data) => {
      if (!data || typeof data !== "object") {
        return false;
      }

      const normalizedOrderNumber = String(data.orderNumber || "").replace(/[^\d]/g, "");
      const orderTotal = String(data.orderTotal || "").trim();

      return hasUsableOrderItems(data) && (Boolean(normalizedOrderNumber) || Boolean(orderTotal));
    };

    const isValidInvoiceData = (data) => {
      const schemaVersion = Number(data?.schemaVersion || 0);
      return schemaVersion >= MIN_ORDER_SCHEMA_VERSION && isUsableInvoiceData(data);
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

      // IndexedDB is the only durable store for invoices now (spec §4.1) —
      // no more chrome.storage invoice cache to duplicate this into.
      try {
        await OrderDb.putInvoice(orderNumber, response.data);
      } catch (error) {
        console.warn(`Failed to persist invoice #${orderNumber} to order DB:`, error);
      }
      view.updateOrderCacheStatus(orderNumber);
      return response.data;
    };

    const fetchOrderData = async (orderNumber, options = {}) => {
      // Fast path (spec §4.2): an already-downloaded, current-schema
      // invoice sits in IndexedDB — return it and open NO tab at all. This
      // is what makes re-exporting an already-downloaded order instant,
      // even long after the old 24h chrome.storage cache would have
      // expired.
      let storedInvoice = null;
      try {
        const record = await OrderDb.getOrder(orderNumber);
        storedInvoice = (record && record.invoice) || null;
      } catch (error) {
        console.warn(`Order DB unavailable for fast-path lookup of #${orderNumber}:`, error);
      }

      if (storedInvoice && isValidInvoiceData(storedInvoice)) {
        view.updateOrderCacheStatus(orderNumber);
        return storedInvoice;
      }

      // Nothing usable stored yet, or it predates the current schema —
      // fetch live, but keep the stale record around unused unless every
      // live fetch fails, so a failed re-fetch never destroys usable data
      // (fetchFromUrl overwrites the DB record on success).
      const [primaryUrl, fallbackUrl] = buildOrderUrls(orderNumber);
      try {
        return await fetchFromUrl(orderNumber, primaryUrl, options);
      } catch (error) {
        console.error(`Primary fetch failed for order #${orderNumber}:`, error);
        try {
          return await fetchFromUrl(orderNumber, fallbackUrl, options);
        } catch (fallbackError) {
          if (isUsableInvoiceData(storedInvoice)) {
            console.warn(
              `Both fetches failed for order #${orderNumber}; falling back to stale stored data`
            );
            view.updateOrderCacheStatus(orderNumber);
            return storedInvoice;
          }
          throw fallbackError;
        }
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

  /** Currently selected export format (XLSX default). */
  function getExportFormat() {
    return (app && app.exportFormat) || CONSTANTS.EXPORT_FORMATS.XLSX;
  }

  /** Currently selected CSV preset (generic orders + items files by default). */
  function getCsvPreset() {
    return (app && app.csvPreset) || CONSTANTS.CSV_PRESETS.GENERIC;
  }

  /** Whether the user opted in to thumbnail embedding (Excel only, default off). */
  function shouldIncludeThumbnails() {
    return Boolean(app && app.includeThumbnails);
  }

  /** Export all collected orders combined, honoring the selected format. */
  async function exportCombinedOrders(collectedOrdersData, baseName = "Walmart_Orders") {
    const format = getExportFormat();
    if (format === CONSTANTS.EXPORT_FORMATS.CSV) {
      const preset = getCsvPreset();
      if (preset !== CONSTANTS.CSV_PRESETS.GENERIC) {
        const presetLabel = preset === CONSTANTS.CSV_PRESETS.XERO ? "Xero" : "QuickBooks";
        // Accounting presets emit one bank-statement style file.
        convertOrdersToAccountingCsv(collectedOrdersData, preset, `${baseName}_${presetLabel}.csv`);
        return;
      }
      await convertOrdersToCsv(collectedOrdersData, {
        ordersFilename: `${baseName}.csv`,
        itemsFilename: `${baseName}_Items.csv`,
      });
      return;
    }
    if (format === CONSTANTS.EXPORT_FORMATS.JSON) {
      convertOrdersToJson(collectedOrdersData, `${baseName}.json`);
      return;
    }
    if (format === CONSTANTS.EXPORT_FORMATS.RECEIPT) {
      convertOrdersToReceiptHtml(collectedOrdersData, `${baseName}_Receipts.html`);
      return;
    }
    if (format === CONSTANTS.EXPORT_FORMATS.PDF) {
      convertOrdersToReceiptPdf(collectedOrdersData, `${baseName}_Receipts.pdf`);
      return;
    }
    await convertMultipleOrdersToXlsx(collectedOrdersData, ExcelJS, `${baseName}.xlsx`, {
      includeThumbnails: shouldIncludeThumbnails(),
    });
  }

  /** Export one order as its own file, honoring the selected format. */
  async function exportOneOrder(data) {
    const format = getExportFormat();
    const orderNumber = data.orderNumber || "order";
    if (format === CONSTANTS.EXPORT_FORMATS.CSV) {
      const preset = getCsvPreset();
      if (preset !== CONSTANTS.CSV_PRESETS.GENERIC) {
        const presetLabel = preset === CONSTANTS.CSV_PRESETS.XERO ? "Xero" : "QuickBooks";
        convertOrdersToAccountingCsv([data], preset, `Order_${orderNumber}_${presetLabel}.csv`);
        return;
      }
      await convertOrdersToCsv([data], {
        ordersFilename: `Order_${orderNumber}.csv`,
        itemsFilename: `Order_${orderNumber}_Items.csv`,
      });
      return;
    }
    if (format === CONSTANTS.EXPORT_FORMATS.JSON) {
      convertOrdersToJson(data, `Order_${orderNumber}.json`);
      return;
    }
    if (format === CONSTANTS.EXPORT_FORMATS.RECEIPT) {
      convertOrdersToReceiptHtml(data, `Order_${orderNumber}_Receipt.html`);
      return;
    }
    if (format === CONSTANTS.EXPORT_FORMATS.PDF) {
      convertOrdersToReceiptPdf(data, `Order_${orderNumber}_Receipt.pdf`);
      return;
    }
    await convertToXlsx(data, ExcelJS, { mode: "single", includeThumbnails: shouldIncludeThumbnails() });
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
    // Date-only strings parse as UTC midnight and would render a day early
    // in US timezones — construct those as local dates instead.
    const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate).trim());
    const parsed = dateOnlyMatch
      ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]))
      : new Date(isoDate);
    if (isNaN(parsed.getTime())) return String(isoDate);
    return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  /**
   * Quick Export: INSTANTLY re-exports the selected orders that have already
   * been downloaded (trusted stored invoices) in exactly the same format and
   * layout as Download Selected — no pages opened, nothing synthesized.
   * Orders that were never downloaded are skipped and reported, never
   * fabricated from partial data.
   */
  async function quickExportSummaries() {
    if (app && app.downloadInProgress) {
      alert("Downloads are already in progress. Please wait.");
      return;
    }
    if (app && app.collectionInProgress) {
      alert("Collection is still running. Wait for it to finish so the summary is complete.");
      return;
    }

    // Same contract as Download: operate on the SELECTED orders only.
    const selectedOrders = getSelectedOrderNumbers();
    if (selectedOrders.length === 0) {
      alert("Please select at least one order to quick export.");
      return;
    }

    const quickExportButton = document.getElementById("quickExportButton");
    view.setButtonLoading(quickExportButton, true);
    const progressDiv = createDownloadProgressElement();
    if (app) {
      app.downloadInProgress = true;
    }

    try {
      const response = await getCollectionSnapshot();
      let orderNumbers = (response && response.orderNumbers) || [];
      let orderSummaries = (response && response.orderSummaries) || {};
      let additionalFields = (response && response.additionalFields) || {};

      if (orderNumbers.length === 0) {
        // The 24h collection cache is empty — fall back to the durable DB.
        try {
          const records = await OrderDb.getAllOrders();
          const withSummaries = records.filter((record) => record.summary);
          if (withSummaries.length > 0) {
            withSummaries.sort((a, b) => String(b.orderDate).localeCompare(String(a.orderDate)));
            orderNumbers = withSummaries.map((record) => record.orderNumber);
            orderSummaries = Object.fromEntries(
              withSummaries.map((record) => [record.orderNumber, record.summary])
            );
            additionalFields = Object.fromEntries(
              withSummaries.map((record) => [record.orderNumber, record.title || ""])
            );
          }
        } catch (error) {
          console.warn("Order DB unavailable for Quick Export fallback:", error);
        }
      }

      // Strictly the selected orders — nothing else ever exports.
      const selectedSet = new Set(selectedOrders);
      orderNumbers = orderNumbers.filter((orderNumber) => selectedSet.has(orderNumber));

      if (orderNumbers.length === 0) {
        showTimedProgressMessage(
          progressDiv,
          createErrorMessage("No data found for the selected orders. Run Start Collection first."),
          CONSTANTS.TIMING.EXPORT_FAIL_DISPLAY
        );
        return;
      }

      // Quick Export only exports TRUSTED stored invoices — it never
      // synthesizes rows from partial list data (that produced garbage).
      const ordersData = [];
      let skippedCount = 0;
      try {
        for (const orderNumber of orderNumbers) {
          const record = await OrderDb.getOrder(orderNumber);
          // Pre-v3 stored invoices carry the doubled-items bug — treat those
          // orders as not-yet-downloaded rather than exporting corrupt data.
          if (record?.invoice && Number(record.invoice.schemaVersion || 0) >= CONSTANTS.ORDER_SCHEMA_VERSION) {
            ordersData.push({ ...record.invoice, dataSource: "invoice" });
          } else {
            skippedCount++;
          }
        }
      } catch (error) {
        console.warn("Order DB unavailable for Quick Export:", error);
      }

      if (ordersData.length === 0) {
        showTimedProgressMessage(
          progressDiv,
          createErrorMessage(
            "None of the selected orders have been downloaded yet. Quick Export instantly re-exports downloaded orders — run \"Download Selected\" on them once first."
          ),
          CONSTANTS.TIMING.ERROR_DISPLAY_DURATION
        );
        return;
      }

      // Same layout AND same export-mode semantics as Download Selected.
      if (app && app.exportMode === CONSTANTS.EXPORT_MODES.MULTIPLE) {
        for (let i = 0; i < ordersData.length; i++) {
          progressDiv.innerHTML = createProgressMessage(
            i + 1,
            ordersData.length,
            "Quick exporting order",
            ordersData[i].orderNumber
          );
          await exportOneOrder(ordersData[i]);
          await delay(CONSTANTS.TIMING.RETRY_DELAY);
        }
      } else {
        await exportCombinedOrders(ordersData, "Walmart_Orders_Quick");
      }

      if (skippedCount > 0) {
        showTimedProgressMessage(
          progressDiv,
          createWarningMessage(
            `Exported ${ordersData.length} downloaded orders.\nSkipped ${skippedCount} selected orders that haven't been downloaded yet — run "Download Selected" on them once, then Quick Export includes them instantly.`
          ),
          CONSTANTS.TIMING.ERROR_DISPLAY_DURATION
        );
      } else {
        showTimedProgressMessage(
          progressDiv,
          createSuccessMessage(CONSTANTS.TEXT.QUICK_EXPORT_SUCCESS),
          CONSTANTS.TIMING.SUCCESS_DISPLAY_DURATION
        );
      }
      view.maybeShowRatingHint();
    } catch (error) {
      console.error("Quick Export failed:", error);
      showTimedProgressMessage(
        progressDiv,
        createErrorMessage(`Quick Export failed: ${error.message}`),
        CONSTANTS.TIMING.ERROR_DISPLAY_DURATION
      );
    } finally {
      if (app) {
        app.downloadInProgress = false;
      }
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
            await exportCombinedOrders(collectedOrdersData);
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
              await exportOneOrder(data);
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
