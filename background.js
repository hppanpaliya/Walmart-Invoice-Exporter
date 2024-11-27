let allOrderNumbers = new Set();
let currentPage = 1;
let isCollecting = false;
let tabId = null;
let maxRetries = 3;
let retryCount = 0;
let pageLimit = 0;
let timeout = 100;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "startCollection") {
    if (!isCollecting) {
      isCollecting = true;
      allOrderNumbers.clear();
      currentPage = 1;
      retryCount = 0;
      pageLimit = request.pageLimit || 0;
      startCollection(request.url);
    }
    sendResponse({ status: "started" });
  } else if (request.action === "stopCollection") {
    if (isCollecting) {
      isCollecting = false;
      if (tabId) {
        chrome.tabs.remove(tabId);
        chrome.tabs.onUpdated.removeListener(onTabUpdated);
      }
      sendResponse({
        status: "stopped",
        currentPage: currentPage,
        orderNumbers: Array.from(allOrderNumbers),
      });
    }
  } else if (request.action === "getProgress") {
    sendResponse({
      currentPage: currentPage,
      pageLimit: pageLimit,
      orderNumbers: Array.from(allOrderNumbers),
      isCollecting: isCollecting,
    });
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

  chrome.tabs.sendMessage(tabId, { action: "collectOrderNumbers" }, (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error collecting order numbers:", chrome.runtime.lastError);
      retryCollection();
      return;
    }

    if (response && response.orderNumbers) {
      console.log(`Collected ${response.orderNumbers.length} order numbers from page ${currentPage}`);
      response.orderNumbers.forEach((num) => allOrderNumbers.add(num));

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
  if (tabId) {
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    chrome.tabs.remove(tabId);
  }
  console.log(`Collection finished. Total pages: ${currentPage}, Total order numbers: ${allOrderNumbers.size}`);
}
