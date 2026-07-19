(() => {
  const Sidepanel = window.Sidepanel || (window.Sidepanel = {});
  const app = Sidepanel.state.app;
  const view = Sidepanel.view;

  function isOperationRunning() {
    return app.downloadInProgress || app.collectionInProgress;
  }

  /**
   * The active selection (a provider id, or Sidepanel.providers.PROVIDER_ALL
   * for the combined view). Always a real value — defaults to WALMART_US, so
   * everything below behaves exactly as the Walmart-only tool did when the
   * provider contract module isn't loaded (unit tests) or nothing is opted in.
   */
  function activeSelection() {
    return (app && app.provider) || "WALMART_US";
  }

  /**
   * The concrete provider id a collection runs for. The background crawls one
   * provider at a time, so the combined "All providers" view collects for the
   * always-on default (WALMART_US) rather than refusing outright.
   */
  function collectionProviderId() {
    const active = activeSelection();
    const providers = Sidepanel.providers;
    if (providers && active === providers.PROVIDER_ALL) return providers.DEFAULT_PROVIDER;
    return active;
  }

  /**
   * Provider ids to read OrderDb for: the single active provider, or every
   * enabled provider under the combined view (Sidepanel.providers.scopeIds).
   * @returns {Promise<string[]>}
   */
  async function activeScopeIds() {
    const active = activeSelection();
    const providers = Sidepanel.providers;
    if (providers && typeof providers.scopeIds === "function") {
      try {
        return await providers.scopeIds(active);
      } catch (error) {
        console.warn("Could not resolve the active provider scope:", error);
      }
    }
    return [active];
  }

  /**
   * Whether a GET_PROGRESS response's collection belongs to the active
   * selection. The background runs ONE collection at a time; when its
   * provider isn't the one this panel is showing, the panel must not render
   * that collection's progress or overlay its order numbers (a Walmart crawl
   * never bleeds into another site's view, and vice-versa). The response carries
   * no provider field today, so the panel falls back to the provider it last
   * started a collection for (app.collectionProvider), then WALMART_US —
   * matching the background's own default.
   * @param {Object|null} response - a GET_PROGRESS response
   * @returns {boolean}
   */
  function progressMatchesActiveScope(response) {
    const active = activeSelection();
    const providers = Sidepanel.providers;
    if (providers && active === providers.PROVIDER_ALL) return true;
    const progressProvider = (response && response.provider) || app.collectionProvider || "WALMART_US";
    return progressProvider === active;
  }

  function checkCurrentTab() {
    const providerId = collectionProviderId();

    // Embedded in the full-page dashboard (dashboard.html iframes
    // sidepanel.html): there is no meaningful "active tab" to gate on — the
    // dashboard tab itself is the app context. Render the stored orders and
    // give a Walmart collection the default orders URL (the worker opens the
    // provider's own tab itself when collecting).
    if (window.self !== window.top) {
      view.clearOffTabWarning();
      view.setUIEnabled(true);
      view.applyLayout(view.UI_MODES.MAIN_ORDERS);
      app.currentOrdersUrl = providerId === "WALMART_US" ? CONSTANTS.URLS.WALMART_ORDERS : null;
      view.updateFilterNotice(null);
      loadCacheOnMainPage();
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const tab = tabs && tabs[0];
      const url = tab && tab.url;
      view.clearOffTabWarning();

      // If this is a Walmart orders tab, ask its content script which account
      // is logged in. If it differs from what the list is showing, switch the
      // list to that account (so a logout/login instantly changes the view).
      if (tab && url && /^https:\/\/www\.walmart\.(com|ca)\/orders/.test(url)) {
        chrome.tabs.sendMessage(tab.id, { action: CONSTANTS.MESSAGES.GET_ACCOUNT_KEY }, (resp) => {
          void chrome.runtime.lastError;
          const key = resp && resp.accountKey;
          if (key && key !== app.accountKey) {
            app.accountKey = key;
            chrome.storage.local.set({ currentAccountKey: key });
            loadCacheOnMainPage();
          }
        });
      }

      // The Walmart-on-its-own-tab experience is IDENTICAL to before:
      // single-order view on an order page, live filter notice and a
      // filter-scoped crawl URL on the list page. (Under the combined view
      // providerId resolves to WALMART_US, so this branch still applies.)
      if (url && url.startsWith(CONSTANTS.URLS.WALMART_ORDERS) && providerId === "WALMART_US") {
        const cleanUrl = url.replace(/\/$/, "");
        const orderPath = cleanUrl.split("/orders/")[1];
        app.currentOrdersUrl = null;

        view.setUIEnabled(true);

        if (orderPath && /^\d{10,}$/.test(orderPath.split("?")[0])) {
          const orderNumber = orderPath.split("?")[0];
          view.updateFilterNotice(null);
          // A single Walmart order page is always something to act on, even
          // for a brand-new user with an empty DB — force out of the
          // first-run macro state (spec v7.1 §A) so the row + download
          // buttons render regardless of collection history.
          view.updateMacroState(true);
          // displayOrderNumbers wipes the container synchronously but
          // rebuilds it after an await — applying the single-order layout
          // before the rebuild always missed the Select-All row it hides
          // (review finding). Sequence the layout after the render.
          view
            .displayOrderNumbers([orderNumber])
            .then(() => view.applyLayout(view.UI_MODES.SINGLE_ORDER));
        } else {
          view.applyLayout(view.UI_MODES.MAIN_ORDERS);
          app.currentOrdersUrl = url;
          view.updateFilterNotice(url);
          loadCacheOnMainPage();
        }
      } else {
        // Tab-independence: any other tab — or a non-Walmart provider — is
        // NOT a blocked state. Show the active provider's saved orders from
        // OrderDb with Collect enabled; the background worker opens the
        // provider's own orders page in its own tab when collecting, so
        // nothing here depends on where the user happens to be browsing.
        app.currentOrdersUrl = null;
        view.setUIEnabled(true);
        view.applyLayout(view.UI_MODES.MAIN_ORDERS);
        view.updateFilterNotice(null);
        loadCacheOnMainPage();
      }
    });
  }

  function handleStartCollection() {
    if (app.downloadInProgress) {
      // Collection re-renders the order list every poll tick, which would
      // fight the running download for the container (review finding).
      view.renderStatusBanner("collectionBlockedBanner", {
        variant: "warning",
        message: "A download is running — wait for it to finish before collecting.",
        dismissible: true,
      });
      return;
    }
    // The crawl URL never blocks on the current tab. WALMART_US on its own
    // orders tab keeps crawling the LIVE tab URL exactly as before (preserves
    // filter-scoped crawls); everywhere else — Walmart off its tab, or any
    // other provider — the background worker opens the adapter's own orders
    // list (ordersListUrl) in its OWN tab.
    const providerId = collectionProviderId();
    const providers = Sidepanel.providers;
    let collectionUrl = providerId === "WALMART_US" ? app.currentOrdersUrl : null;
    if (!collectionUrl && providers && typeof providers.ordersListUrlFor === "function") {
      collectionUrl = providers.ordersListUrlFor(providerId);
    }
    if (!collectionUrl && typeof ProviderRegistry !== "undefined") {
      const adapter = ProviderRegistry.getById(providerId);
      if (adapter && adapter.ordersListUrl) collectionUrl = adapter.ordersListUrl;
    }
    if (!collectionUrl) collectionUrl = CONSTANTS.URLS.WALMART_ORDERS;

    // Scope this run's progress to its provider (progressMatchesActiveScope).
    app.collectionProvider = providerId;

    const pageLimitInput = document.getElementById("pageLimit");
    const startButton = document.getElementById("startCollection");
    const pageLimit = parseInt(pageLimitInput ? pageLimitInput.value : "0", 10);
    setCollectionButtonsState({ running: true });
    view.setButtonLoading(startButton, true);
    // Reveal the list/download sections the moment collection starts (spec
    // v7.1 §A "Loading state") rather than waiting for the first order to
    // land — a running collection already counts as "has orders" even
    // before any results exist yet.
    view.updateMacroState(true);

    chrome.runtime.sendMessage(
      {
        action: CONSTANTS.MESSAGES.START_COLLECTION,
        url: collectionUrl,
        pageLimit: pageLimit,
        incremental: Boolean(app.incrementalCollect),
        // Optional pure request-replay mode (OFF by default). The reliable
        // default paginates and reads dates from the page's own captured
        // requests; this flag is opt-in for users where blind replay works.
        fastFetch: Boolean(app.fastFetch),
        // Always name the provider so the background gate is explicit. Defaults
        // to WALMART_US, so nothing changes for the Walmart.com-only flow; the
        // header provider dropdown (sidepanel.js) drives app.provider, and the
        // combined "All providers" view collects for WALMART_US.
        provider: providerId,
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
   *
   * Reads are scoped to the ACTIVE provider selection: one provider's records,
   * or the union of every enabled provider's under the combined view. The
   * overlay is additionally scope-guarded so another provider's in-flight
   * collection never leaks its order numbers into this view.
   * @param {Object|null} [progress] - a GET_PROGRESS response to overlay
   * @returns {Promise<boolean>} whether anything was rendered
   */
  async function displayOrdersFromDb(progress = null) {
    try {
      const scopeIds = await activeScopeIds();
      const acct = (app && app.accountKey) || null;
      const perProvider = await Promise.all(scopeIds.map((providerId) => OrderDb.getAllOrders(providerId, acct)));
      const records = perProvider.flat();
      const withData = records.filter((record) => record.summary || record.invoice);
      withData.sort((a, b) => String(b.orderDate).localeCompare(String(a.orderDate)));

      // Dedupe by order number — under the combined view the same number
      // could theoretically exist in two providers' partitions, and one row
      // per number is what the checkbox/id contract downstream expects.
      const orderNumbers = [];
      const titles = {};
      withData.forEach((record) => {
        if (Object.prototype.hasOwnProperty.call(titles, record.orderNumber)) return;
        orderNumbers.push(record.orderNumber);
        titles[record.orderNumber] = record.title || "";
      });

      if (progress && !progressMatchesActiveScope(progress)) progress = null;
      if (progress && Array.isArray(progress.orderNumbers)) {
        const known = new Set(orderNumbers);
        progress.orderNumbers.forEach((orderNumber) => {
          if (known.has(orderNumber)) return;
          known.add(orderNumber);
          orderNumbers.unshift(orderNumber);
          titles[orderNumber] = (progress.additionalFields && progress.additionalFields[orderNumber]) || "";
        });
      }

      if (orderNumbers.length === 0) {
        // Nothing to show for the active scope — clear any rows still on
        // screen instead of leaving them there. This is what makes "Delete all
        // saved data" (and switching to an empty provider) take effect
        // immediately, rather than the stale list lingering until the panel is
        // closed and reopened. A running collection never reaches here: its
        // live order numbers are merged into `orderNumbers` just above, so the
        // list is only empty when there is genuinely nothing to display.
        await view.displayOrderNumbers([]);
        const staleBanner = document.getElementById("cacheInfo");
        if (staleBanner) staleBanner.remove();
        return false;
      }

      await view.displayOrderNumbers(orderNumbers, titles);
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
    // Everything progress-derived is scoped: a collection running for a
    // DIFFERENT provider contributes neither its raw order numbers nor its
    // "collecting" macro state to this provider's view.
    const matches = progressMatchesActiveScope(response);
    let hasOrders = shown;
    if (!shown && matches && response && response.orderNumbers && response.orderNumbers.length > 0) {
      await view.displayOrderNumbers(response.orderNumbers, response.additionalFields);
      hasOrders = true;
    }
    // The macro state (spec v7.1 §A) reflects "any orders anywhere" — DB
    // history OR a still-running collection, even one that hasn't found
    // anything yet (handleStartCollection already reveals it optimistically;
    // this keeps it correct on every subsequent poll/reload too).
    view.updateMacroState(hasOrders || Boolean(matches && response && response.isCollecting));
  }

  function loadCacheOnMainPage() {
    // Resolve which account we're viewing FIRST (renderAccountSwitcher settles
    // app.accountKey), so the list read below is scoped to the right account
    // rather than briefly showing everything before snapping to one account.
    renderAccountSwitcher().finally(() => {
      chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.GET_PROGRESS }, function (response) {
        renderOrderList(response);
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Multi-account switcher (side-panel side; the dashboard renders its
   * own from the same shared storage keys, so switching/renaming in one
   * surface reflects in the other). Shown only when ≥2 accounts have data.
   * ------------------------------------------------------------------ */

  let accountSwitcherRenaming = false;

  function readAccountMaps() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        [CONSTANTS.STORAGE_KEYS.ACCOUNT_LABELS, CONSTANTS.STORAGE_KEYS.ACCOUNT_ORDINALS],
        (res) => {
          resolve({
            labels: (res && res[CONSTANTS.STORAGE_KEYS.ACCOUNT_LABELS]) || {},
            ordinals: (res && res[CONSTANTS.STORAGE_KEYS.ACCOUNT_ORDINALS]) || {},
          });
        }
      );
    });
  }

  function wireAccountSwitcher() {
    const select = document.getElementById("accountSelect");
    const renameBtn = document.getElementById("accountRenameButton");
    const input = document.getElementById("accountRenameInput");
    if (select && !select.dataset.wired) {
      select.dataset.wired = "1";
      select.addEventListener("change", () => {
        const value = select.value;
        if (value === app.accountKey) return;
        app.accountKey = value;
        chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.CURRENT_ACCOUNT]: value });
        loadCacheOnMainPage();
      });
    }
    if (renameBtn && !renameBtn.dataset.wired) {
      renameBtn.dataset.wired = "1";
      renameBtn.addEventListener("click", beginAccountRename);
    }
    if (input && !input.dataset.wired) {
      input.dataset.wired = "1";
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") commitAccountRename(true);
        else if (event.key === "Escape") commitAccountRename(false);
      });
      input.addEventListener("blur", () => commitAccountRename(true));
    }
  }

  function beginAccountRename() {
    const select = document.getElementById("accountSelect");
    const input = document.getElementById("accountRenameInput");
    if (!select || !input || !app.accountKey) return;
    const current = select.selectedOptions && select.selectedOptions[0];
    accountSwitcherRenaming = true;
    input.value = (current && current.dataset.name) || "";
    input.hidden = false;
    select.hidden = true;
    input.focus();
    input.select();
  }

  async function commitAccountRename(save) {
    const select = document.getElementById("accountSelect");
    const input = document.getElementById("accountRenameInput");
    if (!input || !select || input.hidden) return; // already committed (guards Escape→blur)
    accountSwitcherRenaming = false;
    input.hidden = true;
    select.hidden = false;
    if (!save || !app.accountKey) {
      renderAccountSwitcher();
      return;
    }
    const { labels } = await readAccountMaps();
    const name = String(input.value || "").trim();
    const next = { ...labels };
    if (name) next[app.accountKey] = name;
    else delete next[app.accountKey]; // clearing the name falls back to "Account N"
    chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.ACCOUNT_LABELS]: next }, () => renderAccountSwitcher());
  }

  /**
   * Render (or hide) the account switcher and keep app.accountKey pointing at a
   * real, still-present account. Persists newly-assigned ordinals and the
   * resolved current account so the dashboard sees the same choice.
   * @returns {Promise<void>}
   */
  async function renderAccountSwitcher() {
    const host = document.getElementById("accountSwitcher");
    if (!host) return;
    if (accountSwitcherRenaming) return; // don't rebuild out from under the rename input
    wireAccountSwitcher();

    let summaries = [];
    try {
      summaries = (await OrderDb.getAccountSummaries()) || [];
    } catch (_) {
      summaries = [];
    }

    const { labels, ordinals: storedOrdinals } = await readAccountMaps();
    const values = summaries.map((summary) => accountSelectionValue(summary.accountKey));
    const ordinals = assignAccountOrdinals(values, storedOrdinals);
    if (JSON.stringify(ordinals) !== JSON.stringify(storedOrdinals)) {
      chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.ACCOUNT_ORDINALS]: ordinals });
    }

    const selected = resolveSelectedAccount(summaries, app.accountKey);
    if (selected !== app.accountKey) {
      app.accountKey = selected;
      chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.CURRENT_ACCOUNT]: selected });
    }

    // Hide the control when there's nothing to switch between (single account
    // behaves exactly as before), or when this panel is embedded in the
    // dashboard — the dashboard renders its own switcher in the top bar, so we
    // avoid showing two. The account is already resolved above either way.
    if (summaries.length < 2 || window.self !== window.top) {
      host.hidden = true;
      return;
    }

    const select = document.getElementById("accountSelect");
    if (select) {
      select.innerHTML = "";
      buildAccountOptions(summaries, { labels, ordinals, selected }).forEach((option) => {
        const el = document.createElement("option");
        el.value = option.value;
        el.dataset.name = option.name;
        el.textContent = `${option.name} · ${option.orderCount} order${option.orderCount === 1 ? "" : "s"}`;
        if (option.selected) el.selected = true;
        select.appendChild(el);
      });
    }
    host.hidden = false;
  }

  function updateProgress() {
    chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.GET_PROGRESS }, function (response) {
      if (!response) return;

      // One collection runs in the background at a time; only paint its
      // page/count progress when it belongs to the provider this panel is
      // showing (spec: a Walmart crawl's progress must never render into an
      // another view). The collecting/buttons state itself stays global —
      // Stop still controls the one running crawl from any view.
      const matches = progressMatchesActiveScope(response);
      const progressElement = document.getElementById("progress");
      if (!matches && progressElement) progressElement.style.display = "none";

      if (response.isCollecting) {
        app.collectionInProgress = true;
        setCollectionButtonsState({ running: true });
        if (matches) {
          view.updateProgressUI(response.currentPage, response.pageLimit, true, (response.orderNumbers || []).length);
        }
        // Checkboxes are disabled during collection (below), so the order
        // list re-render always lands on 0 selected — updateDownloadButtonsState
        // (called from within displayOrderNumbers) already reflects that.
        renderOrderList(response);
        setTimeout(updateProgress, 1000);
        setCheckboxesDisabled(true);
      } else {
        app.collectionInProgress = false;
        if (matches) view.updateProgressUI(response.currentPage, response.pageLimit, false);
        // Chained (not fire-and-forget): setCollectionButtonsState's
        // default label reads state.app.hasOrders, which renderOrderList
        // only refreshes once its async DB read resolves — must run first.
        renderOrderList(response).then(() => {
          // No explicit startLabel — setCollectionButtonsState (utils.js)
          // now picks "Load my orders" / "Check for new orders" itself.
          setCollectionButtonsState({ running: false });
        });
        setCheckboxesDisabled(false);
      }
    });
  }

  Sidepanel.actions = {
    isOperationRunning,
    activeScopeIds,
    progressMatchesActiveScope,
    checkCurrentTab,
    handleStartCollection,
    handleStopCollection,
    stopCollection,
    displayOrdersFromDb,
    renderOrderList,
    loadCacheOnMainPage,
    renderAccountSwitcher,
    updateProgress,
  };
})();
