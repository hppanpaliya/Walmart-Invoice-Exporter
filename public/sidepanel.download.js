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

  /**
   * Guard against fetching one account's orders while Walmart is signed into a
   * different account — the fetch would hit the wrong session and return the
   * wrong (or no) data. Returns true (and shows an error) when blocked. Only
   * fires when we actually know both accounts and they're real and different;
   * an unknown signed-in account or the untagged/legacy bucket never blocks.
   */
  function fetchAccountMismatchBlocked() {
    const viewed = app && app.accountKey;
    const signedIn = app && app.tabAccountKey;
    const untagged = CONSTANTS.ACCOUNTS && CONSTANTS.ACCOUNTS.UNTAGGED;
    if (!viewed || !signedIn || viewed === untagged || viewed === signedIn) return false;
    view.renderStatusBanner("downloadGuardBanner", {
      variant: "danger",
      message:
        "These orders belong to a different Walmart account than the one signed in. " +
        "Open Walmart and sign into that account (or switch to the signed-in account), then try again.",
      dismissible: true,
    });
    return true;
  }

  const OrderDataFetcher = (() => {
    let downloadTab = null;
    // Whether the reused fast-invoice list tab has had a moment to initialize
    // its content script + main-world bridge. Reset when the tab is closed.
    let fastTabWarmedUp = false;
    // Older cached invoices (pre-v3 item-dedup fix) may contain doubled
    // items with $0.00 prices — they are re-fetched, never trusted.
    const MIN_ORDER_SCHEMA_VERSION = CONSTANTS.ORDER_SCHEMA_VERSION;

    const hasUsableOrderItems = (data) => {
      if (!Array.isArray(data?.items) || data.items.length === 0) {
        return false;
      }

      return data.items.some((item) => {
        const productName = String(item?.productName || "").trim();
        const quantity = String(item?.quantity ?? "").trim();
        const price = String(item?.price ?? "").trim();
        return Boolean(productName) && (Boolean(quantity) || Boolean(price));
      });
    };

    // A truthy scrape can still be an unhydrated page or a different order.
    // Use the same minimum requirements for live, cached and stale invoices
    // so an incomplete result cannot be persisted or exported as a success.
    const invoiceProblems = (data, orderNumber) => {
      if (!data || typeof data !== "object") {
        return ["no invoice data"];
      }
      const problems = [];
      const normalizedOrderNumber = String(data.orderNumber || "").replace(/[^\d]/g, "");
      const expectedOrderNumber = String(orderNumber).replace(/[^\d]/g, "");
      if (!normalizedOrderNumber || normalizedOrderNumber !== expectedOrderNumber) {
        problems.push("missing or mismatched order number");
      }
      // A fully canceled order legitimately has no charged lines.
      const nothingCharged = data.noChargedItems === true && Array.isArray(data.items) && data.items.length === 0;
      if (!nothingCharged && !hasUsableOrderItems(data)) problems.push("no usable items");
      const orderTotal = String(data.orderTotal ?? "").trim();
      const numericTotal = orderTotal.replace(/[^0-9.-]/g, "");
      if (!/\d/.test(numericTotal) || !Number.isFinite(Number(numericTotal))) {
        problems.push("missing or invalid order total");
      }
      return problems;
    };

    const isUsableInvoiceData = (data, orderNumber) => invoiceProblems(data, orderNumber).length === 0;

    const isValidInvoiceData = (data, orderNumber, providerId) => {
      const schemaVersion = Number(data?.schemaVersion || 0);
      const extractionVersionCurrent = Number(data?.walmartExtractionVersion || 0) >= requiredExtractionVersion(providerId);
      return schemaVersion >= MIN_ORDER_SCHEMA_VERSION && extractionVersionCurrent &&
        isUsableInvoiceData(data, orderNumber);
    };

    const requiredExtractionVersion = (providerId) => providerId === 'WALMART_US'
      ? Number(CONSTANTS.WALMART_US_EXTRACTION_VERSION || 1)
      : providerId === 'WALMART_CA' ? Number(CONSTANTS.WALMART_CA_EXTRACTION_VERSION || 1) : 0;

    /** The adapter driving the current export (defaults to WALMART_US). */
    const activeAdapter = () => {
      const id = (app && app.provider) || "WALMART_US";
      return (typeof ProviderRegistry !== "undefined" && ProviderRegistry.getById(id)) || null;
    };

    /** Provider partition used for OrderDb reads/writes in this fetcher. */
    const activeProviderId = () => (app && app.provider) || "WALMART_US";

    /**
     * Resolve the CONCRETE provider partition to use for ONE order.
     *
     * Fast path (the common case, and every single-provider build): the active
     * selection is already a concrete provider id — return app.provider
     * directly with NO DB scan, so Walmart / single-provider behavior is
     * byte-identical to before.
     *
     * Under the combined "All providers" view app.provider is the PROVIDER_ALL
     * sentinel ("__ALL__"), which is NOT a real OrderDb partition — reads and
     * writes against it would hit a non-existent partition. So probe each
     * enabled provider's partition (spec: scopeIds(PROVIDER_ALL)) and return the
     * first one that already holds this order; fall back to WALMART_US when none
     * does (a not-yet-collected order still lands in a sensible partition).
     *
     * Guarded for a test sandbox where Sidepanel.providers is not loaded: with
     * no selector module there is no combined view, so app.provider (or
     * WALMART_US) is authoritative and no scan happens.
     * @param {string} orderNumber
     * @returns {Promise<string>} a concrete provider id
     */
    const resolveProviderId = async (orderNumber) => {
      const providers = Sidepanel.providers;
      if (!providers) {
        return (app && app.provider) || "WALMART_US";
      }

      const active = (app && app.provider) || "WALMART_US";
      if (active !== providers.PROVIDER_ALL) {
        return active;
      }

      let ids = [];
      try {
        ids = await providers.scopeIds(providers.PROVIDER_ALL);
      } catch (error) {
        ids = [];
      }
      for (const id of ids) {
        try {
          const record = await OrderDb.getOrder(orderNumber, id);
          if (record) {
            return id;
          }
        } catch (error) {
          // This partition is unreadable — try the next provider.
        }
      }
      return "WALMART_US";
    };

    /**
     * Candidate order-DETAIL URLs to try, in order, for one order.
     *
     * Delegates to the active adapter so it stays host-agnostic:
     *  - an adapter that exposes orderDetailUrl()/buildDetailUrl() wins;
     *  - otherwise fall back to the adapter's ordersListUrl + '/' + orderNumber.
     *
     * Walmart exposes neither helper, so it takes the fallback, and because its
     * ordersListUrl === CONSTANTS.URLS.WALMART_ORDERS the base is identical to
     * before — including the historic ?storePurchase=true dual-URL ordering,
     * preserved for the Walmart platform (.com/.ca).
     *
     * The optional providerId pins the adapter to the site that owns THIS order
     * (resolved by fetchOrderData) so the combined view uses the right site; for
     * a single active site it resolves to the same adapter as activeAdapter().
     */
    const buildOrderUrls = (orderNumber, providerId) => {
      const adapter =
        (providerId && typeof ProviderRegistry !== "undefined" && ProviderRegistry.getById(providerId)) ||
        activeAdapter();

      if (adapter && typeof adapter.orderDetailUrl === "function") {
        const url = adapter.orderDetailUrl(orderNumber);
        if (url) return [url];
      }
      if (adapter && typeof adapter.buildDetailUrl === "function") {
        const url = adapter.buildDetailUrl(orderNumber);
        if (url) return [url];
      }

      const listUrl = (adapter && adapter.ordersListUrl) || CONSTANTS.URLS.WALMART_ORDERS;
      const baseUrl = `${listUrl}/${orderNumber}`;

      // The Walmart Orchestra platform (.com and .ca) serves in-store receipts
      // behind ?storePurchase=true; keep the historic dual-URL probe order so
      // Walmart's resulting URLs are byte-for-byte identical to before.
      const isWalmartPlatform = /(^|\.)walmart\./i.test(listUrl);
      if (isWalmartPlatform) {
        const isLongOrderNumber = String(orderNumber).length >= 20;
        if (isLongOrderNumber) {
          return [`${baseUrl}?storePurchase=true`, baseUrl];
        }
        return [baseUrl, `${baseUrl}?storePurchase=true`];
      }

      return [baseUrl];
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

    /**
     * Ensure a single reusable tab for FAST invoice fetching. Unlike ensureTab,
     * this never re-navigates: the fast path never loads a per-order page — it
     * fetches each order's HTML in-page — so ANY already-open orders tab works
     * (the content script + main-world bridge run on every walmart.com/orders*
     * URL). Only opens a tab (on the orders list) when none exists yet.
     */
    const ensureFastTab = async (listUrl, timeoutMs) => {
      if (downloadTab) {
        try {
          await ChromeApi.tabsGet(downloadTab.id);
          return downloadTab; // reuse as-is — do NOT navigate it
        } catch (error) {
          downloadTab = null; // it was closed; fall through to create a new one
        }
      }
      downloadTab = await ChromeApi.tabsCreate({ url: listUrl, active: false });
      await waitForTabLoad(downloadTab, listUrl, timeoutMs);
      return downloadTab;
    };

    /**
     * Fast invoice: fetch one order's full invoice from its detail HTML via the
     * content script's main-world bridge — NO per-order tab navigation. Reuses a
     * single tab (any open orders tab, else opens the orders list). Returns the
     * invoice, or null to signal a fallback to the classic per-order page flow.
     * Persists to IndexedDB on success.
     */
    const fetchViaFastInvoice = async (orderNumber, providerId, options = {}) => {
      const { timeoutMs = app.orderTimeoutMs } = options;
      const adapter =
        (providerId && typeof ProviderRegistry !== "undefined" && ProviderRegistry.getById(providerId)) ||
        activeAdapter();
      if (!adapter || !adapter.supportsFastInvoice) return null;

      const listUrl = (adapter && adapter.ordersListUrl) || CONSTANTS.URLS.WALMART_ORDERS;
      const tab = await ensureFastTab(listUrl, timeoutMs);
      // Give a freshly-opened list tab a beat to install its content script and
      // main-world bridge before the first message, so the first order doesn't
      // fall back to a full order-page load. Reused tab → no wait.
      if (!fastTabWarmedUp) {
        await delay(800);
        fastTabWarmedUp = true;
      }

      let response;
      try {
        response = await promiseWithTimeout(
          ChromeApi.tabsSendMessage(tab.id, {
            action: CONSTANTS.MESSAGES.GET_ORDER_DATA_FAST,
            orderNumber,
          }),
          timeoutMs,
          `Timeout fast-fetching order #${orderNumber}`
        );
      } catch (error) {
        return null; // fall back to the order page
      }

      if (!response || response.fallback || !isUsableInvoiceData(response.data, orderNumber)) {
        return null; // adapter couldn't fast-fetch this one — fall back
      }

      try {
        await OrderDb.putInvoice(orderNumber, response.data, providerId || activeProviderId(), (app && app.accountKey) || null);
      } catch (error) {
        console.warn(`Failed to persist fast invoice #${orderNumber} to order DB:`, error);
      }
      view.updateOrderCacheStatus(orderNumber);
      return response.data;
    };

    // Walmart answers a burst of page loads with its "Robot or human?" page
    // (/blocked). That is a pause, not a site change or a broken order (#43):
    // surface it as its own error so the run stops instead of failing every
    // remaining order against the challenge page.
    const isChallengeUrl = (value) => {
      try {
        const parsed = new URL(value);
        return /(^|\.)walmart\.(com|ca)$/i.test(parsed.hostname) && /^\/blocked(\/|$)/.test(parsed.pathname);
      } catch (error) {
        return false;
      }
    };

    const challengeError = (orderNumber) => {
      const error = new Error(`Walmart asked for a human check while loading order #${orderNumber}`);
      error.walmartChallenge = true;
      return error;
    };

    const tabShowsChallenge = async (tabId) => {
      try {
        const live = await ChromeApi.tabsGet(tabId);
        return isChallengeUrl((live && (live.pendingUrl || live.url)) || "");
      } catch (error) {
        return false;
      }
    };

    const fetchFromUrl = async (orderNumber, url, options = {}, providerId = null) => {
      const { timeoutMs = app.orderTimeoutMs, stabilizeDelayMs = app.orderSettleMs } = options;
      let tab;
      try {
        tab = await ensureTab(url, timeoutMs);
      } catch (error) {
        if (downloadTab && (await tabShowsChallenge(downloadTab.id))) throw challengeError(orderNumber);
        throw error;
      }
      if (await tabShowsChallenge(tab.id)) throw challengeError(orderNumber);

      try {
        await ChromeApi.tabsSendMessage(tab.id, { action: CONSTANTS.MESSAGES.BLOCK_IMAGES });
      } catch (error) {
        console.error("Error blocking images:", error);
      }

      await delay(stabilizeDelayMs);

      let response;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          response = await promiseWithTimeout(
            ChromeApi.tabsSendMessage(tab.id, { method: CONSTANTS.MESSAGES.GET_ORDER_DATA }),
            timeoutMs,
            `Timeout getting data for order #${orderNumber}`
          );
          if (response?.challenge) throw challengeError(orderNumber);
          const problems = invoiceProblems(response?.data, orderNumber);
          if (problems.length === 0) break;
          if (attempt === 1) {
            if (!response?.data) throw new Error(`No data received for order #${orderNumber}`);
            throw new Error(`Incomplete invoice for order #${orderNumber}: ${problems.join(", ")}`);
          }
          // Re-read the same page once: load-complete does not guarantee that
          // Walmart has populated the invoice. A second miss tries the next URL.
          await delay(Math.max(stabilizeDelayMs, CONSTANTS.TIMING.RETRY_DELAY));
        }
      } catch (error) {
        // The challenge page has no content script, so it first shows up as a
        // messaging failure or an empty read.
        if (!error?.walmartChallenge && (await tabShowsChallenge(tab.id))) {
          throw challengeError(orderNumber);
        }
        throw error;
      }

      // IndexedDB is the only durable store for invoices now (spec §4.1) —
      // no more chrome.storage invoice cache to duplicate this into.
      try {
        await OrderDb.putInvoice(orderNumber, response.data, providerId || activeProviderId(), (app && app.accountKey) || null);
      } catch (error) {
        console.warn(`Failed to persist invoice #${orderNumber} to order DB:`, error);
      }
      view.updateOrderCacheStatus(orderNumber);
      return response.data;
    };

    const fetchOrderData = async (orderNumber, options = {}) => {
      // Resolve the concrete provider partition that owns THIS order once, up
      // front, and thread it through every per-order DB read/write and URL
      // build below. Under the combined "All providers" view app.provider is
      // the PROVIDER_ALL sentinel (not a real partition); for a concrete active
      // provider this returns app.provider directly with no extra DB reads.
      const providerId = await resolveProviderId(orderNumber);

      // Fast path (spec §4.2): an already-downloaded, current-schema
      // invoice sits in IndexedDB — return it and open NO tab at all. This
      // is what makes re-exporting an already-downloaded order instant,
      // even long after the old 24h chrome.storage cache would have
      // expired.
      let storedInvoice = null;
      try {
        const record = await OrderDb.getOrder(orderNumber, providerId);
        storedInvoice = (record && record.invoice) || null;
      } catch (error) {
        console.warn(`Order DB unavailable for fast-path lookup of #${orderNumber}:`, error);
      }

      if (storedInvoice && isValidInvoiceData(storedInvoice, orderNumber, providerId)) {
        view.updateOrderCacheStatus(orderNumber);
        return storedInvoice;
      }

      // Fast invoice: when the user turned on fast collection, pull this order's
      // invoice from its detail HTML via the main-world bridge — no tab opened
      // for it. Any miss returns null and falls through to the classic flow, so
      // this can only speed things up, never lose an invoice.
      if (app && app.fastFetch) {
        try {
          const fast = await fetchViaFastInvoice(orderNumber, providerId, options);
          if (fast) return fast;
        } catch (error) {
          console.warn(`Fast invoice for #${orderNumber} failed; using the order page:`, error && error.message);
        }
      }

      // Nothing usable stored yet, or it predates the current schema —
      // fetch live, but keep the stale record around unused unless every
      // live fetch fails, so a failed re-fetch never destroys usable data
      // (fetchFromUrl overwrites the DB record on success).
      const [primaryUrl, fallbackUrl] = buildOrderUrls(orderNumber, providerId);
      try {
        return await fetchFromUrl(orderNumber, primaryUrl, options, providerId);
      } catch (error) {
        // A second URL would hit the same challenge and deepen the block.
        if (error?.walmartChallenge) throw error;
        console.error(`Primary fetch failed for order #${orderNumber}:`, error);
        try {
          if (!fallbackUrl || fallbackUrl === primaryUrl) throw error;
          return await fetchFromUrl(orderNumber, fallbackUrl, options, providerId);
        } catch (fallbackError) {
          if (fallbackError?.walmartChallenge) throw fallbackError;
          if (isUsableInvoiceData(storedInvoice, orderNumber)) {
            console.warn(
              `Both fetches failed for order #${orderNumber}; falling back to stale stored data`
            );
            view.updateOrderCacheStatus(orderNumber);
            const needsWalmartRefresh = Number(storedInvoice?.walmartExtractionVersion || 0) < requiredExtractionVersion(providerId);
            return needsWalmartRefresh
              ? {
                  ...storedInvoice,
                  extractionWarnings: [
                    ...(Array.isArray(storedInvoice.extractionWarnings) ? storedInvoice.extractionWarnings : []),
                    'Walmart could not refresh this saved invoice, so older saved data was exported',
                  ],
                }
              : storedInvoice;
          }
          throw fallbackError;
        }
      }
    };

    const cleanup = async () => {
      fastTabWarmedUp = false;
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
      return null;
    }
    console.warn(`Extraction warnings for order #${orderNumber}:`, warnings);
    return { orderNumber, warnings };
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
  // Doubles after each human check Walmart raises in this panel session, so a
  // retried run does not repeat the pace that triggered it.
  let challengePaceMultiplier = 1;
  const MAX_CHALLENGE_PACE_MULTIPLIER = 8;

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
        if (error?.walmartChallenge) {
          console.warn(`${errorPrefix} #${orderNumber}: Walmart asked for a human check; stopping the run.`);
          challengePaceMultiplier = Math.min(challengePaceMultiplier * 2, MAX_CHALLENGE_PACE_MULTIPLIER);
          return {
            failedOrders: failedOrders.concat(selectedOrders.slice(i)),
            cancelled: false,
            challenged: true,
          };
        }
        console.error(`${errorPrefix} #${orderNumber}:`, error);
        failedOrders.push(orderNumber);
      }

      await delay(CONSTANTS.TIMING.RETRY_DELAY * challengePaceMultiplier);
    }

    return { failedOrders, cancelled: false, challenged: false };
  }

  /**
   * Result text for a run Walmart interrupted with its human check. The
   * unfinished orders are not broken, so this explains what to do instead of
   * listing them as failures.
   * @param {number} done - orders finished before the check
   * @param {number} total - orders in the run
   * @param {string} verb - "exported" or "saved"
   * @returns {string} safe HTML
   */
  function challengeResultMessage(done, total, verb) {
    const adapter =
      typeof ProviderRegistry !== "undefined" && app && app.provider ? ProviderRegistry.getById(app.provider) : null;
    const ordersUrl = (adapter && adapter.ordersListUrl) || CONSTANTS.URLS.WALMART_ORDERS;
    return (
      `Walmart paused this run to check that you are human — ${done} of ${total} ${verb}. ` +
      `<a href="${escapeHtml(ordersUrl)}" target="_blank" rel="noopener noreferrer">Open Walmart</a>, ` +
      `complete the check, then press Retry failed. Your orders are fine; the rest will run more slowly.`
    );
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

  /**
   * Snapshot every export-affecting option at run start. A multi-file run
   * exports order-by-order over many seconds — reading app.* live per order
   * let a mid-run format/preset/toggle change (main view OR Settings) split
   * one batch across formats (review finding). Runs thread this snapshot
   * through instead.
   */
  function snapshotExportOptions() {
    return {
      format: getExportFormat(),
      csvPreset: getCsvPreset(),
      includeThumbnails: shouldIncludeThumbnails(),
      legacyExcel: shouldUseLegacyExcel(),
    };
  }

  /** Export all collected orders combined, honoring the selected format. */
  async function exportCombinedOrders(collectedOrdersData, baseName = "Walmart_Orders", exportOptions = null) {
    const opts = exportOptions || snapshotExportOptions();
    const format = opts.format;
    if (format === CONSTANTS.EXPORT_FORMATS.CSV) {
      const preset = opts.csvPreset;
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
    const xlsxWriter = opts.legacyExcel ? convertMultipleOrdersToXlsxLegacy : convertMultipleOrdersToXlsx;
    await xlsxWriter(collectedOrdersData, ExcelJS, `${baseName}.xlsx`, {
      includeThumbnails: opts.includeThumbnails,
    });
  }

  /** Export one order as its own file, honoring the selected format. */
  async function exportOneOrder(data, exportOptions = null) {
    const opts = exportOptions || snapshotExportOptions();
    const format = opts.format;
    const orderNumber = data.orderNumber || "order";
    if (format === CONSTANTS.EXPORT_FORMATS.CSV) {
      const preset = opts.csvPreset;
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
    const xlsxWriter = opts.legacyExcel ? convertToXlsxLegacy : convertToXlsx;
    await xlsxWriter(data, ExcelJS, { mode: "single", includeThumbnails: opts.includeThumbnails });
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
  function showDownloadResultBanner({ variant, message, retryOrders, onRetry }) {
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
          if (typeof onRetry === "function") {
            onRetry(retryOrders);
          } else {
            downloadSelectedOrders(app && app.exportMode, retryOrders);
          }
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

      if (fetchAccountMismatchBlocked()) return;

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

      view.clearStatusBanner("extractionWarning");
      const extractionDiagnostics = [];
      // One snapshot governs the whole run — mid-run option changes apply
      // to the NEXT run, never to files already queued in this one.
      const exportOptions = snapshotExportOptions();
      const formatLabel = formatDisplayName(exportOptions.format);
      const onProgress = (current, total, orderNumber, actionText) => {
        view.updateDownloadProgress(current, total, `${actionText} ${current} / ${total} (#${orderNumber})`);
      };

      try {
        if (activeMode === CONSTANTS.EXPORT_MODES.SINGLE) {
          const collectedOrdersData = [];
          const { failedOrders, cancelled, challenged } = await runDownloadQueue({
            selectedOrders,
            actionText: CONSTANTS.TEXT.COLLECTING,
            options: { timeoutMs: app.orderTimeoutMs, stabilizeDelayMs: app.orderSettleMs },
            errorPrefix: "Failed to collect data for order",
            onOrder: async (orderNumber, options) => {
              const data = await OrderDataFetcher.fetchOrderData(orderNumber, options);
              const diagnostic = checkExtractionWarnings(orderNumber, data);
              if (diagnostic) extractionDiagnostics.push(diagnostic);
              collectedOrdersData.push(data);
            },
            onProgress,
          });

          if (cancelled) {
            showDownloadResultBanner({ variant: "warning", message: "Download cancelled." });
            return;
          }

          // Show one actionable summary covering every affected order.
          if (extractionDiagnostics.length > 0) {
            view.showExtractionWarning(extractionDiagnostics);
          }

          if (collectedOrdersData.length > 0) {
            try {
              // Filename carries the active "Showing" filter (spec v7.1 §D)
              // — '' (no suffix) when the filter is All time, matching the
              // pre-redesign filename exactly and keeping the golden export
              // tests (which never touch the filter) byte-stable.
              const baseName = "Walmart_Orders" + (view.getActiveRangeLabelSuffix ? view.getActiveRangeLabelSuffix() : "");
              await exportCombinedOrders(collectedOrdersData, baseName, exportOptions);
            } catch (e) {
              console.error("Failed to export to XLSX:", e);
              showDownloadResultBanner({ variant: "danger", message: `Export failed: ${escapeHtml(e.message)}` });
              return;
            }
          }

          if (failedOrders.length === 0) {
            const count = collectedOrdersData.length;
            showDownloadResultBanner({
              variant: "success",
              message: `Exported ${count} order${count === 1 ? "" : "s"} (${formatLabel})`,
            });
          } else {
            showDownloadResultBanner({
              variant: challenged ? "warning" : "danger",
              message: challenged
                ? challengeResultMessage(collectedOrdersData.length, selectedOrders.length, "exported")
                : `${collectedOrdersData.length} of ${selectedOrders.length} exported — ${failedOrders.length} failed (${escapeHtml(formatFailedOrders(failedOrders))})`,
              retryOrders: failedOrders,
            });
          }
        } else {
          const { failedOrders, cancelled, challenged } = await runDownloadQueue({
            selectedOrders,
            actionText: CONSTANTS.TEXT.DOWNLOADING,
            options: { timeoutMs: app.orderTimeoutMs, stabilizeDelayMs: app.orderSettleMs },
            errorPrefix: "Error downloading order",
            onOrder: async (orderNumber, options) => {
              const data = await OrderDataFetcher.fetchOrderData(orderNumber, options);
              const diagnostic = checkExtractionWarnings(orderNumber, data);
              if (diagnostic) extractionDiagnostics.push(diagnostic);
              await exportOneOrder(data, exportOptions);
            },
            onProgress,
          });

          if (cancelled) {
            showDownloadResultBanner({ variant: "warning", message: "Download cancelled." });
            return;
          }

          // Show one actionable summary covering every affected order.
          if (extractionDiagnostics.length > 0) {
            view.showExtractionWarning(extractionDiagnostics);
          }

          const succeeded = selectedOrders.length - failedOrders.length;
          if (failedOrders.length === 0) {
            showDownloadResultBanner({
              variant: "success",
              message: `Exported ${succeeded} order${succeeded === 1 ? "" : "s"} (${formatLabel})`,
            });
          } else {
            showDownloadResultBanner({
              variant: challenged ? "warning" : "danger",
              message: challenged
                ? challengeResultMessage(succeeded, selectedOrders.length, "exported")
                : `${succeeded} of ${selectedOrders.length} exported — ${failedOrders.length} failed (${escapeHtml(formatFailedOrders(failedOrders))})`,
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

  /**
   * Fetch full invoice details for the selected orders into IndexedDB WITHOUT
   * producing any file. Same per-order scrape+store the download flow uses
   * (OrderDataFetcher.fetchOrderData persists each invoice), just without the
   * export step — so the user can build up their local library / dashboard
   * data and download later, instantly, from storage.
   *
   * fetchOrderData's fast path means orders whose current-schema invoice is
   * already stored are skipped (no tab opened), so this is cheap to re-run.
   * @param {string[]} [orderNumbersOverride] - specific orders; defaults to the selection
   */
  async function loadSelectedOrdersToDb(orderNumbersOverride) {
    try {
      if (app && app.downloadInProgress) {
        showGuardBanner("A run is already in progress. Please wait.");
        return;
      }

      const selectedOrders =
        Array.isArray(orderNumbersOverride) && orderNumbersOverride.length > 0
          ? orderNumbersOverride
          : getSelectedOrderNumbers();

      if (selectedOrders.length === 0) {
        showGuardBanner("Select at least one order to save.");
        return;
      }

      if (fetchAccountMismatchBlocked()) return;

      const button = document.getElementById("loadToLibrary");
      if (app) app.downloadInProgress = true;
      view.setButtonLoading(button, true);
      // The download pair shares the downloadInProgress guard; disable it too.
      ["singleFileDownload", "multiFileDownload"].forEach((id) => {
        const b = document.getElementById(id);
        if (b) b.disabled = true;
      });
      view.clearStatusBanner("downloadResultBanner");
      view.showDownloadProgress(0, selectedOrders.length, {
        onCancel: () => {
          if (app) app.downloadInProgress = false;
        },
      });

      view.clearStatusBanner("extractionWarning");
      const extractionDiagnostics = [];
      const onProgress = (current, total, orderNumber, actionText) => {
        view.updateDownloadProgress(current, total, `${actionText} ${current} / ${total} (#${orderNumber})`);
      };

      try {
        const { failedOrders, cancelled, challenged } = await runDownloadQueue({
          selectedOrders,
          actionText: CONSTANTS.TEXT.COLLECTING,
          options: { timeoutMs: app.orderTimeoutMs, stabilizeDelayMs: app.orderSettleMs },
          errorPrefix: "Failed to load data for order",
          onOrder: async (orderNumber, options) => {
            // fetchOrderData stores the invoice in IndexedDB as a side effect.
            const data = await OrderDataFetcher.fetchOrderData(orderNumber, options);
            const diagnostic = checkExtractionWarnings(orderNumber, data);
            if (diagnostic) extractionDiagnostics.push(diagnostic);
          },
          onProgress,
        });

        if (cancelled) {
          showDownloadResultBanner({ variant: "warning", message: "Saving cancelled." });
          return;
        }
        if (extractionDiagnostics.length > 0) {
          view.showExtractionWarning(extractionDiagnostics);
        }

        const succeeded = selectedOrders.length - failedOrders.length;
        if (failedOrders.length === 0) {
          showDownloadResultBanner({
            variant: "success",
            message: `Saved ${succeeded} order${succeeded === 1 ? "" : "s"} to your library — no file downloaded.`,
          });
        } else {
          showDownloadResultBanner({
            variant: challenged ? "warning" : "danger",
            message: challenged
              ? challengeResultMessage(succeeded, selectedOrders.length, "saved")
              : `${succeeded} of ${selectedOrders.length} saved — ${failedOrders.length} failed (${escapeHtml(formatFailedOrders(failedOrders))})`,
            retryOrders: failedOrders,
            onRetry: (orders) => loadSelectedOrdersToDb(orders),
          });
        }
      } catch (error) {
        console.error("Load-to-library error:", error);
        showDownloadResultBanner({
          variant: "danger",
          message: "An error occurred while saving. Some orders may have failed.",
        });
      } finally {
        await OrderDataFetcher.cleanup();
        view.hideDownloadProgress();
        view.setButtonLoading(button, false);
        if (app) app.downloadInProgress = false;
        view.updateDownloadButtonsState();
        // Reflect the newly-saved invoices (✓ saved chips, dashboard data).
        if (Sidepanel.actions && Sidepanel.actions.checkCurrentTab) {
          Sidepanel.actions.checkCurrentTab();
        }
      }
    } catch (outerError) {
      console.error("Error in loadSelectedOrdersToDb:", outerError);
    }
  }

  Sidepanel.download = {
    OrderDataFetcher,
    downloadSelectedOrders,
    loadSelectedOrdersToDb,
    exportCombinedOrders,
    exportOneOrder,
  };
})();
