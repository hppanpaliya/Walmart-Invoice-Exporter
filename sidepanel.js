const AppState = {
  downloadInProgress: false,
  collectionInProgress: false,
  exportMode: CONSTANTS.EXPORT_MODES.MULTIPLE,
  currentOrdersUrl: null,
};

let initialOrderPlaceholderHtml = "";

const CACHE_INDICATOR_STYLE = 'cursor: pointer; margin-left: 6px; color: var(--primary); display: inline-flex; align-items: center; gap: 2px; font-size: 10px;';
const CACHE_INDICATOR_SELECTOR = '[data-cache-indicator="true"]';

function getWalmartOrdersBaseUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (
      CONSTANTS.URLS.WALMART_ORDER_DOMAINS.includes(parsed.hostname) &&
      parsed.pathname.startsWith(CONSTANTS.URLS.WALMART_ORDERS_PATH)
    ) {
      return `${parsed.protocol}//${parsed.hostname}${CONSTANTS.URLS.WALMART_ORDERS_PATH}`;
    }
  } catch (_error) {
    // Ignore malformed URLs
  }
  return null;
}

// Global error handler for unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

document.addEventListener("DOMContentLoaded", function () {
  const startButton = document.getElementById("startCollection");
  const stopButton = document.getElementById("stopCollection");
  const progressElement = document.getElementById("progress");
  const orderNumbersContainer = document.getElementById("orderNumbersContainer");
  const pageLimitInput = document.getElementById("pageLimit");
  const exportModeSelect = document.getElementById("exportMode");
  progressElement.style.display = "none";
  if (!initialOrderPlaceholderHtml) {
    initialOrderPlaceholderHtml = orderNumbersContainer.innerHTML;
  }

  // View elements
  const mainView = document.getElementById("mainView");
  const faqView = document.getElementById("faqView");
  const faqButton = document.getElementById("faqButton");
  const backButton = document.getElementById("backButton");
  const confirmDialog = document.getElementById("confirmDialog");
  const confirmDialogCancel = document.getElementById("confirmDialogCancel");
  const confirmDialogProceed = document.getElementById("confirmDialogProceed");
  const confirmDialogMessage = document.getElementById("confirmDialogMessage");

  // Navigation functions
  function showView(viewName) {
    if (viewName === 'faq') {
      mainView.classList.remove('active');
      faqView.classList.add('active');
    } else {
      faqView.classList.remove('active');
      mainView.classList.add('active');
      // Refresh the main view state
      checkCurrentTab();
    }
  }

  function isOperationRunning() {
    return AppState.downloadInProgress || AppState.collectionInProgress;
  }

  function showConfirmDialog(message) {
    confirmDialogMessage.textContent = message;
    confirmDialog.classList.add('active');
  }

  function hideConfirmDialog() {
    confirmDialog.classList.remove('active');
  }

  // FAQ button click - show confirmation if operation running
  faqButton.addEventListener("click", function (e) {
    e.preventDefault();
    
    if (isOperationRunning()) {
      const opType = AppState.collectionInProgress ? 'collection' : 'download';
      showConfirmDialog(`A ${opType} is currently running. Navigating to FAQ will stop the operation. Your collected data will be preserved.`);
    } else {
      showView('faq');
    }
  });

  // Back button click - show confirmation if operation running (shouldn't happen in FAQ, but be safe)
  backButton.addEventListener("click", function (e) {
    e.preventDefault();
    showView('main');
  });

  // Confirmation dialog handlers
  confirmDialogCancel.addEventListener("click", function () {
    hideConfirmDialog();
  });

  confirmDialogProceed.addEventListener("click", function () {
    hideConfirmDialog();
    
    // Stop any running operations
    if (AppState.collectionInProgress) {
      chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.STOP_COLLECTION }, function (response) {
        AppState.collectionInProgress = false;
        setCollectionButtonsState({ running: false, startLabel: "Restart Collection" });
      });
    }
    
    // Note: downloadInProgress will naturally stop when we switch views
    // as the download loop checks state
    AppState.downloadInProgress = false;
    
    showView('faq');
  });

  // Close dialog on overlay click
  confirmDialog.addEventListener("click", function (e) {
    if (e.target === confirmDialog) {
      hideConfirmDialog();
    }
  });

  // Initialize FAQ accordion
  initFaqAccordion();

  // Initialize copy-to-clipboard for FAQ links
  initCopyLinks();

  // Initialize export mode from storage
  chrome.storage.local.get(['exportMode'], (res) => {
    AppState.exportMode = res.exportMode || CONSTANTS.EXPORT_MODES.MULTIPLE;
    if (exportModeSelect) exportModeSelect.value = AppState.exportMode;
  });

  if (exportModeSelect) {
    exportModeSelect.addEventListener('change', () => {
      AppState.exportMode = exportModeSelect.value;
      chrome.storage.local.set({ exportMode: AppState.exportMode });
      // Update button label if present
      const btn = document.getElementById('downloadButton');
      if (btn) {
        const label = AppState.exportMode === CONSTANTS.EXPORT_MODES.SINGLE ? 'Download as Single File' : 'Download Selected Orders';
        btn.lastChild.nodeValue = ` ${label}`; // Keep icon, change text
      }
    });
  }

  // Function to check current tab and update UI
  function checkCurrentTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (!tabs || tabs.length === 0) {
        showOffTabWarning();
        return;
      }

      const tab = tabs[0];
      const url = tab.url;

      // Remove any existing warning banner
      const existingBanner = document.getElementById("offTabWarning");
      if (existingBanner) existingBanner.remove();

      const ordersBaseUrl = getWalmartOrdersBaseUrl(url);
      if (ordersBaseUrl) {
        const cleanUrl = url.replace(/\/$/, "");
        const orderPath = cleanUrl.split("/orders/")[1];
        AppState.currentOrdersUrl = ordersBaseUrl;

        // Re-enable all interactive elements
        setUIEnabled(true);

        // Check if there's an order number after /orders/
        if (orderPath && /^\d{10,}$/.test(orderPath.split("?")[0])) {
          // Individual order page - do NOT use cache, only show current order
          const orderNumber = orderPath.split("?")[0];
          console.log("Valid order number:", orderNumber);
          displayOrderNumbers([orderNumber]);

          // Hide unnecessary UI elements
          document.getElementById("pageLimitGroup").style.display = "none";
          document.getElementById("buttonGroup").style.display = "none";
          document.getElementById("progress").style.display = "none";
          const checkboxContainer = document.getElementsByClassName("checkbox-container")[0];
          if (checkboxContainer) checkboxContainer.style.display = "none";
          
          // Show the card for single order
          document.querySelector(".card").style.display = "block";
        } else {
          // Main orders page setup - show full UI
          document.getElementById("pageLimitGroup").style.display = "block";
          document.getElementById("buttonGroup").style.display = "flex";
          document.querySelector(".card").style.display = "block";
          AppState.currentOrdersUrl = ordersBaseUrl;
          loadCacheOnMainPage();
        }
      } else {
        // Not on Walmart orders - show warning but keep existing data
        AppState.currentOrdersUrl = null;
        showOffTabWarning();
      }
    });
  }

  // Show warning banner and disable buttons when not on Walmart orders tab
  function showOffTabWarning() {
    // Disable interactive elements but don't clear the order list
    setUIEnabled(false);

    // Add warning banner if not already present
    if (!document.getElementById("offTabWarning")) {
      const warningBanner = document.createElement("div");
      warningBanner.id = "offTabWarning";
      warningBanner.className = "off-tab-warning";
      warningBanner.innerHTML = `
        <div class="warning-content">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <span>Return to <a href="#" id="returnToWalmartLink">Walmart Orders</a> to continue</span>
        </div>
      `;
      
      // Insert at the top of body
      document.body.insertBefore(warningBanner, document.body.firstChild);
      
      // Add click handler to switch to Walmart orders tab or open new one
      document.getElementById("returnToWalmartLink").addEventListener("click", function(e) {
        e.preventDefault();
        switchToWalmartOrdersTab();
      });
    }

    // If we have no cached orders loaded yet, load them now
    chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.GET_PROGRESS }, function (response) {
      if (response && response.orderNumbers && response.orderNumbers.length > 0) {
        // Only update if we don't already have orders displayed
        const container = document.getElementById("orderNumbersContainer");
        if (!container.querySelector('.order-list') || container.querySelector('.order-list').children.length === 0) {
          displayOrderNumbers(response.orderNumbers, response.additionalFields);
        }
      }
    });
  }

  // Enable or disable UI elements
  function setUIEnabled(enabled) {
    const card = document.querySelector(".card");
    if (card) {
      card.style.opacity = enabled ? "1" : "0.6";
      // Use a class instead of pointer-events to allow scrolling but disable clicks
      card.classList.toggle('disabled-card', !enabled);
    }

    const downloadButton = document.getElementById("downloadButton");
    if (downloadButton) {
      downloadButton.disabled = !enabled;
      downloadButton.style.opacity = enabled ? "1" : "0.6";
      downloadButton.style.cursor = enabled ? "pointer" : "not-allowed";
    }

    setCheckboxesDisabled(!enabled);
  }

  // Switch to existing Walmart orders tab or open a new one
  function switchToWalmartOrdersTab() {
    const walmartOrderTabPatterns = CONSTANTS.URLS.WALMART_ORDER_DOMAINS.map((domain) => `https://${domain}/orders*`);
    // First, try to find an existing Walmart orders tab (US or Canada)
    chrome.tabs.query({ url: walmartOrderTabPatterns }, function(tabs) {
      if (tabs && tabs.length > 0) {
        // Switch to the first matching tab
        chrome.tabs.update(tabs[0].id, { active: true });
        chrome.windows.update(tabs[0].windowId, { focused: true });
        return;
      }

      // No existing tab, open a new one (US by default)
      chrome.tabs.create({ url: CONSTANTS.URLS.WALMART_ORDERS });
    });
  }

  function handleStartCollection() {
    if (!AppState.currentOrdersUrl) {
      showOffTabWarning();
      return;
    }

    const pageLimit = parseInt(pageLimitInput.value, 10);
    setCollectionButtonsState({ running: true });
    setButtonLoading(startButton, true);

    chrome.runtime.sendMessage(
      {
        action: CONSTANTS.MESSAGES.START_COLLECTION,
        url: AppState.currentOrdersUrl,
        pageLimit: pageLimit,
      },
      function (response) {
        if (response && response.status === "started") {
          updateProgress();
        }
        setButtonLoading(startButton, false);
      }
    );
  }

  function handleStopCollection() {
    setButtonLoading(stopButton, true);
    chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.STOP_COLLECTION }, function (response) {
      if (response && response.status === "stopped") {
        AppState.collectionInProgress = false;
        setCollectionButtonsState({ running: false, startLabel: "Restart Collection" });
      }
      setButtonLoading(stopButton, false);
    });
  }

  startButton.addEventListener("click", handleStartCollection);
  stopButton.addEventListener("click", handleStopCollection);

  // Initial check
  checkCurrentTab();

  // Listen for tab changes to update UI dynamically
  chrome.tabs.onActivated.addListener(function () {
    checkCurrentTab();
  });

  // Listen for tab URL changes
  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (changeInfo.status === 'complete') {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs[0] && tabs[0].id === tabId) {
          checkCurrentTab();
        }
      });
    }
  });

  // Add clear cache button (always visible)
  const clearCacheButton = document.createElement("button");
  clearCacheButton.id = "clearCache";
  clearCacheButton.className = CONSTANTS.CSS_CLASSES.BTN_CLEAR;
  clearCacheButton.style.display = "inline-flex"; // Always visible
  clearCacheButton.innerHTML = `
    ${renderIcon('TRASH')}
    <span class="btn-text">${CONSTANTS.TEXT.CLEAR_CACHE_BTN}</span>
  `;

  // Insert clear cache button into the button group
  const buttonGroup = document.querySelector(".button-group");
  buttonGroup.appendChild(clearCacheButton);

  // Initial check for clear cache button visibility
  updateClearCacheVisibility();

  // Add clear cache functionality
  clearCacheButton.addEventListener("click", async function () {
    setButtonLoading(clearCacheButton, true);
    
    // Clear invoice cache
    await clearAllInvoiceCache();
    
    chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.CLEAR_CACHE }, function (response) {
      if (response && response.status === "cache_cleared") {
        setButtonLoading(clearCacheButton, false);

        // Update the UI to show no orders
        displayOrderNumbers([]);
        
        // Hide the clear cache button
        updateClearCacheVisibility();

        // Show a message
        const progressElement = document.getElementById("progress");
        progressElement.textContent = "Cache cleared successfully";
        progressElement.style.display = "block";

        // Hide the message after 2 seconds
        setTimeout(() => {
          progressElement.style.display = "none";
        }, 2000);
      }
    });
  });

});

function setCollectionButtonsState({ running, startLabel = "Start Collection" }) {
  const startButton = document.getElementById("startCollection");
  const stopButton = document.getElementById("stopCollection");
  if (!startButton || !stopButton) return;

  startButton.style.display = running ? "none" : "inline-flex";
  stopButton.style.display = running ? "inline-flex" : "none";

  if (!running) {
    const label = startButton.querySelector(".btn-text");
    if (label) label.textContent = startLabel;
  }
}

// Function to load cache only on the main orders page
function loadCacheOnMainPage() {
  // Check for cached data on panel open
  chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.GET_PROGRESS }, function (response) {
    if (response && response.orderNumbers && response.orderNumbers.length > 0) {
      displayOrderNumbers(response.orderNumbers, response.additionalFields);

      // Show cache info
      const cachePages = Object.keys(response.pagesCached || {}).length;
      const cacheInfo = document.createElement("div");
      cacheInfo.className = "cache-info";

      // Format the cache timestamp
      let cacheTimeInfo = "";
      if (response.pagesCached && Object.keys(response.pagesCached).length > 0) {
        // Find the earliest timestamp from all cached pages
        const timestamps = Object.values(response.pagesCached)
          .map((page) => page.timestamp)
          .filter((ts) => ts);

        if (timestamps.length > 0) {
          const earliestTimestamp = Math.min(...timestamps);
          const cacheDate = new Date(earliestTimestamp);
          const formattedDate = cacheDate.toLocaleString();
          cacheTimeInfo = `<div class="cache-time">Cached on: ${formattedDate}</div>`;
        }
      }

      cacheInfo.innerHTML = `

        <div>
          <span>${CONSTANTS.TEXT.USING_CACHE} ${response.orderNumbers.length} ${CONSTANTS.TEXT.ORDERS} ${cachePages} ${CONSTANTS.TEXT.PAGES}</span>
          ${cacheTimeInfo}
        </div>
      `;

      // Add cache info to the UI (only if not already added)
      const cardClass = document.querySelector(".card");
      if (cardClass && !cardClass.querySelector('.cache-info')) {
        cardClass.appendChild(cacheInfo);
      }

      // Show rating hint
      if (response.orderNumbers.length > 4) {
        maybeShowRatingHint();
      }
    }
  });
}

function updateProgress() {
  chrome.runtime.sendMessage({ action: CONSTANTS.MESSAGES.GET_PROGRESS }, function (response) {
    if (response && response.isCollecting) {
      AppState.collectionInProgress = true;
      setCollectionButtonsState({ running: true });
      updateProgressUI(response.currentPage, response.pageLimit, true);
      displayOrderNumbers(response.orderNumbers, response.additionalFields);
      setTimeout(updateProgress, 1000);
      setCheckboxesDisabled(true);
    } else if (response) {
      AppState.collectionInProgress = false;
      updateProgressUI(response.currentPage, response.pageLimit, false);
      displayOrderNumbers(response.orderNumbers, response.additionalFields);
      setCollectionButtonsState({ running: false, startLabel: "Start Collection" });
      setCheckboxesDisabled(false);
    }
  });
}

function updateProgressUI(currentPage, pageLimit, inProgress) {
  const progressElement = document.getElementById("progress") || createProgressElement();
  const pageLimitText = pageLimit > 0 ? ` of ${pageLimit}` : "";
  progressElement.style.display = "block";

  // Hide placeholder when collection starts
  const placeholder = document.getElementById("collectionPlaceholder");
  if (placeholder && inProgress) {
    placeholder.style.display = "none";
  }

  if (inProgress) {
    console.log("Progress:", currentPage, pageLimit);
    progressElement.innerHTML = `
      <span class="loading-spinner" style="border-color: var(--primary); border-top-color: transparent;"></span>
      Fetching order numbers... Fetching Page ${currentPage}${pageLimitText} 
    `;
  } else {
    progressElement.textContent = `Collection ${pageLimit > 0 && currentPage >= pageLimit ? "reached limit" : "completed"}. Total pages: ${currentPage
    }`;
  }
}

function createProgressElement() {
  const progressElement = document.createElement("div");
  progressElement.id = "progress";
  document.body.insertBefore(progressElement, document.getElementById("orderNumbersContainer"));
  return progressElement;
}

function updateCheckboxCount(container) {
  const heading = container.querySelector("h3");
  const checked = container.querySelectorAll('input[type="checkbox"]:not(#selectAll):checked').length;
  const totalOrders = container.querySelectorAll('input[type="checkbox"]:not(#selectAll)').length;
  heading.textContent = `${CONSTANTS.TEXT.SELECT_ORDERS} (${totalOrders}) - Selected: ${checked}`;
}

function createCacheIndicator(orderNumber, onDelete) {
  const cacheIndicator = document.createElement("span");
  cacheIndicator.dataset.cacheIndicator = "true";
  cacheIndicator.style.cssText = CACHE_INDICATOR_STYLE;
  cacheIndicator.title = "Click to delete this order's cache";
  cacheIndicator.innerHTML = renderIcon('CACHE', 'var(--primary)');
  cacheIndicator.style.display = "inline-flex";

  cacheIndicator.addEventListener("click", async (e) => {
    e.stopPropagation();
    await deleteInvoiceCache(orderNumber);
    cacheIndicator.style.display = "none";
    if (onDelete) onDelete();
    updateClearCacheVisibility();
  });

  return cacheIndicator;
}

async function displayOrderNumbers(orderNumbers, additionalFields = {}) {
  const container = document.getElementById("orderNumbersContainer");
  
  // If no orders, show placeholder
  if (orderNumbers.length === 0) {
    container.innerHTML = initialOrderPlaceholderHtml || "";
    updateClearCacheVisibility();
    return;
  }
  
  container.innerHTML = `<h3>${CONSTANTS.TEXT.SELECT_ORDERS} (${orderNumbers.length}) - Selected: 0</h3>`;

  // Get cached order numbers
  const cachedOrders = await getCachedOrderNumbers();
  const cachedSet = new Set(cachedOrders);

  // Create select all checkbox
  const selectAllDiv = document.createElement("div");
  selectAllDiv.className = CONSTANTS.CSS_CLASSES.CHECKBOX_CONTAINER;
  const selectAll = document.createElement("input");
  selectAll.type = "checkbox";
  selectAll.id = "selectAll";
  const selectAllLabel = document.createElement("label");
  selectAllLabel.htmlFor = "selectAll";
  selectAllLabel.appendChild(document.createTextNode(CONSTANTS.TEXT.SELECT_ALL));
  selectAllDiv.appendChild(selectAll);
  selectAllDiv.appendChild(selectAllLabel);
  container.appendChild(selectAllDiv);

  // Create order list container with scrollable area
  const orderList = document.createElement("div");
  orderList.className = "order-list";

  // Add individual order checkboxes with cache icons
  orderNumbers.forEach((orderNumber) => {
    const tooltip = additionalFields && additionalFields[orderNumber] ? additionalFields[orderNumber] : null;
    const checkboxDiv = createCheckboxElement({
      id: orderNumber,
      value: orderNumber,
      label: `${CONSTANTS.TEXT.ORDER_PREFIX}${orderNumber}`,
      tooltip: tooltip,
    });

    // Add cache indicator if cached
    if (cachedSet.has(orderNumber)) {
      const cacheIndicator = createCacheIndicator(orderNumber, () => cachedSet.delete(orderNumber));
      checkboxDiv.appendChild(cacheIndicator);
    }

    orderList.appendChild(checkboxDiv);
  });

  container.appendChild(orderList);

  // Add select all functionality
  selectAll.addEventListener("change", function () {
    toggleAllCheckboxes(orderList, selectAll.checked);
    updateCheckboxCount(container);
  });

  // Update count on individual checkbox changes
  orderNumbers.forEach((orderNumber) => {
    const checkbox = container.querySelector(`input[value="${orderNumber}"]`);
    if (checkbox) {
      checkbox.addEventListener("change", () => updateCheckboxCount(container));
    }
  });

  // Add download button if there are order numbers
  if (orderNumbers.length > 0 && !document.getElementById("downloadButton")) {
    const downloadButton = document.createElement("button");
    downloadButton.id = "downloadButton";
    downloadButton.className = CONSTANTS.CSS_CLASSES.BTN_SUCCESS;
    const label = AppState.exportMode === CONSTANTS.EXPORT_MODES.SINGLE ? 'Download as Single File' : 'Download Selected Orders';
    downloadButton.innerHTML = `
      ${renderIcon('DOWNLOAD')}
      ${label}
    `;
    downloadButton.addEventListener("click", downloadSelectedOrders);
    container.appendChild(downloadButton);
  }

  // Update clear cache button visibility
  updateClearCacheVisibility();
}

// Ensure the clear cache button is always visible; apply a muted visual state when there's nothing cached
async function updateClearCacheVisibility() {
  const clearCacheBtn = document.getElementById("clearCache");
  if (!clearCacheBtn) return;

  // Always keep the button visible so users can clear caches anytime.
  // Use a subtle "muted" style when there are no invoice cache entries.
  const cachedOrders = await getCachedOrderNumbers();
  clearCacheBtn.style.display = "inline-flex";

  if (cachedOrders && cachedOrders.length > 0) {
    clearCacheBtn.classList.remove('muted');
    clearCacheBtn.disabled = false;
    clearCacheBtn.setAttribute('title', 'Clear cached invoices');
  } else {
    // Keep it clickable (user may want to clear other caches); visually mute it to indicate no per-order cache.
    clearCacheBtn.classList.add('muted');
    clearCacheBtn.disabled = false;
    clearCacheBtn.setAttribute('title', 'No invoice cache found — click to ensure caches are cleared');
  }
} 

function updateOrderCacheStatus(orderNumber) {
  const container = document.getElementById("orderNumbersContainer");
  if (!container) return;
  
  const checkbox = container.querySelector(`input[value="${orderNumber}"]`);
  if (!checkbox) return;
  
  const checkboxDiv = checkbox.closest('.checkbox-container');
  if (!checkboxDiv) return;

  const existingIndicator = checkboxDiv.querySelector(CACHE_INDICATOR_SELECTOR);
  if (existingIndicator) {
    existingIndicator.style.display = 'inline-flex';
    updateClearCacheVisibility();
    return;
  }

  checkboxDiv.appendChild(createCacheIndicator(orderNumber));
  
  // Update global clear cache button when new item is cached
  updateClearCacheVisibility();
}

const OrderDataFetcher = (() => {
  let downloadTab = null;

  const buildOrderUrls = (orderNumber) => {
    const ordersBaseUrl = AppState.currentOrdersUrl || CONSTANTS.URLS.WALMART_ORDERS;
    const baseUrl = `${ordersBaseUrl}/${orderNumber}`;
    const isLongOrderNumber = orderNumber.length >= 20;
    if (isLongOrderNumber) {
      return [`${baseUrl}?storePurchase=true`, baseUrl];
    }
    return [baseUrl, `${baseUrl}?storePurchase=true`];
  };

  const ensureTab = async (url) => {
    if (!downloadTab) {
      downloadTab = await ChromeApi.tabsCreate({ url, active: false });
      return downloadTab;
    }

    try {
      await ChromeApi.tabsGet(downloadTab.id);
      await ChromeApi.tabsUpdate(downloadTab.id, { url });
    } catch (error) {
      downloadTab = await ChromeApi.tabsCreate({ url, active: false });
    }

    return downloadTab;
  };

  const createTabLoadWaiter = (tabId) => {
    let listener = null;
    const promise = new Promise((resolve) => {
      listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    const cleanup = () => {
      if (listener) {
        chrome.tabs.onUpdated.removeListener(listener);
        listener = null;
      }
    };

    return { promise, cleanup };
  };

  const fetchFromUrl = async (orderNumber, url, options = {}) => {
    const { timeoutMs = CONSTANTS.TIMING.DOWNLOAD_TIMEOUT, stabilizeDelayMs = 1000 } = options;
    const tab = await ensureTab(url);

    const { promise, cleanup } = createTabLoadWaiter(tab.id);
    try {
      await promiseWithTimeout(promise, timeoutMs, `Timeout loading order #${orderNumber}`);
    } finally {
      cleanup();
    }

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
    updateOrderCacheStatus(orderNumber);
    return response.data;
  };

  const fetchOrderData = async (orderNumber, options = {}) => {
    const cachedData = await getCachedInvoice(orderNumber);
    if (cachedData) {
      console.log(`Using cached data for order ${orderNumber}`);
      updateOrderCacheStatus(orderNumber);
      return cachedData;
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

function createDownloadProgressElement() {
  let progressDiv = document.getElementById("downloadProgress");
  if (!progressDiv) {
    progressDiv = document.createElement("div");
    progressDiv.id = "downloadProgress";
    const progressElement = document.getElementById("progress");
    progressElement.style.display = "none";
    progressElement.insertAdjacentElement("afterend", progressDiv);
  }
  return progressDiv;
}

async function downloadSelectedOrders() {
  try {
    if (AppState && AppState.downloadInProgress) {
      alert("Downloads are already in progress. Please wait.");
      return;
    }

    const selectedOrders = getSelectedOrderNumbers();

    if (selectedOrders.length === 0) {
      alert("Please select at least one order to download.");
      return;
    }

    const downloadButton = document.getElementById("downloadButton");
    downloadButton.disabled = true;
    setButtonLoading(downloadButton, true);
    
    // Ensure AppState is properly initialized
    if (AppState) {
      AppState.downloadInProgress = true;
    }
    
    const failedOrders = [];
    const progressDiv = createDownloadProgressElement();

    // Route based on export mode
    try {
      if (AppState && AppState.exportMode === CONSTANTS.EXPORT_MODES.SINGLE) {
        await downloadCombinedOrders(selectedOrders, failedOrders, progressDiv);
      } else {
        await downloadMultipleOrders(selectedOrders, failedOrders, progressDiv);
      }
    } catch (error) {
      console.error("Download error:", error);
      alert("An error occurred during download process. Some orders may have failed.");
    } finally {
      await OrderDataFetcher.cleanup();
      downloadButton.disabled = false;
      setButtonLoading(downloadButton, false);
      if (AppState) {
        AppState.downloadInProgress = false;
      }
    }
  } catch (outerError) {
    console.error("Error in downloadSelectedOrders:", outerError);
  }
}

async function downloadMultipleOrders(selectedOrders, failedOrders, progressDiv) {
  const options = { timeoutMs: CONSTANTS.TIMING.DOWNLOAD_TIMEOUT, stabilizeDelayMs: 1000 };

  for (let i = 0; i < selectedOrders.length; i++) {
    // Check if download should continue
    if (!AppState || !AppState.downloadInProgress) {
      if (progressDiv && progressDiv.parentNode) {
        progressDiv.remove();
      }
      return;
    }

    const orderNumber = selectedOrders[i];
    progressDiv.innerHTML = createProgressMessage(
      i + 1,
      selectedOrders.length,
      CONSTANTS.TEXT.DOWNLOADING,
      orderNumber
    );

    try {
      const data = await OrderDataFetcher.fetchOrderData(orderNumber, options);
      convertToXlsx(data, ExcelJS, { mode: 'single' });
    } catch (error) {
      console.error(`Error downloading order #${orderNumber}:`, error);
      failedOrders.push(orderNumber);
    }

    await delay(CONSTANTS.TIMING.RETRY_DELAY);
  }

  if (failedOrders.length === 0) {
    progressDiv.innerHTML = createSuccessMessage('All downloads completed successfully!');
  } else {
    progressDiv.innerHTML = createErrorMessage(
      `Downloads completed with ${failedOrders.length} failed orders:\nFailed orders: ${failedOrders.map((order) => `#${order}`).join(", ")}`
    );
  }
  setTimeout(() => progressDiv.remove(), failedOrders.length > 0 ? CONSTANTS.TIMING.ERROR_DISPLAY_DURATION : CONSTANTS.TIMING.SUCCESS_DISPLAY_DURATION);

  if (failedOrders.length === 0) {
    maybeShowRatingHint();
  }
}

// Combined export: build one workbook in panel with ExcelJS
async function downloadCombinedOrders(selectedOrders, failedOrders, progressDiv) {
  const collectedOrdersData = [];
  const options = { timeoutMs: CONSTANTS.TIMING.COLLECTION_TIMEOUT, stabilizeDelayMs: CONSTANTS.TIMING.PAGE_LOAD_WAIT };

  for (let i = 0; i < selectedOrders.length; i++) {
    // Check if download should continue
    if (!AppState || !AppState.downloadInProgress) {
      if (progressDiv && progressDiv.parentNode) {
        progressDiv.remove();
      }
      return;
    }

    const orderNumber = selectedOrders[i];
    progressDiv.innerHTML = createProgressMessage(
      i + 1,
      selectedOrders.length,
      CONSTANTS.TEXT.COLLECTING,
      orderNumber
    );

    try {
      const data = await OrderDataFetcher.fetchOrderData(orderNumber, options);
      collectedOrdersData.push(data);
    } catch (e) {
      console.error('Failed to collect data for', orderNumber, e);
      failedOrders.push(orderNumber);
    }

    await delay(CONSTANTS.TIMING.RETRY_DELAY);
  }

  try {
    await convertMultipleOrdersToXlsx(collectedOrdersData, ExcelJS, 'Walmart_Orders.xlsx');
  } catch (e) {
    console.error('Failed to export to XLSX:', e);
    progressDiv.innerHTML = createErrorMessage(`Export failed: ${e.message}`);
    setTimeout(() => progressDiv.remove(), CONSTANTS.TIMING.EXPORT_FAIL_DISPLAY);
    return;
  }

  if (failedOrders.length === 0) {
    progressDiv.innerHTML = createSuccessMessage(CONSTANTS.TEXT.EXPORT_SUCCESS);
  } else {
    progressDiv.innerHTML = createErrorMessage(
      `Export completed with ${failedOrders.length} failures: ${failedOrders.map((o) => `#${o}`).join(', ')}`
    );
  }
  setTimeout(() => progressDiv.remove(), failedOrders.length > 0 ? CONSTANTS.TIMING.ERROR_DISPLAY_DURATION : CONSTANTS.TIMING.SUCCESS_DISPLAY_DURATION);

  if (failedOrders.length === 0) {
    maybeShowRatingHint();
  }
}

// Helper function to set loading state on any button
function setButtonLoading(button, isLoading) {
  const btnText = button.querySelector(".btn-text");
  if (isLoading) {
    button.disabled = true;
    // Only add spinner if one doesn't already exist
    if (!button.querySelector(".loading-spinner")) {
      const spinner = document.createElement("span");
      spinner.className = "loading-spinner";
      // Insert before btn-text if it exists, otherwise as first child
      button.insertBefore(spinner, btnText || button.firstChild);
    }
  } else {
    button.disabled = false;
    const spinner = button.querySelector(".loading-spinner");
    if (spinner) spinner.remove();
  }
}

function maybeShowRatingHint() {
  // Show 80% of the time after a successful action
  if (Math.random() > 0.8) return;

  // First check if hint has been dismissed in current session
  chrome.storage.local.get([CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISSED], function (sessionResult) {
    if (sessionResult[CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISSED]) return;

    // Then check if hint has been dismissed 5 times in total (using local storage)
    chrome.storage.local.get([CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISS_COUNT], function (localResult) {
      const dismissCount = localResult[CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISS_COUNT] || 0;

      // If dismissed 7 or more times, never show again
      if (dismissCount >= 7) return;

      // Create rating hint element if it doesn't exist
      let ratingHint = document.getElementById("ratingHint");
      if (!ratingHint) {
        ratingHint = document.createElement("div");
        ratingHint.id = "ratingHint";
        ratingHint.className = "rating-hint";
        ratingHint.innerHTML = `
        <a href="${CONSTANTS.URLS.WALMART_REVIEWS}" target="_blank">
          ${renderIcon('STAR')}
          Find this helpful? Consider rating it
        </a>
        <button class="dismiss-hint" title="Don't show again">
          ${renderIcon('X_CLOSE')}
        </button>
      `;

        // Add it to the UI
        const downloadButton = document.getElementById("downloadButton");
        downloadButton.insertAdjacentElement("afterend", ratingHint);

        // Handle dismiss click
        ratingHint.querySelector(".dismiss-hint").addEventListener("click", function () {
          ratingHint.classList.remove("show");

          // Mark dismissed for current browser session (cleared on startup)
          chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISSED]: true });

          // Increment dismiss count in local storage
          chrome.storage.local.get([CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISS_COUNT], function (result) {
            const newCount = (result[CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISS_COUNT] || 0) + 1;
            chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.RATING_HINT_DISMISS_COUNT]: newCount });

            console.log(`Rating hint dismissed ${newCount} times in total`);
          });
        });
      }

      // Show the hint
      setTimeout(() => {
        ratingHint.classList.add("show");
      }, CONSTANTS.TIMING.RATING_DELAY);
    });
  });
}

// FAQ Accordion functionality
function initFaqAccordion() {
  document.querySelectorAll(".faq-question").forEach((question) => {
    question.addEventListener("click", () => {
      const answer = question.nextElementSibling;
      const arrow = question.querySelector(".arrow");

      // Toggle current item
      answer.classList.toggle("active");
      arrow.classList.toggle("active");

      // Close other items
      document.querySelectorAll(".faq-answer").forEach((otherAnswer) => {
        if (otherAnswer !== answer && otherAnswer.classList.contains("active")) {
          otherAnswer.classList.remove("active");
          otherAnswer.previousElementSibling.querySelector(".arrow").classList.remove("active");
        }
      });
    });
  });
}

// Copy-to-clipboard for FAQ links
function initCopyLinks() {
  const toast = document.getElementById("toast");
  
  document.querySelectorAll(".copy-link").forEach((link) => {
    link.style.cursor = "pointer";
    link.addEventListener("click", async () => {
      const linkText = link.dataset.link;
      try {
        await navigator.clipboard.writeText(linkText);
        toast.classList.add("show");
        setTimeout(() => {
          toast.classList.remove("show");
        }, 2000);
      } catch (err) {
        console.error("Failed to copy text: ", err);
      }
    });
  });
}
