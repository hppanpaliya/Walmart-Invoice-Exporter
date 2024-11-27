let allOrderNumbers = new Set();
let downloadInProgress = false;
let timeout = 1000;

document.addEventListener("DOMContentLoaded", function () {
  const startButton = document.getElementById("startCollection");
  const stopButton = document.getElementById("stopCollection");
  const progressElement = document.getElementById("progress");
  const orderNumbersContainer = document.getElementById("orderNumbersContainer");
  const pageLimitInput = document.getElementById("pageLimit");

  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs[0];
    var url = tab.url;

    if (url.startsWith("https://www.walmart.com/orders")) {
      const cleanUrl = url.replace(/\/$/, "");
      const orderPath = cleanUrl.split("/orders/")[1];

      // Check if there's an order number after /orders/
      // 13 digits for regular orders till 2022, 15 digits for regular orders from 2022, 20 digits for in store purchases.
      if (orderPath && /^\d{13}$|^\d{15}$|^\d{20}$/.test(orderPath.split("?")[0])) {
        // Individual order page
        const orderNumber = orderPath.split("?")[0];
        console.log("Valid order number:", orderNumber);
        displayOrderNumbers([orderNumber]);

        document.getElementById("startCollection").style.display = "none";
        document.getElementById("stopCollection").style.display = "none";
        document.getElementById("pageLimit").style.display = "none";
        document.getElementsByClassName("controls")[0].style.display = "none";
        document.getElementsByClassName("checkbox-container")[0].style.display = "none";
        document.getElementById("progress").style.display = "none";
      } else {
        // Main orders page
        startButton.addEventListener("click", function () {
          const pageLimit = parseInt(pageLimitInput.value, 10);
          startButton.style.display = "none";
          stopButton.style.display = "inline-block";
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
            }
          );
        });

        stopButton.addEventListener("click", function () {
          chrome.runtime.sendMessage({ action: "stopCollection" }, function (response) {
            if (response.status === "stopped") {
              stopButton.style.display = "none";
              startButton.style.display = "inline-block";
              startButton.textContent = "Restart Collection";
            }
          });
        });
      }
    } else {
      document.body.innerHTML = "<p>Please navigate to https://www.walmart.com/orders to use this extension.</p>";
    }
  });
});

function updateProgress() {
  chrome.runtime.sendMessage({ action: "getProgress" }, function (response) {
    if (response.isCollecting) {
      updateProgressUI(response.currentPage, response.pageLimit, true);
      displayOrderNumbers(response.orderNumbers);
      setTimeout(updateProgress, 1000);
    } else {
      updateProgressUI(response.currentPage, response.pageLimit, false);
      displayOrderNumbers(response.orderNumbers);
      document.getElementById("startCollection").style.display = "inline-block";
      document.getElementById("stopCollection").style.display = "none";
      document.getElementById("startCollection").textContent = "Start Collection";
    }
  });
}

function updateProgressUI(currentPage, pageLimit, inProgress) {
  const progressElement = document.getElementById("progress") || createProgressElement();
  const pageLimitText = pageLimit > 0 ? ` of ${pageLimit}` : "";

  if (inProgress) {
    progressElement.textContent = `Fetching order numbers... Page ${currentPage}${pageLimitText} completed`;
  } else {
    progressElement.textContent = `Collection ${
      pageLimit > 0 && currentPage >= pageLimit ? "reached limit" : "completed"
    }. Total pages: ${currentPage}`;
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
  container.innerHTML = "<h3>Select orders to download:</h3>";

  // Create select all checkbox
  const selectAllDiv = document.createElement("div");
  selectAllDiv.className = "checkbox-container";
  const selectAll = document.createElement("input");
  selectAll.type = "checkbox";
  selectAll.id = "selectAll";
  const selectAllLabel = document.createElement("label");
  selectAllLabel.htmlFor = "selectAll";
  selectAllLabel.appendChild(document.createTextNode(" Select All"));
  selectAllDiv.appendChild(selectAll);
  selectAllDiv.appendChild(selectAllLabel);
  container.appendChild(selectAllDiv);

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
    label.appendChild(document.createTextNode(` Order #${orderNumber}`));

    div.appendChild(checkbox);
    div.appendChild(label);
    container.appendChild(div);
  });

  // Add select all functionality
  selectAll.addEventListener("change", function () {
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach((cb) => (cb.checked = selectAll.checked));
  });

  // Add download button if there are order numbers
  if (orderNumbers.length > 0 && !document.getElementById("downloadButton")) {
    const downloadButton = document.createElement("button");
    downloadButton.id = "downloadButton";
    downloadButton.textContent = "Download Selected Orders";
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
  downloadInProgress = true;
  let downloadTab = null;

  try {
    // Create progress indicator
    const progressDiv = document.createElement("div");
    progressDiv.id = "downloadProgress";
    progressDiv.style.marginTop = "10px";
    document.getElementById("orderNumbersContainer").appendChild(progressDiv);

    for (let i = 0; i < selectedOrders.length; i++) {
      let orderNumber = selectedOrders[i];
      progressDiv.textContent = `Downloading order ${i + 1} of ${selectedOrders.length} (#${orderNumber})...`;
      orderNumber = orderNumber.length === 20 ? `${orderNumber}?storePurchase=true` : orderNumber;

      // Create or reuse tab
      if (!downloadTab) {
        downloadTab = await new Promise((resolve) => {
          chrome.tabs.create(
            {
              url: `https://www.walmart.com/orders/${orderNumber}`,
              active: false,
            },
            resolve
          );
        });
      } else {
        await new Promise((resolve) => {
          chrome.tabs.update(
            downloadTab.id,
            {
              url: `https://www.walmart.com/orders/${orderNumber}`,
            },
            resolve
          );
        });
      }

      // Wait for page load and trigger download
      await new Promise((resolve, reject) => {
        function listener(tabId, info) {
          if (tabId === downloadTab.id && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            setTimeout(() => {
              chrome.tabs.sendMessage(downloadTab.id, { method: "downloadXLSX" }, (response) => {
                if (chrome.runtime.lastError) {
                  reject(chrome.runtime.lastError);
                } else {
                  resolve();
                }
              });
            }, 2000); // Give the page a moment to fully initialize
          }
        }
        chrome.tabs.onUpdated.addListener(listener);
      });

      // Wait a bit between downloads to ensure proper file handling
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Cleanup
    if (downloadTab) {
      chrome.tabs.remove(downloadTab.id);
    }
    progressDiv.textContent = "All downloads completed!";
    setTimeout(() => progressDiv.remove(), 3000);
  } catch (error) {
    console.error("Download error:", error);
    alert("An error occurred during download. Please try again.");
    if (downloadTab) {
      chrome.tabs.remove(downloadTab.id);
    }
  } finally {
    downloadButton.disabled = false;
    downloadInProgress = false;
  }
}
