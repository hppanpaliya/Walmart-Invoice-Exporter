/**
 * Background service worker for Walmart Invoice Exporter
 * Handles order collection, pagination, and caching
 */

// Encapsulate state to reduce global namespace pollution
const CollectionState = {
  allOrderNumbers: new Set(),
  allAdditionalFields: {},
  currentPage: 1,
  isCollecting: false,
  tabId: null,
  maxRetries: 3,
  retryCount: 0,
  pageLimit: 0,
  timeout: 100,
  cacheKey: "walmart_order_cache",
  pagesCached: {},
  
  // Reset state for new collection
  reset() {
    this.currentPage = 1;
    this.retryCount = 0;
  },
  
  // Clear all collected data
  clearAll() {
    this.allOrderNumbers.clear();
    this.allAdditionalFields = {};
    this.pagesCached = {};
  }
};

// Cache expiration time (24 hours in milliseconds) - use shared constant
const CACHE_EXPIRATION = 24 * 60 * 60 * 1000; // Matches CONSTANTS.TIMING.CACHE_EXPIRATION
const RATING_HINT_DISMISSED_KEY = "ratingHintDismissed";

// Reset rating hint per browser session (stored in local, cleared on startup)
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove(RATING_HINT_DISMISSED_KEY);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(RATING_HINT_DISMISSED_KEY);
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
    pagesCached: CollectionState.pagesCached,
    timestamp: Date.now(),
  };

  chrome.storage.local.set({ [CollectionState.cacheKey]: dataToCache }, () => {
    console.log(`Saved ${CollectionState.allOrderNumbers.size} orders and ${Object.keys(CollectionState.pagesCached).length} pages to cache`);
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "startCollection") {
    if (!CollectionState.isCollecting) {
      CollectionState.isCollecting = true;
      // Load cached order numbers before starting collection
      loadCachedOrderNumbers().then(() => {
        CollectionState.reset();
        CollectionState.pageLimit = request.pageLimit || 0;
        // Always refresh the first page to avoid missing new orders within the cache window
        if (CollectionState.pagesCached[1]) {
          delete CollectionState.pagesCached[1];
        }
        startCollection(request.url);
      });
    }
    sendResponse({ status: "started" });
    return false; // Synchronous response
  } else if (request.action === "stopCollection") {
    if (CollectionState.isCollecting) {
      CollectionState.isCollecting = false;
      if (CollectionState.tabId) {
        chrome.tabs.remove(CollectionState.tabId).catch(() => {
          // Tab may already be closed
        });
        chrome.tabs.onUpdated.removeListener(onTabUpdated);
      }
      // Save to cache before sending response
      saveToCache();
      sendResponse({
        status: "stopped",
        currentPage: CollectionState.currentPage,
        orderNumbers: Array.from(CollectionState.allOrderNumbers),
      });
    }
    return false; // Synchronous response
  } else if (request.action === "getProgress") {
    loadCachedOrderNumbers().then(() => {
      sendResponse({
        currentPage: CollectionState.currentPage,
        pageLimit: CollectionState.pageLimit,
        orderNumbers: Array.from(CollectionState.allOrderNumbers),
        additionalFields: CollectionState.allAdditionalFields,
        isCollecting: CollectionState.isCollecting,
        pagesCached: CollectionState.pagesCached,
      });
    });
    return true; // Indicate async response
  } else if (request.action === "clearCache") {
    chrome.storage.local.remove(CollectionState.cacheKey, () => {
      // Clear only collection cache (preserve other local storage data)
      console.log("Cache cleared");
      CollectionState.clearAll();
      sendResponse({ status: "cache_cleared" });
    });
    return true; // Indicate async response
  }
  return false; // Default: synchronous (no response needed)
});

function startCollection(url) {
  console.log("Starting collection from URL:", url);
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
    console.log("Tab updated, collecting order numbers for page:", CollectionState.currentPage);
    setTimeout(() => collectOrderNumbers(), CollectionState.timeout);
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

  // Check if this page is already cached
  if (CollectionState.pagesCached[CollectionState.currentPage]) {
    console.log(`Page ${CollectionState.currentPage} is already cached. Skipping collection.`);
    // If already cached, we can go to the next page
    if (CollectionState.pagesCached[CollectionState.currentPage].hasNextPage && (CollectionState.pageLimit === 0 || CollectionState.currentPage < CollectionState.pageLimit)) {
      CollectionState.currentPage++;
      goToNextPage();
    } else {
      console.log("No more pages to collect or reached limit. Finishing collection.");
      finishCollection();
    }
    return;
  }

  chrome.tabs.sendMessage(CollectionState.tabId, { action: "collectOrderNumbers" }, (response) => {
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

      // Cache page data
      CollectionState.pagesCached[CollectionState.currentPage] = {
        hasNextPage: response.hasNextPage,
        orderNumbers: response.orderNumbers,
        additionalFields: response.additionalFields || {},
        timestamp: Date.now(),
      };

      // Save to cache after each page
      saveToCache();

      if (response.hasNextPage && (CollectionState.pageLimit === 0 || CollectionState.currentPage < CollectionState.pageLimit)) {
        CollectionState.currentPage++;
        CollectionState.retryCount = 0;
        goToNextPage();
      } else {
        console.log("No more pages to collect or reached limit. Finishing collection.");
        finishCollection();
      }
    } else {
      console.log("No order numbers received. Retrying.");
      retryCollection();
    }
  });
}

function goToNextPage() {
  if (!CollectionState.isCollecting) {
    finishCollection();
    return;
  }

  console.log("Attempting to go to next page:", CollectionState.currentPage);
  chrome.tabs.sendMessage(CollectionState.tabId, { action: "clickNextButton" }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error clicking next button:", chrome.runtime.lastError);
      retryCollection();
    } else if (response && response.success) {
      console.log("Successfully clicked next button. Waiting for page to load.");
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
    setTimeout(() => collectOrderNumbers(), CollectionState.timeout);
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
    chrome.tabs.remove(CollectionState.tabId).catch(() => {
      // Tab may already be closed, ignore error
    });
    CollectionState.tabId = null;
  }
  console.log(`Collection finished. Total pages: ${CollectionState.currentPage}, Total order numbers: ${CollectionState.allOrderNumbers.size}`);
}
