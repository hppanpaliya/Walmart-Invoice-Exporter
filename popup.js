let allOrderNumbers = new Set();
let downloadInProgress = false;
let timeout = 1000;

document.addEventListener("DOMContentLoaded", function () {
  const startButton = document.getElementById("startCollection");
  const stopButton = document.getElementById("stopCollection");
  const progressElement = document.getElementById("progress");
  const orderNumbersContainer = document.getElementById("orderNumbersContainer");
  const pageLimitInput = document.getElementById("pageLimit");
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

  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs[0];
    var url = tab.url;

    if (url.startsWith("https://www.walmart.com/orders")) {
      const cleanUrl = url.replace(/\/$/, "");
      const orderPath = cleanUrl.split("/orders/")[1];

      // Check if there's an order number after /orders/
      if (orderPath && /^\d{10,}$/.test(orderPath.split("?")[0])) {
        // Individual order page
        const orderNumber = orderPath.split("?")[0];
        console.log("Valid order number:", orderNumber);
        displayOrderNumbers([orderNumber]);

        // Hide unnecessary UI elements
        document.querySelector(".card").style.display = "none";
        document.getElementById("progress").style.display = "none";
        document.getElementsByClassName("checkbox-container")[0].style.display = "none";
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
      }
    } else {
      document.body.innerHTML = `
        <div class="card" style="text-align: center; padding: 24px;">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#e41e31" stroke-width="2" style="margin-bottom: 16px;">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <p style="color: var(--text); font-size: 16px; margin-bottom: 8px;">Please navigate to</p>
          <p style="color: var(--primary); font-weight: 500; margin-bottom: 16px;"><a href="https://walmart.com/orders" target="_blank">walmart.com/orders</a></p>
          <p style="color: var(--text-secondary); font-size: 14px;">to use this extension.</p>
        </div>`;
    }
  });
  
  // Add clear cache button
  const clearCacheButton = document.createElement("button");
  clearCacheButton.id = "clearCache";
  clearCacheButton.className = "btn btn-clear";
  clearCacheButton.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M3 6h18"></path>
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path>
    </svg>
    <span class="btn-text">Clear Cache</span>
  `;

  // Insert clear cache button into the button group
  const buttonGroup = document.querySelector(".button-group");
  buttonGroup.appendChild(clearCacheButton);

  // Add clear cache functionality
  clearCacheButton.addEventListener("click", function () {
    setButtonLoading(clearCacheButton, true);
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

  // Check for cached data on popup open
  chrome.runtime.sendMessage({ action: "getProgress" }, function (response) {
    if (response && response.orderNumbers && response.orderNumbers.length > 0) {
      displayOrderNumbers(response.orderNumbers);

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
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
          <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
          <line x1="12" y1="22.08" x2="12" y2="12"></line>
        </svg>
        <div>
          <span>Using cached data: ${response.orderNumbers.length} orders from ${cachePages} pages</span>
          ${cacheTimeInfo}
        </div>
      `;

      // Add cache info to the UI
      const progressElement = document.getElementById("progress");
      progressElement.style.display = "block";
      progressElement.innerHTML = "";
      progressElement.appendChild(cacheInfo);

      // Show rating hint
      if (response.orderNumbers.length > 4) {
        maybeShowRatingHint();
      }
    }
  });
});

function updateProgress() {
  chrome.runtime.sendMessage({ action: "getProgress" }, function (response) {
    if (response.isCollecting) {
      updateProgressUI(response.currentPage, response.pageLimit, true);
      displayOrderNumbers(response.orderNumbers);
      setTimeout(updateProgress, 1000);
      // set all checkboxes to disabled
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach((cb) => (cb.disabled = true));
    } else {
      updateProgressUI(response.currentPage, response.pageLimit, false);
      displayOrderNumbers(response.orderNumbers);
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

function displayOrderNumbers(orderNumbers) {
  const container = document.getElementById("orderNumbersContainer");
  container.innerHTML = "<h3>Select orders to download</h3>";

  // Create select all checkbox
  const selectAllDiv = document.createElement("div");
  selectAllDiv.className = "checkbox-container";
  const selectAll = document.createElement("input");
  selectAll.type = "checkbox";
  selectAll.id = "selectAll";
  const selectAllLabel = document.createElement("label");
  selectAllLabel.htmlFor = "selectAll";
  selectAllLabel.appendChild(document.createTextNode("Select All"));
  selectAllDiv.appendChild(selectAll);
  selectAllDiv.appendChild(selectAllLabel);
  container.appendChild(selectAllDiv);

  // Create order list container with scrollable area
  const orderList = document.createElement("div");
  orderList.style.maxHeight = "200px";
  orderList.style.overflowY = "auto";
  orderList.style.marginBottom = "16px";

  // Add individual order checkboxes
  orderNumbers.forEach((orderNumber) => {
    const div = document.createElement("div");
    div.className = "checkbox-container";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = orderNumber;
    checkbox.value = orderNumber;

    const label = document.createElement("label");
    label.htmlFor = orderNumber;
    label.appendChild(document.createTextNode(`Order #${orderNumber}`));

    div.appendChild(checkbox);
    div.appendChild(label);
    orderList.appendChild(div);
  });

  container.appendChild(orderList);

  // Add select all functionality
  selectAll.addEventListener("change", function () {
    const checkboxes = orderList.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach((cb) => (cb.checked = selectAll.checked));
  });

  // Add download button if there are order numbers
  if (orderNumbers.length > 0 && !document.getElementById("downloadButton")) {
    const downloadButton = document.createElement("button");
    downloadButton.id = "downloadButton";
    downloadButton.className = "btn btn-success";
    downloadButton.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      Download Selected Orders
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

  const selectedOrders = Array.from(document.querySelectorAll('input[type="checkbox"]:checked'))
    .map((cb) => cb.value)
    .filter((value) => value !== "on");

  if (selectedOrders.length === 0) {
    alert("Please select at least one order to download.");
    return;
  }

  const downloadButton = document.getElementById("downloadButton");
  downloadButton.disabled = true;
  setButtonLoading(downloadButton, true);
  downloadInProgress = true;
  let downloadTab = null;
  const failedOrders = [];

  // Helper function to attempt download with specific URL
  async function attemptDownload(orderNumber, url, attempt) {
    try {
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

                // Then proceed with download
                chrome.tabs.sendMessage(downloadTab.id, { method: "downloadXLSX" }, (response) => {
                  if (chrome.runtime.lastError) {
                    reject(new Error(`Failed to download order #${orderNumber}: ${chrome.runtime.lastError.message}`));
                  } else {
                    resolve();
                  }
                });
              } catch (error) {
                reject(error);
              }
            }
          }

          chrome.tabs.onUpdated.addListener(handleDownload);
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout downloading order #${orderNumber}`)), 30000)),
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
      progressDiv.innerHTML = `
        <span class="loading-spinner" style="border-color: var(--success); border-top-color: transparent;"></span>
        Downloading order ${i + 1} of ${selectedOrders.length} (#${orderNumber})...
      `;

      let downloadSuccess = false;
      const isLongOrderNumber = orderNumber.length >= 20;

      // First attempt with default parameter based on order number length
      let firstAttemptUrl = `https://www.walmart.com/orders/${orderNumber}${isLongOrderNumber ? "?storePurchase=true" : ""}`;
      downloadSuccess = await attemptDownload(orderNumber, firstAttemptUrl, 1);

      // If first attempt fails, try with opposite parameter
      if (!downloadSuccess) {
        progressDiv.innerHTML = `
          <span class="loading-spinner" style="border-color: var(--success); border-top-color: transparent;"></span>
          Retrying order ${i + 1} of ${selectedOrders.length} (#${orderNumber}) with different parameters...
        `;

        let secondAttemptUrl = `https://www.walmart.com/orders/${orderNumber}${isLongOrderNumber ? "" : "?storePurchase=true"}`;
        downloadSuccess = await attemptDownload(orderNumber, secondAttemptUrl, 2);
      }

      // If both attempts fail, add to failed orders
      if (!downloadSuccess) {
        failedOrders.push(orderNumber);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Cleanup
    if (downloadTab) {
      chrome.tabs.remove(downloadTab.id);
    }

    // Show completion message with failed orders if any
    if (failedOrders.length === 0) {
      progressDiv.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2" style="margin-right: 8px;">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
        All downloads completed successfully!
      `;
    } else {
      progressDiv.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" style="margin-right: 8px;">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        Downloads completed with ${failedOrders.length} failed orders:<br>
        Failed orders: ${failedOrders.map((order) => `#${order}`).join(", ")}
      `;
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

  // Check if user has dismissed the hint before
  chrome.storage.session.get(["ratingHintDismissed"], function (result) {
    if (result.ratingHintDismissed) return;

    // Create rating hint element if it doesn't exist
    let ratingHint = document.getElementById("ratingHint");
    if (!ratingHint) {
      ratingHint = document.createElement("div");
      ratingHint.id = "ratingHint";
      ratingHint.className = "rating-hint";
      ratingHint.innerHTML = `
        <a href="https://chromewebstore.google.com/detail/walmart-invoice-exporter/bndkihecbbkoligeekekdgommmdllfpe/reviews" target="_blank">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
          </svg>
          Find this helpful? Consider rating it
        </a>
        <button class="dismiss-hint" title="Don't show again">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      `;

      // Add it to the UI
      const downloadButton = document.getElementById("downloadButton");
      downloadButton.insertAdjacentElement("afterend", ratingHint);

      // Handle dismiss click
      ratingHint.querySelector(".dismiss-hint").addEventListener("click", function () {
        ratingHint.classList.remove("show");
        chrome.storage.session.set({ ratingHintDismissed: true });
      });
    }

    // Show the hint
    setTimeout(() => {
      ratingHint.classList.add("show");
    }, 1500);
  });
}
