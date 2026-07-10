/**
 * Background service worker for Walmart Invoice Exporter
 * Handles order collection, pagination, and caching
 */

// Load shared constants, utilities, and the durable order database
importScripts('utils.js', 'orderdb.js');

// Encapsulate state to reduce global namespace pollution
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
  cacheKey: CONSTANTS.CACHE_KEYS.ORDER_COLLECTION,
  pagesCached: {},
  incremental: false,
  knownAtStart: null,
  ownsTab: true,

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
    this.pagesCached = {};
  }
};

// Cache expiration time (24 hours in milliseconds) - use shared constant
const CACHE_EXPIRATION = CONSTANTS.TIMING.CACHE_EXPIRATION;

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

// Function to load cached order data
function loadCachedOrderNumbers() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CollectionState.cacheKey], (result) => {
      if (result[CollectionState.cacheKey]) {
        const cachedData = result[CollectionState.cacheKey];

        // Check if cache is expired
        if (Date.now() - cachedData.timestamp > CACHE_EXPIRATION) {
          console.log("Cache is expired. Clearing.");
          chrome.storage.local.remove(CollectionState.cacheKey);
          CollectionState.clearAll();
        } else {
          CollectionState.allOrderNumbers = new Set(cachedData.orderNumbers);
          CollectionState.allAdditionalFields = cachedData.additionalFields || {};
          CollectionState.allOrderSummaries = cachedData.orderSummaries || {};
          CollectionState.pagesCached = cachedData.pagesCached || {};
          console.log(`Loaded ${CollectionState.allOrderNumbers.size} orders from cache with ${Object.keys(CollectionState.pagesCached).length} pages cached`);
        }
      }
      resolve();
    });
  });
}

// Function to save order data to cache
function saveToCache() {
  const dataToCache = {
    orderNumbers: Array.from(CollectionState.allOrderNumbers),
    additionalFields: CollectionState.allAdditionalFields,
    orderSummaries: CollectionState.allOrderSummaries,
    pagesCached: CollectionState.pagesCached,
    timestamp: Date.now(),
  };

  chrome.storage.local.set({ [CollectionState.cacheKey]: dataToCache }, () => {
    console.log(`Saved ${CollectionState.allOrderNumbers.size} orders and ${Object.keys(CollectionState.pagesCached).length} pages to cache`);
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
    // Load cached order numbers before starting collection
    loadCachedOrderNumbers().then(() => {
      // Caches from versions without Quick Export summaries would export
      // degraded rows forever — start those collections from scratch.
      const hasOrders = CollectionState.allOrderNumbers.size > 0;
      const hasSummaries = Object.keys(CollectionState.allOrderSummaries).length > 0;
      if (hasOrders && !hasSummaries) {
        console.log("Cached collection lacks Quick Export summaries; re-collecting from scratch.");
        CollectionState.clearAll();
      }

      CollectionState.reset();
      CollectionState.pageLimit = request.pageLimit || 0;
      CollectionState.incremental = Boolean(request.incremental);
      CollectionState.knownAtStart = null;
      // Always refresh the first page to avoid missing new orders within the cache window
      if (CollectionState.pagesCached[1]) {
        delete CollectionState.pagesCached[1];
      }

      if (!CollectionState.incremental) {
        startCollection(request.url, request.reuseTabId || null);
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
        .then(() => startCollection(request.url, request.reuseTabId || null));
    });
  }
  sendResponse({ status: "started" });
  return false; // Synchronous response
}

function handleStopCollection(_request, sendResponse) {
  if (!CollectionState.isCollecting) {
    sendResponse({
      status: "idle",
      currentPage: CollectionState.currentPage,
      orderNumbers: Array.from(CollectionState.allOrderNumbers),
    });
    return false; // Synchronous response
  }

  CollectionState.isCollecting = false;
  if (CollectionState.tabId) {
    if (CollectionState.ownsTab) {
      chrome.tabs.remove(CollectionState.tabId).catch(() => {
        // Tab may already be closed
      });
    }
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
  }
  // Save to cache before sending response
  saveToCache();
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
      pagesCached: CollectionState.pagesCached,
    });
  };

  // While collecting, the in-memory state is authoritative — reloading the
  // storage snapshot here would race the per-page merge (losing pages) and
  // the cache-expiry path could clearAll() mid-collection.
  if (CollectionState.isCollecting) {
    respond();
    return true;
  }

  loadCachedOrderNumbers().then(respond);
  return true; // Indicate async response
}

function handleClearCache(_request, sendResponse) {
  chrome.storage.local.remove(CollectionState.cacheKey, () => {
    // Clear only collection cache (preserve other local storage data)
    console.log("Cache cleared");
    CollectionState.clearAll();
    sendResponse({ status: "cache_cleared" });
  });
  return true; // Indicate async response
}

function startCollection(url, reuseTabId = null) {
  // Prefer collecting in the user's CURRENT orders tab: no second tab, no
  // page reload, and one fewer parallel session for Walmart to frown at.
  if (reuseTabId) {
    chrome.tabs.get(reuseTabId, (tab) => {
      if (!chrome.runtime.lastError && tab && String(tab.url || "").startsWith(CONSTANTS.URLS.WALMART_ORDERS)) {
        CollectionState.tabId = tab.id;
        CollectionState.ownsTab = false; // NEVER close the user's own tab
        console.log("Collecting in the user's current orders tab:", tab.id);
        setTimeout(() => collectOrderNumbers(), 300);
      } else {
        createCollectionTab(url);
      }
    });
    return;
  }
  createCollectionTab(url);
}

function createCollectionTab(url) {
  console.log("Starting collection in a background tab from URL:", url);
  chrome.tabs.create({ url: url, active: false }, (tab) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to create tab:", chrome.runtime.lastError);
      CollectionState.isCollecting = false;
      return;
    }
    CollectionState.tabId = tab.id;
    CollectionState.ownsTab = true;
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

    if (response && response.orderNumbers) {
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

      // Cache page data
      CollectionState.pagesCached[CollectionState.currentPage] = {
        hasNextPage: response.hasNextPage,
        orderNumbers: response.orderNumbers,
        additionalFields: response.additionalFields || {},
        timestamp: Date.now(),
      };

      // Save to cache after each page
      saveToCache();

      // Incremental sync: a page consisting entirely of already-stored orders
      // means everything older is stored too — stop here.
      const pageFullyKnown =
        CollectionState.incremental &&
        CollectionState.knownAtStart &&
        response.orderNumbers.length > 0 &&
        response.orderNumbers.every((num) => CollectionState.knownAtStart.has(num));
      if (pageFullyKnown) {
        console.log("Incremental sync: page contains only known orders. Finishing collection.");
        finishCollection();
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

function finishCollection() {
  CollectionState.isCollecting = false;
  // Save to cache before closing
  saveToCache();
  if (CollectionState.tabId) {
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    // Only close tabs the collection created — never the user's own tab.
    if (CollectionState.ownsTab) {
      chrome.tabs.remove(CollectionState.tabId).catch(() => {
        // Tab may already be closed, ignore error
      });
    }
    CollectionState.tabId = null;
  }
  console.log(`Collection finished. Total pages: ${CollectionState.currentPage}, Total order numbers: ${CollectionState.allOrderNumbers.size}`);
}
