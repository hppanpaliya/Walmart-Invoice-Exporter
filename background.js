/**
 * Background service worker for Walmart Invoice Exporter
 * Handles order collection, pagination, and durable storage
 */

// Load shared constants, utilities, and the durable order database
importScripts('utils.js', 'orderdb.js');

// Encapsulate state to reduce global namespace pollution.
//
// CollectionState.isCollecting reflects only THIS worker instance — Chrome
// can evict an idle service worker (~30s) at any time, resetting every
// module global back to these defaults. Everything else is mirrored to
// chrome.storage.session (sessionKey) after every meaningful change, so a
// collection's progress survives an eviction/restart and a side-panel
// close/reopen (spec §4.1/P9) — but isCollecting itself is never read back
// from that snapshot (see handleGetProgress): only the live in-memory
// instance can truthfully claim to be actively driving a crawl, so a dead
// worker never leaves the panel stuck showing "collecting" forever.
const CollectionState = {
  allOrderNumbers: new Set(),
  allAdditionalFields: {},
  allOrderSummaries: {},
  currentPage: 1,
  isCollecting: false,
  tabId: null,
  maxRetries: 3,
  retryCount: 0,
  pageLimit: 0,
  pageLoadDelay: 1000,
  initialPageLoaded: false,
  sessionKey: CONSTANTS.CACHE_KEYS.COLLECTION_SESSION,
  incremental: false,
  knownAtStart: null,

  // Reset state for new collection
  reset() {
    this.currentPage = 1;
    this.retryCount = 0;
    this.initialPageLoaded = false;
  },

  // Clear all collected data
  clearAll() {
    this.allOrderNumbers.clear();
    this.allAdditionalFields = {};
    this.allOrderSummaries = {};
  }
};

// Reset rating hint per browser session (stored in local, cleared on startup)
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove(CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISSED);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISSED);
});

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel && chrome.sidePanel.open) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
  else {
    console.warn("Side panel API not available.");
  }
});

/**
 * Load any collection progress mirrored to chrome.storage.session into
 * CollectionState. Unlike the old 24h chrome.storage.local cache, there is
 * no expiry math here — chrome.storage.session is cleared automatically
 * when the browser closes, and IndexedDB (OrderDb) is the durable
 * long-term store; this is scratch space just for "is a collection still
 * going / where did it leave off" (spec §4.1).
 * Deliberately does NOT touch CollectionState.isCollecting — see the big
 * comment above CollectionState for why.
 */
function loadSessionState() {
  return new Promise((resolve) => {
    chrome.storage.session.get([CollectionState.sessionKey], (result) => {
      const saved = result[CollectionState.sessionKey];
      if (saved) {
        CollectionState.allOrderNumbers = new Set(saved.orderNumbers || []);
        CollectionState.allAdditionalFields = saved.additionalFields || {};
        CollectionState.allOrderSummaries = saved.orderSummaries || {};
        CollectionState.currentPage = saved.currentPage || 1;
        CollectionState.pageLimit = saved.pageLimit || 0;
        console.log(`Restored ${CollectionState.allOrderNumbers.size} orders from session state.`);
      }
      resolve();
    });
  });
}

/** Mirror live collection progress to chrome.storage.session (best-effort). */
function saveSessionState() {
  const dataToSave = {
    orderNumbers: Array.from(CollectionState.allOrderNumbers),
    additionalFields: CollectionState.allAdditionalFields,
    orderSummaries: CollectionState.allOrderSummaries,
    currentPage: CollectionState.currentPage,
    pageLimit: CollectionState.pageLimit,
    isCollecting: CollectionState.isCollecting,
  };

  chrome.storage.session.set({ [CollectionState.sessionKey]: dataToSave }, () => {
    if (chrome.runtime.lastError) {
      console.warn("Failed to save session collection state:", chrome.runtime.lastError.message);
    }
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handlers = {
    [CONSTANTS.MESSAGES.START_COLLECTION]: handleStartCollection,
    [CONSTANTS.MESSAGES.STOP_COLLECTION]: handleStopCollection,
    [CONSTANTS.MESSAGES.GET_PROGRESS]: handleGetProgress,
    [CONSTANTS.MESSAGES.CLEAR_CACHE]: handleClearCache,
  };

  const handler = handlers[request.action];
  if (!handler) {
    return false;
  }

  return handler(request, sendResponse);
});

function handleStartCollection(request, sendResponse) {
  if (!CollectionState.isCollecting) {
    CollectionState.isCollecting = true;
    // Hydrate from session first — e.g. this worker was just (re)spawned
    // after an eviction and the panel is resuming a collection.
    loadSessionState().then(() => {
      CollectionState.reset();
      CollectionState.pageLimit = request.pageLimit || 0;
      CollectionState.incremental = Boolean(request.incremental);
      CollectionState.knownAtStart = null;

      if (!CollectionState.incremental) {
        startCollection(request.url);
        return;
      }

      // Incremental mode stops when a whole page of already-stored orders is
      // seen — snapshot what the database knows before we begin.
      OrderDb.getKnownOrderNumbers()
        .then((known) => {
          CollectionState.knownAtStart = known;
        })
        .catch((error) => {
          console.warn("Order DB unavailable; running a full collection:", error);
          CollectionState.incremental = false;
        })
        .then(() => startCollection(request.url));
    });
  }
  sendResponse({ status: "started" });
  return false; // Synchronous response
}

function handleStopCollection(_request, sendResponse) {
  if (!CollectionState.isCollecting) {
    // Hydrate first so "Stop" right after a panel reopen (post-eviction)
    // reports actually-known progress instead of fresh-worker defaults.
    loadSessionState().then(() => {
      sendResponse({
        status: "idle",
        currentPage: CollectionState.currentPage,
        orderNumbers: Array.from(CollectionState.allOrderNumbers),
      });
    });
    return true; // Async response
  }

  CollectionState.isCollecting = false;
  if (CollectionState.tabId) {
    chrome.tabs.remove(CollectionState.tabId).catch(() => {
      // Tab may already be closed
    });
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
  }
  // Save progress before sending response
  saveSessionState();
  sendResponse({
    status: "stopped",
    currentPage: CollectionState.currentPage,
    orderNumbers: Array.from(CollectionState.allOrderNumbers),
  });

  return false; // Synchronous response
}

function handleGetProgress(_request, sendResponse) {
  const respond = () => {
    sendResponse({
      currentPage: CollectionState.currentPage,
      pageLimit: CollectionState.pageLimit,
      orderNumbers: Array.from(CollectionState.allOrderNumbers),
      additionalFields: CollectionState.allAdditionalFields,
      orderSummaries: CollectionState.allOrderSummaries,
      isCollecting: CollectionState.isCollecting,
    });
  };

  // While collecting, the in-memory state is authoritative — reloading the
  // session snapshot here would race the per-page merge (losing pages).
  if (CollectionState.isCollecting) {
    respond();
    return true;
  }

  // Not collecting from THIS worker instance's point of view — it may have
  // just been (re)spawned after Chrome evicted the previous, possibly
  // mid-collection, instance. Hydrate order data from session so a panel
  // reopen still shows progress; isCollecting always reflects the CURRENT
  // instance (see the CollectionState comment), never a stale session
  // snapshot, so a dead crawl never reports itself as still running.
  loadSessionState().then(respond);
  return true; // Indicate async response
}

function handleClearCache(_request, sendResponse) {
  chrome.storage.session.remove(CollectionState.sessionKey, () => {
    console.log("Session collection state cleared");
    CollectionState.clearAll();
    sendResponse({ status: "cache_cleared" });
  });
  return true; // Indicate async response
}

/** The orders LIST page (an order-detail URL like /orders/123 is NOT it). */
function isOrdersListUrl(url) {
  return /^https:\/\/www\.walmart\.com\/orders\/?($|\?)/.test(String(url || ""));
}

// Collection always runs in its OWN background tab — never in a tab the
// user is looking at (owner decision: reverted the 6.20 in-tab collection).
function startCollection(url) {
  console.log("Starting collection in a background tab from URL:", url);
  chrome.tabs.create({ url: url, active: false }, (tab) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to create tab:", chrome.runtime.lastError);
      CollectionState.isCollecting = false;
      return;
    }
    CollectionState.tabId = tab.id;
    chrome.tabs.onUpdated.addListener(onTabUpdated);
  });
}

function onTabUpdated(updatedTabId, changeInfo, tab) {
  if (CollectionState.tabId && updatedTabId === CollectionState.tabId && changeInfo.status === "complete") {
    if (CollectionState.initialPageLoaded) {
      return;
    }
    CollectionState.initialPageLoaded = true;
    console.log("Tab updated, collecting order numbers for page:", CollectionState.currentPage);
    setTimeout(() => collectOrderNumbers(), CollectionState.pageLoadDelay);
  }
}

function collectOrderNumbers() {
  if (!CollectionState.isCollecting) {
    console.log("Collection stopped by user");
    finishCollection();
    return;
  }

  // Check if we've reached the page limit
  if (CollectionState.pageLimit > 0 && CollectionState.currentPage > CollectionState.pageLimit) {
    console.log(`Reached page limit (${CollectionState.pageLimit}). Finishing collection.`);
    finishCollection();
    return;
  }

  // The user can navigate a reused tab away mid-collection — verify we are
  // still on the orders list before asking it for a page.
  chrome.tabs.get(CollectionState.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab || !isOrdersListUrl(tab.url)) {
      console.warn("Collection tab is no longer on the orders list; retrying.");
      retryCollection();
      return;
    }

  // Always collect order numbers to ensure cache is up to date with any changes
  chrome.tabs.sendMessage(
    CollectionState.tabId,
    {
      action: CONSTANTS.MESSAGES.COLLECT_ORDER_NUMBERS,
      currentPage: CollectionState.currentPage,
    },
    (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error collecting order numbers:", chrome.runtime.lastError);
      retryCollection();
      return;
    }

    if (response && response.collectionError) {
      console.warn("Content script reported a collection error; retrying.");
      retryCollection();
      return;
    }

    if (response && response.orderNumbers && (response.orderNumbers.length > 0 || response.endOfOrders)) {
      console.log(`Collected ${response.orderNumbers.length} order numbers from page ${CollectionState.currentPage}`);

      // Add order numbers to the set
      response.orderNumbers.forEach((num) => CollectionState.allOrderNumbers.add(num));

      // Add additional fields to the map
      if (response.additionalFields) {
        CollectionState.allAdditionalFields = { ...CollectionState.allAdditionalFields, ...response.additionalFields };
      }

      // Merge per-page order summaries — never let a degraded DOM-scraped
      // summary replace payload-quality data for the same order.
      if (response.orderSummaries) {
        Object.entries(response.orderSummaries).forEach(([orderNumber, summary]) => {
          const existing = CollectionState.allOrderSummaries[orderNumber];
          if (existing && isPayloadQualitySummary(existing) && !isPayloadQualitySummary(summary)) {
            return;
          }
          CollectionState.allOrderSummaries[orderNumber] = summary;
        });
      }

      // Persist this page into the durable order database (best-effort).
      OrderDb.putSummaries(response.orderSummaries || {}, response.additionalFields || {}).catch(
        (error) => console.warn("Failed to persist page to order DB:", error)
      );

      // Mirror live progress to chrome.storage.session after each page.
      saveSessionState();

      // Incremental sync: a page consisting entirely of already-stored orders
      // means everything older is stored too — stop here.
      const pageFullyKnown =
        CollectionState.incremental &&
        CollectionState.knownAtStart &&
        response.orderNumbers.length > 0 &&
        response.orderNumbers.every((num) => CollectionState.knownAtStart.has(num));
      if (pageFullyKnown) {
        console.log("Incremental sync: page contains only known orders. Hydrating from the DB and finishing.");
        hydrateCollectionFromDb().finally(() => finishCollection());
        return;
      }

      if (response.hasNextPage && (CollectionState.pageLimit === 0 || CollectionState.currentPage < CollectionState.pageLimit)) {
        goToNextPage();
      } else {
        console.log("No more pages to collect or reached limit. Finishing collection.");
        finishCollection();
      }
    } else {
      console.log("No order numbers received. Retrying.");
      retryCollection();
    }
    }
  );
  });
}

function goToNextPage() {
  if (!CollectionState.isCollecting) {
    finishCollection();
    return;
  }

  console.log("Attempting to go to next page:", CollectionState.currentPage + 1);
  chrome.tabs.sendMessage(CollectionState.tabId, { action: CONSTANTS.MESSAGES.CLICK_NEXT_BUTTON }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error clicking next button:", chrome.runtime.lastError);
      retryCollection();
    } else if (response && response.success) {
      CollectionState.currentPage++;
      CollectionState.retryCount = 0;
      console.log("Successfully clicked next button. Collecting page:", CollectionState.currentPage);
      setTimeout(() => collectOrderNumbers(), CollectionState.pageLoadDelay);
    } else {
      console.log("Failed to click next button. Retrying.");
      retryCollection();
    }
  });
}

function retryCollection() {
  if (!CollectionState.isCollecting) {
    finishCollection();
    return;
  }

  if (CollectionState.retryCount < CollectionState.maxRetries) {
    CollectionState.retryCount++;
    console.log(`Retrying collection. Attempt ${CollectionState.retryCount} of ${CollectionState.maxRetries}`);
    setTimeout(() => collectOrderNumbers(), CollectionState.pageLoadDelay);
  } else {
    console.log("Max retries reached. Finishing collection.");
    finishCollection();
  }
}

/**
 * Merge every order stored in the durable DB into the live collection so an
 * incremental early-stop still leaves the full history selectable in the
 * panel (session state only covers this browser session's live progress).
 */
async function hydrateCollectionFromDb() {
  try {
    const records = await OrderDb.getAllOrders();
    records.forEach((record) => {
      if (!record?.orderNumber) return;
      CollectionState.allOrderNumbers.add(record.orderNumber);
      if (record.title && !CollectionState.allAdditionalFields[record.orderNumber]) {
        CollectionState.allAdditionalFields[record.orderNumber] = record.title;
      }
      const existing = CollectionState.allOrderSummaries[record.orderNumber];
      if (record.summary && (!existing || (!isPayloadQualitySummary(existing) && isPayloadQualitySummary(record.summary)))) {
        CollectionState.allOrderSummaries[record.orderNumber] = record.summary;
      }
    });
    console.log(`Hydrated collection from DB: ${CollectionState.allOrderNumbers.size} orders total.`);
  } catch (error) {
    console.warn("Could not hydrate collection from the order DB:", error);
  }
}

function finishCollection() {
  CollectionState.isCollecting = false;
  // Save progress before closing
  saveSessionState();
  if (CollectionState.tabId) {
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    chrome.tabs.remove(CollectionState.tabId).catch(() => {
      // Tab may already be closed, ignore error
    });
    CollectionState.tabId = null;
  }
  console.log(`Collection finished. Total pages: ${CollectionState.currentPage}, Total order numbers: ${CollectionState.allOrderNumbers.size}`);
}
