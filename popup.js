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
          function listener(tabId, info) {
            if (tabId === downloadTab.id && info.status === "complete") {
              chrome.tabs.onUpdated.removeListener(listener);
              setTimeout(() => {
                chrome.tabs.sendMessage(downloadTab.id, { method: "downloadXLSX" }, (response) => {
                  if (chrome.runtime.lastError) {
                    reject(new Error(`Failed to download order #${orderNumber}: ${chrome.runtime.lastError.message}`));
                  } else {
                    resolve();
                  }
                });
              }, 2000);
            }
          }
          chrome.tabs.onUpdated.addListener(listener);
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout downloading order #${orderNumber}`)), 30000))
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
      let firstAttemptUrl = `https://www.walmart.com/orders/${orderNumber}${isLongOrderNumber ? '?storePurchase=true' : ''}`;
      downloadSuccess = await attemptDownload(orderNumber, firstAttemptUrl, 1);

      // If first attempt fails, try with opposite parameter
      if (!downloadSuccess) {
        progressDiv.innerHTML = `
          <span class="loading-spinner" style="border-color: var(--success); border-top-color: transparent;"></span>
          Retrying order ${i + 1} of ${selectedOrders.length} (#${orderNumber}) with different parameters...
        `;
        
        let secondAttemptUrl = `https://www.walmart.com/orders/${orderNumber}${isLongOrderNumber ? '' : '?storePurchase=true'}`;
        downloadSuccess = await attemptDownload(orderNumber, secondAttemptUrl, 2);
      }

      // If both attempts fail, add to failed orders
      if (!downloadSuccess) {
        failedOrders.push(orderNumber);
      }

      await new Promise(resolve => setTimeout(resolve, 500));
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
        Failed orders: ${failedOrders.map(order => `#${order}`).join(', ')}
      `;
    }
    setTimeout(() => progressDiv.remove(), failedOrders.length > 0 ? 30000 : 10000);
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
