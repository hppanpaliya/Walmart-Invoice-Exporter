(() => {
  const Sidepanel = window.Sidepanel || (window.Sidepanel = {});
  const app = Sidepanel.state.app;
  const view = Sidepanel.view;

  /**
   * Inline, dismissible replacement for the blocking alert() guards below
   * ("downloads in progress" / "select at least one order") — same trigger
   * conditions, same message text, just non-blocking. Reuses one banner id
   * so a fresh guard message replaces any stale one instead of stacking.
   * @param {string} message
   */
  function showGuardBanner(message) {
    view.renderStatusBanner("downloadGuardBanner", {
      variant: "warning",
      message,
      dismissible: true,
    });
  }

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

  /**
   * Run the fetch/export pipeline over each selected order in order,
   * reporting determinate progress via the given callback instead of
   * writing into an ad hoc div (spec §5.2: "Progress via a persistent
   * ProgressBar + StatusLine, not injected timed divs"). Cancellation
   * (spec §5.2 "Cancel") is cooperative: something outside this loop sets
   * app.downloadInProgress = false (the Cancel button, or the existing
   * operation-in-progress nav guard), and the loop notices before its next
   * iteration.
   * @param {Object} params
   * @param {string[]} params.selectedOrders
   * @param {string} params.actionText
   * @param {Object} params.options
   * @param {Function} params.onOrder - async (orderNumber, options) => data
   * @param {string} params.errorPrefix
   * @param {Function} [params.onProgress] - (current, total, orderNumber, actionText) => void
   * @returns {Promise<{failedOrders: string[], cancelled: boolean}>}
   */
  async function runDownloadQueue({ selectedOrders, actionText, options, onOrder, errorPrefix, onProgress }) {
    const failedOrders = [];

    for (let i = 0; i < selectedOrders.length; i++) {
      if (!app || !app.downloadInProgress) {
        return { failedOrders, cancelled: true };
      }

      const orderNumber = selectedOrders[i];
      if (onProgress) {
        onProgress(i + 1, selectedOrders.length, orderNumber, actionText);
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

  /**
   * Whether Excel exports should route through the legacy pre-6.18
   * single-sheet writers (spec §5.3). Additive opt-in, default off — the
   * current Orders+Items writer stays the untouched default. Only Excel is
   * affected; every other format ignores this flag entirely.
   */
  function shouldUseLegacyExcel() {
    return Boolean(app && app.legacyExcel);
  }

  /** Human-readable format name for result banners, e.g. "Exported 12 orders (Excel)". */
  function formatDisplayName(format) {
    switch (format) {
      case CONSTANTS.EXPORT_FORMATS.CSV:
        return "CSV";
      case CONSTANTS.EXPORT_FORMATS.JSON:
        return "JSON";
      case CONSTANTS.EXPORT_FORMATS.RECEIPT:
        return "Printable receipt";
      case CONSTANTS.EXPORT_FORMATS.PDF:
        return "PDF";
      default:
        return "Excel";
    }
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
    const xlsxWriter = shouldUseLegacyExcel() ? convertMultipleOrdersToXlsxLegacy : convertMultipleOrdersToXlsx;
    await xlsxWriter(collectedOrdersData, ExcelJS, `${baseName}.xlsx`, {
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
    const xlsxWriter = shouldUseLegacyExcel() ? convertToXlsxLegacy : convertToXlsx;
    await xlsxWriter(data, ExcelJS, { mode: "single", includeThumbnails: shouldIncludeThumbnails() });
  }

  /**
   * Render the download result as an in-panel Banner (spec §5.2): success
   * auto-dismisses; partial/full failure gets a "Retry failed" action that
   * re-runs the pipeline scoped to just the failed orders. Reuses the one
   * "downloadResultBanner" id so a fresh result replaces any stale one.
   * @param {Object} params
   * @param {'success'|'danger'|'info'} params.variant
   * @param {string} params.message - Pre-escaped/safe HTML.
   * @param {string[]} [params.retryOrders] - When non-empty, adds "Retry failed".
   */
  function showDownloadResultBanner({ variant, message, retryOrders }) {
    const hasRetry = Array.isArray(retryOrders) && retryOrders.length > 0;
    const banner = view.renderStatusBanner("downloadResultBanner", {
      variant,
      message,
      dismissible: true,
      actionHtml: hasRetry ? '<button type="button" class="retry-failed-btn">Retry failed</button>' : "",
    });
    if (!banner) return;

    if (hasRetry) {
      const retryButton = banner.querySelector(".retry-failed-btn");
      if (retryButton) {
        retryButton.addEventListener("click", () => {
          view.clearStatusBanner("downloadResultBanner");
          downloadSelectedOrders(app && app.exportMode, retryOrders);
        });
      }
    }

    if (variant === "success") {
      setTimeout(() => view.clearStatusBanner("downloadResultBanner"), CONSTANTS.TIMING.SUCCESS_DISPLAY_DURATION);
    }
  }

  /**
   * The two-button download pipeline (spec §5.2). Per selected order:
   * IndexedDB invoice → else fetch (unchanged dual-extraction) → persist →
   * export — either combined into one file ("single") or one file per
   * order ("multiple"). Also powers "Retry failed" by accepting an
   * explicit order list instead of reading the checkboxes.
   * @param {string} [mode] - CONSTANTS.EXPORT_MODES.SINGLE|MULTIPLE. When
   *   given, becomes the newly-persisted app.exportMode — clicking a
   *   button sets the mode, then runs this same pipeline (spec §5.2).
   * @param {string[]} [orderNumbersOverride] - Explicit orders to run
   *   (used by "Retry failed"); defaults to the checked checkboxes.
   */
  async function downloadSelectedOrders(mode, orderNumbersOverride) {
    try {
      if (app && app.downloadInProgress) {
        showGuardBanner("Downloads are already in progress. Please wait.");
        return;
      }

      if (mode) {
        app.exportMode = mode;
        chrome.storage.local.set({ exportMode: mode });
      }
      const activeMode = (app && app.exportMode) || CONSTANTS.EXPORT_MODES.MULTIPLE;

      const selectedOrders =
        Array.isArray(orderNumbersOverride) && orderNumbersOverride.length > 0
          ? orderNumbersOverride
          : getSelectedOrderNumbers();

      if (selectedOrders.length === 0) {
        showGuardBanner("Select at least one order to download.");
        return;
      }

      const pressedButtonId =
        activeMode === CONSTANTS.EXPORT_MODES.SINGLE ? "singleFileDownload" : "multiFileDownload";
      const otherButtonId =
        activeMode === CONSTANTS.EXPORT_MODES.SINGLE ? "multiFileDownload" : "singleFileDownload";
      const pressedButton = document.getElementById(pressedButtonId);
      const otherButton = document.getElementById(otherButtonId);

      if (app) {
        app.downloadInProgress = true;
      }
      view.setButtonLoading(pressedButton, true);
      if (otherButton) {
        otherButton.disabled = true;
      }
      view.clearStatusBanner("downloadResultBanner");
      view.showDownloadProgress(0, selectedOrders.length, {
        onCancel: () => {
          if (app) app.downloadInProgress = false;
        },
      });

      let extractionWarningsDetected = false;
      const formatLabel = formatDisplayName(getExportFormat());
      const onProgress = (current, total, orderNumber, actionText) => {
        view.updateDownloadProgress(current, total, `${actionText} ${current} / ${total} (#${orderNumber})`);
      };

      try {
        if (activeMode === CONSTANTS.EXPORT_MODES.SINGLE) {
          const collectedOrdersData = [];
          const { failedOrders, cancelled } = await runDownloadQueue({
            selectedOrders,
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
            onProgress,
          });

          if (cancelled) {
            showDownloadResultBanner({ variant: "info", message: "Download cancelled." });
            return;
          }

          // Warn once (not per order) when any order came back with blank fields.
          if (extractionWarningsDetected) {
            view.showExtractionWarning();
          }

          try {
            await exportCombinedOrders(collectedOrdersData);
          } catch (e) {
            console.error("Failed to export to XLSX:", e);
            showDownloadResultBanner({ variant: "danger", message: `Export failed: ${escapeHtml(e.message)}` });
            return;
          }

          if (failedOrders.length === 0) {
            const count = collectedOrdersData.length;
            showDownloadResultBanner({
              variant: "success",
              message: `Exported ${count} order${count === 1 ? "" : "s"} (${formatLabel})`,
            });
            view.maybeShowRatingHint();
          } else {
            showDownloadResultBanner({
              variant: "danger",
              message: `${collectedOrdersData.length} of ${selectedOrders.length} exported — ${failedOrders.length} failed (${escapeHtml(formatFailedOrders(failedOrders))})`,
              retryOrders: failedOrders,
            });
          }
        } else {
          const { failedOrders, cancelled } = await runDownloadQueue({
            selectedOrders,
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
            onProgress,
          });

          if (cancelled) {
            showDownloadResultBanner({ variant: "info", message: "Download cancelled." });
            return;
          }

          // Warn once (not per order) when any order came back with blank fields.
          if (extractionWarningsDetected) {
            view.showExtractionWarning();
          }

          const succeeded = selectedOrders.length - failedOrders.length;
          if (failedOrders.length === 0) {
            showDownloadResultBanner({
              variant: "success",
              message: `Exported ${succeeded} order${succeeded === 1 ? "" : "s"} (${formatLabel})`,
            });
            view.maybeShowRatingHint();
          } else {
            showDownloadResultBanner({
              variant: "danger",
              message: `${succeeded} of ${selectedOrders.length} exported — ${failedOrders.length} failed (${escapeHtml(formatFailedOrders(failedOrders))})`,
              retryOrders: failedOrders,
            });
          }
        }
      } catch (error) {
        console.error("Download error:", error);
        showDownloadResultBanner({
          variant: "danger",
          message: "An error occurred during the download. Some orders may have failed.",
        });
      } finally {
        await OrderDataFetcher.cleanup();
        view.hideDownloadProgress();
        view.setButtonLoading(pressedButton, false);
        if (app) {
          app.downloadInProgress = false;
        }
        view.updateDownloadButtonsState();
      }
    } catch (outerError) {
      console.error("Error in downloadSelectedOrders:", outerError);
    }
  }

  Sidepanel.download = {
    OrderDataFetcher,
    downloadSelectedOrders,
    exportCombinedOrders,
    exportOneOrder,
  };
})();
