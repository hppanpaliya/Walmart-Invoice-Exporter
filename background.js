let allOrderNumbers = new Set();
let currentPage = 1;
let isCollecting = false;
let tabId = null;
let maxRetries = 3;
let retryCount = 0;
let pageLimit = 0;
let timeout = 100;
let cacheKey = "walmart_order_cache";
let pagesCached = {};

// Cache expiration time (24 hours in milliseconds)
const CACHE_EXPIRATION = 24 * 60 * 60 * 1000;

// Function to load cached order numbers
function loadCachedOrderNumbers() {
  return new Promise((resolve) => {
    chrome.storage.session.get([cacheKey], (result) => {
      if (result[cacheKey]) {
        const cachedData = result[cacheKey];

        // Check if cache is expired
        if (Date.now() - cachedData.timestamp > CACHE_EXPIRATION) {
          console.log("Cache is expired. Clearing.");
          chrome.storage.session.remove(cacheKey);
          allOrderNumbers = new Set();
          pagesCached = {};
        } else {
          allOrderNumbers = new Set(cachedData.orderNumbers);
          pagesCached = cachedData.pagesCached || {};
          console.log(`Loaded ${allOrderNumbers.size} order numbers from cache with ${Object.keys(pagesCached).length} pages cached`);
        }
      }
      resolve();
    });
  });
}

// Function to save order numbers and page cache to session storage
function saveToCache() {
  const dataToCache = {
    orderNumbers: Array.from(allOrderNumbers),
    pagesCached: pagesCached,
    timestamp: Date.now(),
  };

  chrome.storage.session.set({ [cacheKey]: dataToCache }, () => {
    console.log(`Saved ${allOrderNumbers.size} order numbers and ${Object.keys(pagesCached).length} pages to cache`);
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "startCollection") {
    if (!isCollecting) {
      isCollecting = true;
      // Load cached order numbers before starting collection
      loadCachedOrderNumbers().then(() => {
        currentPage = 1;
        retryCount = 0;
        pageLimit = request.pageLimit || 0;
        startCollection(request.url);
      });
    }
    sendResponse({ status: "started" });
  } else if (request.action === "stopCollection") {
    if (isCollecting) {
      isCollecting = false;
      if (tabId) {
        chrome.tabs.remove(tabId);
        chrome.tabs.onUpdated.removeListener(onTabUpdated);
      }
      // Save to cache before sending response
      saveToCache();
      sendResponse({
        status: "stopped",
        currentPage: currentPage,
        orderNumbers: Array.from(allOrderNumbers),
      });
    }
  } else if (request.action === "getProgress") {
    loadCachedOrderNumbers().then(() => {
      sendResponse({
        currentPage: currentPage,
        pageLimit: pageLimit,
        orderNumbers: Array.from(allOrderNumbers),
        isCollecting: isCollecting,
        pagesCached: pagesCached,
      });
    });
    return true; // Indicate async response
  } else if (request.action === "clearCache") {
    chrome.storage.session.clear(() => { // Clear all session storage
      console.log("Cache cleared");
      allOrderNumbers.clear();
      pagesCached = {};
      sendResponse({ status: "cache_cleared" });
    });
    return true; // Indicate async response
  }
  return true;
});

function startCollection(url) {
  console.log("Starting collection from URL:", url);
  chrome.tabs.create({ url: url, active: false }, (tab) => {
    tabId = tab.id;
    chrome.tabs.onUpdated.addListener(onTabUpdated);
  });
}

function onTabUpdated(updatedTabId, changeInfo, tab) {
  if (updatedTabId === tabId && changeInfo.status === "complete") {
    console.log("Tab updated, collecting order numbers for page:", currentPage);
    setTimeout(() => collectOrderNumbers(), timeout);
  }
}

function collectOrderNumbers() {
  if (!isCollecting) {
    console.log("Collection stopped by user");
    finishCollection();
    return;
  }

  // Check if we've reached the page limit
  if (pageLimit > 0 && currentPage > pageLimit) {
    console.log(`Reached page limit (${pageLimit}). Finishing collection.`);
    finishCollection();
    return;
  }

  // Check if this page is already cached
  if (pagesCached[currentPage]) {
    console.log(`Page ${currentPage} is already cached. Skipping collection.`);
    // If already cached, we can go to the next page
    if (pagesCached[currentPage].hasNextPage && (pageLimit === 0 || currentPage < pageLimit)) {
      currentPage++;
      goToNextPage();
    } else {
      console.log("No more pages to collect or reached limit. Finishing collection.");
      finishCollection();
    }
    return;
  }

  chrome.tabs.sendMessage(tabId, { action: "collectOrderNumbers" }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error collecting order numbers:", chrome.runtime.lastError);
      retryCollection();
      return;
    }

    if (response && response.orderNumbers) {
      console.log(`Collected ${response.orderNumbers.length} order numbers from page ${currentPage}`);

      // Add order numbers to the set
      response.orderNumbers.forEach((num) => allOrderNumbers.add(num));

      // Cache page data
      pagesCached[currentPage] = {
        hasNextPage: response.hasNextPage,
        orderNumbers: response.orderNumbers,
        timestamp: Date.now(),
      };

      // Save to cache after each page
      saveToCache();

      if (response.hasNextPage && (pageLimit === 0 || currentPage < pageLimit)) {
        currentPage++;
        retryCount = 0;
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
  if (!isCollecting) {
    finishCollection();
    return;
  }

  console.log("Attempting to go to next page:", currentPage);
  chrome.tabs.sendMessage(tabId, { action: "clickNextButton" }, (response) => {
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
  if (!isCollecting) {
    finishCollection();
    return;
  }

  if (retryCount < maxRetries) {
    retryCount++;
    console.log(`Retrying collection. Attempt ${retryCount} of ${maxRetries}`);
    setTimeout(() => collectOrderNumbers(), timeout);
  } else {
    console.log("Max retries reached. Finishing collection.");
    finishCollection();
  }
}

function finishCollection() {
  isCollecting = false;
  // Save to cache before closing
  saveToCache();
  if (tabId) {
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    chrome.tabs.remove(tabId);
  }
  console.log(`Collection finished. Total pages: ${currentPage}, Total order numbers: ${allOrderNumbers.size}`);
}
