let allOrderNumbers = new Set();
let downloadInProgress = false;
let timeout = 1000;
let exportMode = 'multiple'; // 'multiple' | 'single'

document.addEventListener("DOMContentLoaded", function () {
  const startButton = document.getElementById("startCollection");
  const stopButton = document.getElementById("stopCollection");
  const progressElement = document.getElementById("progress");
  const orderNumbersContainer = document.getElementById("orderNumbersContainer");
  const pageLimitInput = document.getElementById("pageLimit");
  const exportModeSelect = document.getElementById("exportMode");
  progressElement.style.display = "none";

  document.getElementById("faqButton").addEventListener("click", function (e) {
    e.preventDefault();
    chrome.tabs.create({
      url: chrome.runtime.getURL("faq/faq.html"),
    });
  });

  // Add loading spinner function
  function setButtonLoading(button, isLoading) {
    const btnText = button.querySelector(".btn-text");
    if (isLoading) {
      button.disabled = true;
      if (!button.querySelector(".loading-spinner")) {
        const spinner = document.createElement("span");
        spinner.className = "loading-spinner";
        button.insertBefore(spinner, btnText);
      }
    } else {
      button.disabled = false;
      const spinner = button.querySelector(".loading-spinner");
      if (spinner) spinner.remove();
    }
  }

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

  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs[0];
    var url = tab.url;

    if (url.startsWith("https://www.walmart.com/orders")) {
      const cleanUrl = url.replace(/\/$/, "");
      const orderPath = cleanUrl.split("/orders/")[1];

      // Check if there's an order number after /orders/
      if (orderPath && /^\d{10,}$/.test(orderPath.split("?")[0])) {
        // Individual order page - do NOT use cache, only show current order
        const orderNumber = orderPath.split("?")[0];
        console.log("Valid order number:", orderNumber);
        displayOrderNumbers([orderNumber]);

        // Hide unnecessary UI elements
        // document.querySelector(".card").style.display = "none";
        // hide div with id pageLimitGroup and buttonGroup
        document.getElementById("pageLimitGroup").style.display = "none";
        document.getElementById("buttonGroup").style.display = "none";
        document.getElementById("progress").style.display = "none";
        document.getElementsByClassName("checkbox-container")[0].style.display = "none";
        
        // Skip cache loading for individual order pages
      } else {
        // Main orders page setup
        startButton.addEventListener("click", function () {
          const pageLimit = parseInt(pageLimitInput.value, 10);
          startButton.style.display = "none";
          stopButton.style.display = "inline-flex";
          setButtonLoading(startButton, true);

          chrome.runtime.sendMessage(
            {
              action: "startCollection",
              url: url,
              pageLimit: pageLimit,
            },
            function (response) {
              if (response.status === "started") {
                updateProgress();
              }
              setButtonLoading(startButton, false);
            }
          );
        });

        stopButton.addEventListener("click", function () {
          setButtonLoading(stopButton, true);
          chrome.runtime.sendMessage({ action: "stopCollection" }, function (response) {
            if (response.status === "stopped") {
              stopButton.style.display = "none";
              startButton.style.display = "inline-flex";
              startButton.querySelector(".btn-text").textContent = "Restart Collection";
              setButtonLoading(stopButton, false);
            }
          });
        });
        
        // Load cache only on main orders page
        loadCacheOnMainPage();
      }
    } else {
      document.querySelector(".card").style.display = "none";
      orderNumbersContainer.innerHTML = `
        <div class="card" style="text-align: center; padding: 24px;">
          ${renderIcon('ERROR_LARGE')}
          <p style="color: var(--text); font-size: 16px; margin-bottom: 8px;">Please navigate to</p>
          <p style="color: var(--primary); font-weight: 500; margin-bottom: 16px;"><a href="${CONSTANTS.URLS.WALMART_ORDERS}" target="_blank">walmart.com/orders</a></p>
          <p style="color: var(--text-secondary); font-size: 14px;">to use this extension.</p>
        </div>`;
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
      if (response.status === "cache_cleared") {
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
  // Check for cached data on popup open
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

      // Add cache info to the UI
      const cardClass = document.querySelector(".card"); 
      cardClass.appendChild(cacheInfo);

      // Show rating hint
      if (response.orderNumbers.length > 4) {
        maybeShowRatingHint();
      }
    }
  });
}

function updateProgress() {
  chrome.runtime.sendMessage({ action: "getProgress" }, function (response) {
    if (response.isCollecting) {
      updateProgressUI(response.currentPage, response.pageLimit, true);
      displayOrderNumbers(response.orderNumbers, response.additionalFields);
      setTimeout(updateProgress, 1000);
      // set all checkboxes to disabled
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach((cb) => (cb.disabled = true));
    } else {
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

  if (inProgress) {
    console.log("Progress:", currentPage, pageLimit);
    progressElement.innerHTML = `
      <span class="loading-spinner" style="border-color: var(--primary); border-top-color: transparent;"></span>
      Fetching order numbers... Fetching Page ${currentPage}${pageLimitText} 
    `;
  } else {
    progressElement.textContent = `Collection ${pageLimit > 0 && currentPage >= pageLimit ? "reached limit" : "completed"}. Total pages: ${
      pageLimit > 0 ? currentPage : currentPage - 1
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
  orderList.style.maxHeight = "150px";
  orderList.style.overflowY = "auto";
  orderList.style.marginBottom = "16px";

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
      // Create or reuse tab
      if (!downloadTab) {
        downloadTab = await new Promise((resolve) => {
          chrome.tabs.create({ url: url, active: false }, resolve);
        });
      } else {
        await new Promise((resolve) => {
          chrome.tabs.update(downloadTab.id, { url: url }, resolve);
        });
      }

      // Wait for page load and trigger download with timeout
      await Promise.race([
        new Promise((resolve, reject) => {
          async function handleDownload(tabId, info) {
            if (tabId === downloadTab.id && info.status === "complete") {
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
      chrome.tabs.remove(downloadTab.id);
    }

    // Show completion message with failed orders if any
    if (failedOrders.length === 0) {
      progressDiv.innerHTML = createSuccessMessage('All downloads completed successfully!');
    } else {
      progressDiv.innerHTML = createErrorMessage(
        `Downloads completed with ${failedOrders.length} failed orders:<br>Failed orders: ${failedOrders.map((order) => `#${order}`).join(", ")}`
      );
    }
    setTimeout(() => progressDiv.remove(), failedOrders.length > 0 ? 30000 : 10000);

    // Show rating hint
    if (failedOrders.length === 0) {
      maybeShowRatingHint();
    }
  } catch (error) {
    console.error("Download error:", error);
    alert("An error occurred during download process. Some orders may have failed.");
    if (downloadTab) {
      chrome.tabs.remove(downloadTab.id);
    }
  } finally {
    downloadButton.disabled = false;
    setButtonLoading(downloadButton, false);
    downloadInProgress = false;
  }
}

// Combined export: build one workbook in popup with ExcelJS
async function downloadCombinedSelectedOrders(selectedOrders, failedOrders) {
  // Create progress indicator
  const progressDiv = document.createElement("div");
  progressDiv.id = "downloadProgress";
  document.getElementById("progress").style.display = "none";
  document.getElementById("progress").insertAdjacentElement("afterend", progressDiv);

  let downloadTab = null;
  const collectedOrdersData = [];

  // Helper to navigate and get data with retry for storePurchase param
  const getDataForOrder = async (orderNumber, attempt = 1) => {
    // Check cache first
    const cachedData = await getCachedInvoice(orderNumber);
    if (cachedData) {
      console.log(`Using cached data for order ${orderNumber}`);
      return cachedData;
    }

    const isLongOrderNumber = orderNumber.length >= 20;
    const firstAttemptUrl = `https://www.walmart.com/orders/${orderNumber}${isLongOrderNumber ? "?storePurchase=true" : ""}`;
    const secondAttemptUrl = `https://www.walmart.com/orders/${orderNumber}${isLongOrderNumber ? "" : "?storePurchase=true"}`;

    const tryUrl = async (url) => {
      // Create or reuse tab
      if (!downloadTab) {
        downloadTab = await new Promise((resolve) => {
          chrome.tabs.create({ url, active: false }, resolve);
        });
      } else {
        await new Promise((resolve) => {
          chrome.tabs.update(downloadTab.id, { url }, resolve);
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
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout getting data')), 30000)),
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
    chrome.tabs.remove(downloadTab.id);
  }

  // Convert collected orders to XLSX using shared utility
  try {
    await convertMultipleOrdersToXlsx(collectedOrdersData, ExcelJS, 'Walmart_Orders.xlsx');
  } catch (e) {
    console.error('Failed to export to XLSX:', e);
    progressDiv.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" style="margin-right: 8px;">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      Export failed: ${e.message}
    `;
    setTimeout(() => progressDiv.remove(), 5000);
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
  setTimeout(() => progressDiv.remove(), failedOrders.length > 0 ? 30000 : 10000);

  if (failedOrders.length === 0) {
    maybeShowRatingHint();
  }
}

// Helper function to set loading state on any button
function setButtonLoading(button, isLoading) {
  if (isLoading) {
    button.disabled = true;
    const spinner = document.createElement("span");
    spinner.className = "loading-spinner";
    button.insertBefore(spinner, button.firstChild);
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
  chrome.storage.session.get(["ratingHintDismissed"], function (sessionResult) {
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

          // Update session storage for current session
          chrome.storage.session.set({ ratingHintDismissed: true });

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
