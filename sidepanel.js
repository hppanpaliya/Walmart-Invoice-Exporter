let allOrderNumbers = new Set();
let downloadInProgress = false;
let collectionInProgress = false;
let exportMode = 'multiple'; // 'multiple' | 'single'
let lastWalmartOrdersTabId = null; // Track the last known Walmart orders tab
let currentView = 'main'; // 'main' | 'faq'

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
      currentView = 'faq';
    } else {
      faqView.classList.remove('active');
      mainView.classList.add('active');
      currentView = 'main';
      // Refresh the main view state
      checkCurrentTab();
    }
  }

  function isOperationRunning() {
    return downloadInProgress || collectionInProgress;
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
      const opType = collectionInProgress ? 'collection' : 'download';
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
    if (collectionInProgress) {
      chrome.runtime.sendMessage({ action: "stopCollection" }, function (response) {
        collectionInProgress = false;
        // Update UI
        document.getElementById("stopCollection").style.display = "none";
        document.getElementById("startCollection").style.display = "inline-flex";
        document.getElementById("startCollection").querySelector(".btn-text").textContent = "Restart Collection";
      });
    }
    
    // Note: downloadInProgress will naturally stop when we switch views
    // as the download loop checks state
    downloadInProgress = false;
    
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
    exportMode = res.exportMode || 'multiple';
    if (exportModeSelect) exportModeSelect.value = exportMode;
  });

  if (exportModeSelect) {
    exportModeSelect.addEventListener('change', () => {
      exportMode = exportModeSelect.value;
      chrome.storage.local.set({ exportMode });
      // Update button label if present
      const btn = document.getElementById('downloadButton');
      if (btn) {
        const label = exportMode === 'single' ? 'Download as Single File' : 'Download Selected Orders';
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

      if (url && url.startsWith("https://www.walmart.com/orders")) {
        // Track this tab as a valid Walmart orders tab
        lastWalmartOrdersTabId = tab.id;
        
        const cleanUrl = url.replace(/\/$/, "");
        const orderPath = cleanUrl.split("/orders/")[1];

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
          
          setupCollectionButtons(url);
          loadCacheOnMainPage();
        }
      } else {
        // Not on Walmart orders - show warning but keep existing data
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
    chrome.runtime.sendMessage({ action: "getProgress" }, function (response) {
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

    // Disable/enable all checkboxes and buttons within the card
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => {
      cb.disabled = !enabled;
    });
  }

  // Switch to existing Walmart orders tab or open a new one
  function switchToWalmartOrdersTab() {
    // First, try to find an existing Walmart orders tab
    chrome.tabs.query({ url: "https://www.walmart.com/orders*" }, function(tabs) {
      if (tabs && tabs.length > 0) {
        // Switch to the first matching tab
        chrome.tabs.update(tabs[0].id, { active: true });
        chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        // No existing tab, open a new one
        chrome.tabs.create({ url: CONSTANTS.URLS.WALMART_ORDERS });
      }
    });
  }

  function showNotOnWalmartMessage() {
    document.querySelector(".card").style.display = "none";
    orderNumbersContainer.innerHTML = `
      <div class="card" style="text-align: center; padding: 24px;">
        ${renderIcon('ERROR_LARGE')}
        <p style="color: var(--text); font-size: 16px; margin-bottom: 8px;">Please navigate to</p>
        <p style="color: var(--primary); font-weight: 500; margin-bottom: 16px;"><a href="${CONSTANTS.URLS.WALMART_ORDERS}" target="_blank">walmart.com/orders</a></p>
        <p style="color: var(--text-secondary); font-size: 14px;">to use this extension.</p>
      </div>`;
  }

  function setupCollectionButtons(url) {
    // Remove old event listeners by cloning
    const oldStartButton = document.getElementById("startCollection");
    const newStartButton = oldStartButton.cloneNode(true);
    oldStartButton.parentNode.replaceChild(newStartButton, oldStartButton);

    const oldStopButton = document.getElementById("stopCollection");
    const newStopButton = oldStopButton.cloneNode(true);
    oldStopButton.parentNode.replaceChild(newStopButton, oldStopButton);

    newStartButton.addEventListener("click", function () {
      const pageLimit = parseInt(pageLimitInput.value, 10);
      newStartButton.style.display = "none";
      newStopButton.style.display = "inline-flex";
      setButtonLoading(newStartButton, true);

      chrome.runtime.sendMessage(
        {
          action: "startCollection",
          url: url,
          pageLimit: pageLimit,
        },
        function (response) {
          if (response && response.status === "started") {
            updateProgress();
          }
          setButtonLoading(newStartButton, false);
        }
      );
    });

    newStopButton.addEventListener("click", function () {
      setButtonLoading(newStopButton, true);
      chrome.runtime.sendMessage({ action: "stopCollection" }, function (response) {
        if (response && response.status === "stopped") {
          newStopButton.style.display = "none";
          newStartButton.style.display = "inline-flex";
          newStartButton.querySelector(".btn-text").textContent = "Restart Collection";
          setButtonLoading(newStopButton, false);
        }
      });
    });
  }

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

  // Add clear cache button
  const clearCacheButton = document.createElement("button");
  clearCacheButton.id = "clearCache";
  clearCacheButton.className = CONSTANTS.CSS_CLASSES.BTN_CLEAR;
  clearCacheButton.innerHTML = `
    ${renderIcon('TRASH')}
    <span class="btn-text">${CONSTANTS.TEXT.CLEAR_CACHE_BTN}</span>
  `;

  // Insert clear cache button into the button group
  const buttonGroup = document.querySelector(".button-group");
  buttonGroup.appendChild(clearCacheButton);

  // Add clear cache functionality
  clearCacheButton.addEventListener("click", async function () {
    setButtonLoading(clearCacheButton, true);
    
    // Clear invoice cache
    await clearAllInvoiceCache();
    
    chrome.runtime.sendMessage({ action: "clearCache" }, function (response) {
      if (response && response.status === "cache_cleared") {
        setButtonLoading(clearCacheButton, false);

        // Update the UI to show no orders
        displayOrderNumbers([]);

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

// Function to load cache only on the main orders page
function loadCacheOnMainPage() {
  // Check for cached data on panel open
  chrome.runtime.sendMessage({ action: "getProgress" }, function (response) {
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
  chrome.runtime.sendMessage({ action: "getProgress" }, function (response) {
    if (response && response.isCollecting) {
      collectionInProgress = true;
      updateProgressUI(response.currentPage, response.pageLimit, true);
      displayOrderNumbers(response.orderNumbers, response.additionalFields);
      setTimeout(updateProgress, 1000);
      // set all checkboxes to disabled
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach((cb) => (cb.disabled = true));
    } else if (response) {
      collectionInProgress = false;
      updateProgressUI(response.currentPage, response.pageLimit, false);
      displayOrderNumbers(response.orderNumbers, response.additionalFields);
      document.getElementById("startCollection").style.display = "inline-flex";
      document.getElementById("stopCollection").style.display = "none";
      document.getElementById("startCollection").querySelector(".btn-text").textContent = "Start Collection";
      // set all checkboxes to enabled
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach((cb) => (cb.disabled = false));
    }
  });
}

function updateProgressUI(currentPage, pageLimit, inProgress) {
  const progressElement = document.getElementById("progress") || createProgressElement();
  const pageLimitText = pageLimit > 0 ? ` of ${pageLimit}` : "";
  document.getElementById("progress").style.display = "block";

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
  const total = container.querySelectorAll('input[type="checkbox"]:not(#selectAll)').length;
  const checked = container.querySelectorAll('input[type="checkbox"]:not(#selectAll):checked').length;
  const totalOrders = container.querySelectorAll('input[type="checkbox"]:not(#selectAll)').length;
  heading.textContent = `${CONSTANTS.TEXT.SELECT_ORDERS} (${totalOrders}) - Selected: ${checked}`;
}

async function displayOrderNumbers(orderNumbers, additionalFields = {}) {
  const container = document.getElementById("orderNumbersContainer");
  
  // If no orders, show placeholder
  if (orderNumbers.length === 0) {
    container.innerHTML = `
      <div id="collectionPlaceholder">
        <p class="placeholder-status">Collection has not started. Total pages: 0</p>
        <h3>Select orders to download (0) - Selected: 0</h3>
        <div class="checkbox-container">
          <input type="checkbox" id="selectAllPlaceholder" disabled>
          <label for="selectAllPlaceholder">Select All</label>
        </div>
        <div class="order-list placeholder-list">
          <p class="no-orders-message">No orders collected yet.</p>
        </div>
        <button id="downloadButtonPlaceholder" class="btn btn-success" disabled>
          ${renderIcon('DOWNLOAD')}
          Download as Single File
        </button>
      </div>
    `;
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
      const cacheIndicator = document.createElement("span");
      cacheIndicator.style.cssText = 'cursor: pointer; margin-left: 6px; color: var(--primary); display: inline-flex; align-items: center; gap: 2px; font-size: 10px;';
      cacheIndicator.title = 'Click to delete this order\'s cache';
      cacheIndicator.innerHTML = renderIcon('CACHE', 'var(--primary)');
      cacheIndicator.style.display = 'inline-flex';
      
      cacheIndicator.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteInvoiceCache(orderNumber);
        cachedSet.delete(orderNumber);
        cacheIndicator.style.display = 'none';
      });

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
    const label = exportMode === CONSTANTS.EXPORT_MODES.SINGLE ? 'Download as Single File' : 'Download Selected Orders';
    downloadButton.innerHTML = `
      ${renderIcon('DOWNLOAD')}
      ${label}
    `;
    downloadButton.addEventListener("click", downloadSelectedOrders);
    container.appendChild(downloadButton);
  }
}

async function downloadSelectedOrders() {
  if (downloadInProgress) {
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
  downloadInProgress = true;
  const failedOrders = [];

  // Route based on export mode
  if (exportMode === CONSTANTS.EXPORT_MODES.SINGLE) {
    try {
      await downloadCombinedSelectedOrders(selectedOrders, failedOrders);
    } catch (e) {
      console.error('Combined export failed:', e);
      alert('An error occurred creating the combined spreadsheet.');
    } finally {
      downloadButton.disabled = false;
      setButtonLoading(downloadButton, false);
      downloadInProgress = false;
    }
    return;
  }

  // Multiple files flow (existing)
  let downloadTab = null;

  // Helper function to check if tab still exists
  async function isTabValid(tabId) {
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  }

  // Helper function to attempt download with specific URL
  async function attemptDownload(orderNumber, url, attempt) {
    try {
      // Check cache first - if cached, use it and create Excel file directly
      const cachedData = await getCachedInvoice(orderNumber);
      if (cachedData) {
        console.log(`Using cached data for order ${orderNumber}`);
        // Convert cached data to Excel directly without opening tab
        convertToXlsx(cachedData, ExcelJS, { mode: 'single' });
        return true;
      }

      // Not cached, so fetch from page
      // Create or reuse tab (check if existing tab is still valid)
      if (!downloadTab || !(await isTabValid(downloadTab.id))) {
        downloadTab = await new Promise((resolve) => {
          chrome.tabs.create({ url: url, active: false }, resolve);
        });
      } else {
        await new Promise((resolve, reject) => {
          chrome.tabs.update(downloadTab.id, { url: url }, (tab) => {
            if (chrome.runtime.lastError) {
              // Tab was closed, create a new one
              chrome.tabs.create({ url: url, active: false }, (newTab) => {
                downloadTab = newTab;
                resolve();
              });
            } else {
              resolve();
            }
          });
        });
      }

      // Wait for page load and trigger download with timeout
      await Promise.race([
        new Promise((resolve, reject) => {
          async function handleDownload(tabId, info) {
            if (downloadTab && tabId === downloadTab.id && info.status === "complete") {
              chrome.tabs.onUpdated.removeListener(handleDownload);

              try {
                // First, block images
                await new Promise((blockResolve) => {
                  chrome.tabs.sendMessage(downloadTab.id, { action: "blockImagesForDownload" }, (response) => {
                    if (chrome.runtime.lastError) {
                      console.error("Error blocking images:", chrome.runtime.lastError);
                    }
                    // Continue even if blocking fails
                    blockResolve();
                  });
                });

                // Wait a bit longer for the page to stabilize
                await new Promise((r) => setTimeout(r, 1000));

                // Get the order data and cache it
                chrome.tabs.sendMessage(downloadTab.id, { method: "getOrderData" }, async (response) => {
                  if (chrome.runtime.lastError) {
                    reject(new Error(`Failed to download order #${orderNumber}: ${chrome.runtime.lastError.message}`));
                  } else if (response && response.data) {
                    // Cache the data
                    await cacheInvoice(orderNumber, response.data);
                    // Convert to Excel
                    convertToXlsx(response.data, ExcelJS, { mode: 'single' });
                    resolve();
                  } else {
                    reject(new Error(`No data received for order #${orderNumber}`));
                  }
                });
              } catch (error) {
                reject(error);
              }
            }
          }

          chrome.tabs.onUpdated.addListener(handleDownload);
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout downloading order #${orderNumber}`)), CONSTANTS.TIMING.DOWNLOAD_TIMEOUT)),
      ]);

      return true; // Download successful
    } catch (error) {
      console.error(`Error downloading order #${orderNumber} (attempt ${attempt}):`, error);
      return false; // Download failed
    }
  }

  try {
    // Create progress indicator
    const progressDiv = document.createElement("div");
    progressDiv.id = "downloadProgress";
    document.getElementById("progress").style.display = "none";
    document.getElementById("progress").insertAdjacentElement("afterend", progressDiv);

    for (let i = 0; i < selectedOrders.length; i++) {
      const orderNumber = selectedOrders[i];
      progressDiv.innerHTML = createProgressMessage(
        i + 1,
        selectedOrders.length,
        CONSTANTS.TEXT.DOWNLOADING,
        orderNumber
      );

      let downloadSuccess = false;
      const isLongOrderNumber = orderNumber.length >= 20;

      // First attempt with default parameter based on order number length
      let firstAttemptUrl = `${CONSTANTS.URLS.WALMART_ORDERS}/${orderNumber}${isLongOrderNumber ? "?storePurchase=true" : ""}`;
      downloadSuccess = await attemptDownload(orderNumber, firstAttemptUrl, 1);

      // If first attempt fails, try with opposite parameter
      if (!downloadSuccess) {
        progressDiv.innerHTML = createProgressMessage(
          i + 1,
          selectedOrders.length,
          CONSTANTS.TEXT.RETRY_PREFIX,
          orderNumber
        );

        let secondAttemptUrl = `${CONSTANTS.URLS.WALMART_ORDERS}/${orderNumber}${isLongOrderNumber ? "" : "?storePurchase=true"}`;
        downloadSuccess = await attemptDownload(orderNumber, secondAttemptUrl, 2);
      }

      // If both attempts fail, add to failed orders
      if (!downloadSuccess) {
        failedOrders.push(orderNumber);
      }

      await delay(500);
    }

    // Cleanup
    if (downloadTab) {
      chrome.tabs.remove(downloadTab.id).catch(() => {
        // Tab may already be closed
      });
    }

    // Show completion message with failed orders if any
    if (failedOrders.length === 0) {
      progressDiv.innerHTML = createSuccessMessage('All downloads completed successfully!');
    } else {
      progressDiv.innerHTML = createErrorMessage(
        `Downloads completed with ${failedOrders.length} failed orders:\nFailed orders: ${failedOrders.map((order) => `#${order}`).join(", ")}`
      );
    }
    setTimeout(() => progressDiv.remove(), failedOrders.length > 0 ? CONSTANTS.TIMING.ERROR_DISPLAY_DURATION : CONSTANTS.TIMING.SUCCESS_DISPLAY_DURATION);

    // Show rating hint
    if (failedOrders.length === 0) {
      maybeShowRatingHint();
    }
  } catch (error) {
    console.error("Download error:", error);
    alert("An error occurred during download process. Some orders may have failed.");
    if (downloadTab) {
      chrome.tabs.remove(downloadTab.id).catch(() => {
        // Tab may already be closed
      });
    }
  } finally {
    downloadButton.disabled = false;
    setButtonLoading(downloadButton, false);
    downloadInProgress = false;
  }
}

// Combined export: build one workbook in panel with ExcelJS
async function downloadCombinedSelectedOrders(selectedOrders, failedOrders) {
  // Create progress indicator
  const progressDiv = document.createElement("div");
  progressDiv.id = "downloadProgress";
  document.getElementById("progress").style.display = "none";
  document.getElementById("progress").insertAdjacentElement("afterend", progressDiv);

  let downloadTab = null;
  const collectedOrdersData = [];

  // Helper function to check if tab still exists
  const isTabValidForCombined = async (tabId) => {
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  };

  // Helper to navigate and get data with retry for storePurchase param
  const getDataForOrder = async (orderNumber, attempt = 1) => {
    // Check cache first
    const cachedData = await getCachedInvoice(orderNumber);
    if (cachedData) {
      console.log(`Using cached data for order ${orderNumber}`);
      return cachedData;
    }

    const isLongOrderNumber = orderNumber.length >= 20;
    const firstAttemptUrl = `${CONSTANTS.URLS.WALMART_ORDERS}/${orderNumber}${isLongOrderNumber ? "?storePurchase=true" : ""}`;
    const secondAttemptUrl = `${CONSTANTS.URLS.WALMART_ORDERS}/${orderNumber}${isLongOrderNumber ? "" : "?storePurchase=true"}`;

    const tryUrl = async (url) => {
      // Create or reuse tab (check if existing tab is still valid)
      if (!downloadTab || !(await isTabValidForCombined(downloadTab.id))) {
        downloadTab = await new Promise((resolve) => {
          chrome.tabs.create({ url, active: false }, resolve);
        });
      } else {
        await new Promise((resolve) => {
          chrome.tabs.update(downloadTab.id, { url }, (tab) => {
            if (chrome.runtime.lastError) {
              // Tab was closed, create a new one
              chrome.tabs.create({ url, active: false }, (newTab) => {
                downloadTab = newTab;
                resolve();
              });
            } else {
              resolve();
            }
          });
        });
      }

      // Wait for load and request data
      return await Promise.race([
        new Promise((resolve, reject) => {
          const handle = async (tabId, info) => {
            if (downloadTab && tabId === downloadTab.id && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(handle);
              try {
                // Block images then request data
                await new Promise((r) => {
                  chrome.tabs.sendMessage(downloadTab.id, { action: 'blockImagesForDownload' }, () => r());
                });
                await new Promise((r) => setTimeout(r, 800));
                chrome.tabs.sendMessage(downloadTab.id, { method: 'getOrderData' }, async (resp) => {
                  if (chrome.runtime.lastError || !resp || !resp.data) {
                    reject(new Error('Failed to get data'));
                  } else {
                    // Cache the data
                    await cacheInvoice(orderNumber, resp.data);
                    resolve(resp.data);
                  }
                });
              } catch (err) {
                reject(err);
              }
            }
          };
          chrome.tabs.onUpdated.addListener(handle);
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout getting data')), CONSTANTS.TIMING.COLLECTION_TIMEOUT)),
      ]);
    };

    try {
      return await tryUrl(firstAttemptUrl);
    } catch (_) {
      return await tryUrl(secondAttemptUrl);
    }
  };

  // Collect data for all selected orders
  for (let i = 0; i < selectedOrders.length; i++) {
    const orderNumber = selectedOrders[i];
    progressDiv.innerHTML = createProgressMessage(
      i + 1,
      selectedOrders.length,
      CONSTANTS.TEXT.COLLECTING,
      orderNumber
    );

    try {
      const data = await getDataForOrder(orderNumber);
      collectedOrdersData.push(data);
    } catch (e) {
      console.error('Failed to collect data for', orderNumber, e);
      failedOrders.push(orderNumber);
    }

    await delay(CONSTANTS.TIMING.RETRY_DELAY);
  }

  // Close the download tab
  if (downloadTab) {
    chrome.tabs.remove(downloadTab.id).catch(() => {
      // Tab may already be closed
    });
  }

  // Convert collected orders to XLSX using shared utility
  try {
    await convertMultipleOrdersToXlsx(collectedOrdersData, ExcelJS, 'Walmart_Orders.xlsx');
  } catch (e) {
    console.error('Failed to export to XLSX:', e);
    progressDiv.innerHTML = createErrorMessage(`Export failed: ${e.message}`);
    setTimeout(() => progressDiv.remove(), CONSTANTS.TIMING.EXPORT_FAIL_DISPLAY);
    return;
  }

  // Completion message
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
  chrome.storage.local.get(["ratingHintDismissed"], function (sessionResult) {
    if (sessionResult.ratingHintDismissed) return;

    // Then check if hint has been dismissed 5 times in total (using local storage)
    chrome.storage.local.get(["ratingHintDismissCount"], function (localResult) {
      const dismissCount = localResult.ratingHintDismissCount || 0;

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
          chrome.storage.local.set({ ratingHintDismissed: true });

          // Increment dismiss count in local storage
          chrome.storage.local.get(["ratingHintDismissCount"], function (result) {
            const newCount = (result.ratingHintDismissCount || 0) + 1;
            chrome.storage.local.set({ ratingHintDismissCount: newCount });

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
