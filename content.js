const OrderNumberRegex = /#\s*([\d-]+)/;
let allOrderNumbers = new Set();
let currentPage = 0;
let isProcessing = false;

function removeAllImages() {
  // Remove background images from elements
  const allElements = document.getElementsByTagName("*");
  for (let element of allElements) {
    if (element.style) {
      element.style.backgroundImage = "none";
    }
  }

  // Remove all img elements
  const images = document.querySelectorAll("img");
  images.forEach((img) => {
    img.remove();
  });

  // Remove picture elements
  const pictures = document.querySelectorAll("picture");
  pictures.forEach((pic) => {
    pic.remove();
  });

  // Remove CSS background images
  const styleSheets = Array.from(document.styleSheets);
  styleSheets.forEach((sheet) => {
    try {
      const rules = Array.from(sheet.cssRules || sheet.rules);
      rules.forEach((rule, index) => {
        if (rule.style && rule.style.backgroundImage) {
          rule.style.backgroundImage = "none";
        }
      });
    } catch (e) {
      // Handle cross-origin stylesheet errors silently
    }
  });
}

function blockImageLoading() {
  // Override Image constructor
  const originalImage = window.Image;
  window.Image = function () {
    const dummyImage = {};
    Object.defineProperty(dummyImage, "src", {
      set: function () {
        return "";
      },
      get: function () {
        return "";
      },
    });
    return dummyImage;
  };

  // Block image loading using Content-Security-Policy
  const meta = document.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute("content", "img-src 'none'"); // Fixed CSP directive
  document.head.appendChild(meta);

  // Prevent loading through srcset
  HTMLImageElement.prototype.setAttribute = new Proxy(HTMLImageElement.prototype.setAttribute, {
    apply(target, thisArg, argumentsList) {
      const [attr] = argumentsList;
      if (attr === "src" || attr === "srcset") {
        return;
      }
      return Reflect.apply(target, thisArg, argumentsList);
    },
  });

  // Intercept image loading
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeName === "IMG" || node.nodeName === "PICTURE") {
          node.remove();
        }
        if (node.getElementsByTagName) {
          const images = node.getElementsByTagName("img");
          const pictures = node.getElementsByTagName("picture");
          Array.from(images).forEach((img) => img.remove());
          Array.from(pictures).forEach((pic) => pic.remove());
        }
      });
    });
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function aggressiveImageBlocking() {
  // Add style to hide images immediately

  removeAllImages();
  blockImageLoading();

  // Additional cleanup passes
  setTimeout(removeAllImages, 500);
  setTimeout(removeAllImages, 1000);
}

// Function to wait for an element to appear
async function waitForElement(selector, timeout = 30000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const element = document.querySelector(selector);
    if (element) {
      return element;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Element ${selector} not found after ${timeout}ms`);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "collectOrderNumbers") {
    // Handle collection asynchronously
    aggressiveImageBlocking();
    handleCollectOrderNumbers().then(sendResponse);
    return true; // Indicates we'll send response asynchronously
  } else if (request.action === "clickNextButton") {
    // Handle next button click asynchronously
    aggressiveImageBlocking();
    handleClickNextButton().then(sendResponse);
    return true;
  } else if (request.action === "blockImagesForDownload") {
    aggressiveImageBlocking();
    sendResponse({ success: true });
    return true;
  } else if (request.method === "downloadXLSX") {
    aggressiveImageBlocking();
    const data = scrapeOrderData();
    // Convert the order details to an XLSX file using the shared convertToXlsx function
    convertToXlsx(data, ExcelJS, { mode: 'single' });
    sendResponse({ data });
  } else if (request.method === 'getOrderData') {
    aggressiveImageBlocking();
    const data = scrapeOrderData();
    sendResponse({ data });
  }
  return true;
});

function scrapeOrderData() {
  // Array to store all order items
  let orderItems = [];

  // Select all elements representing the print items list
  let printItemsList = document.querySelectorAll(CONSTANTS.SELECTORS.PRINT_ITEMS);

  // Loop through each item in the print items list
  printItemsList.forEach((item) => {
    let productName = item.querySelector(CONSTANTS.SELECTORS.PRINT_ITEM_NAME)?.innerText;
    let deliveryStatus = item.querySelector(CONSTANTS.SELECTORS.PRINT_BILL_TYPE)?.innerText || CONSTANTS.TEXT.DELIVERY_LABEL;
    let quantity = item.querySelector(CONSTANTS.SELECTORS.PRINT_BILL_QTY)?.innerText;
    let price = item.querySelector(CONSTANTS.SELECTORS.PRINT_BILL_PRICE)?.innerText;

    // Find the corresponding visible item to get the product link
    let productLink = "N/A";
    let visibleItems = document.querySelectorAll(CONSTANTS.SELECTORS.VISIBLE_ITEMS);
    for (let visibleItem of visibleItems) {
      if (visibleItem?.innerText.trim() === (productName || '').trim()) {
        let linkElement = visibleItem.closest(CONSTANTS.SELECTORS.ITEM_STACK).querySelector(CONSTANTS.SELECTORS.PRODUCT_LINK);
        if (linkElement) {
          productLink = linkElement.href;
          break;
        }
      }
    }

    // Push the item details into the orderItems array
    orderItems.push({
      productName,
      productLink,
      deliveryStatus,
      quantity,
      price,
    });
  });

  // Function to find the order number based on a list of possible selectors
  function findOrderNumber() {
    const selectors = [
      CONSTANTS.SELECTORS.ORDER_NUMBER_BAR,
      CONSTANTS.SELECTORS.ORDER_INFO_CARD,
      CONSTANTS.SELECTORS.ORDER_NUMBER_HEADING,
      CONSTANTS.SELECTORS.PRINT_BILL_ID,
    ];

    for (let selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        const text = element.textContent;
        const match = text.match(CONSTANTS.ORDER_NUMBER_REGEX);
        if (match) {
          return match[1];
        }
      }
    }

    console.log("Order number not found with current selectors");
    return null;
  }

  // Extract additional order details
  let orderNumber = findOrderNumber();
  let orderDate = document.querySelector(CONSTANTS.SELECTORS.ORDER_DATE)?.innerText || '';
  orderDate = orderDate.replace("order", "").trim();
  let orderTotal = document.querySelector(CONSTANTS.SELECTORS.ORDER_TOTAL)?.innerText || '';
  let deliveryCharges = document.querySelector(CONSTANTS.SELECTORS.DELIVERY_CHARGES)?.innerText || "$0.00";

  // Find tax by looking for the text "Tax" and getting the corresponding amount
  let tax = "$0.00";
  const taxElements = document.querySelectorAll(CONSTANTS.SELECTORS.TAX_ELEMENTS);
  for (let element of taxElements) {
    if (element.textContent.includes('Tax')) {
      const taxItem = element.closest('.print-fees-item');
      const taxAmount = taxItem?.querySelector('.w_U9_0.w_sD6D.w_QcqU.ml2');
      if (taxAmount) {
        tax = taxAmount.innerText;
        break;
      }
    }
  }

  let tip =
    document.querySelector(".print-bill-payment-section .flex.justify-between.pb2.pt3 .w_U9_0.w_U0S3.w_QcqU:last-child")?.innerText || "$0.00";

  return {
    orderNumber,
    orderDate,
    orderTotal,
    deliveryCharges,
    tax,
    tip,
    items: orderItems,
  };
}

async function handleCollectOrderNumbers() {
  try {
    // Wait for the main heading, which should be present on all pages
    await waitForElement(CONSTANTS.SELECTORS.MAIN_HEADING);
    
    // It can take a moment for the new order cards to render after a page navigation.
    // We'll wait for at least one order card to be present before scraping.
    await waitForElement('[data-testid^="order-"]');

    const { orderNumbers, additionalFields } = extractOrderNumbers();
    const hasNextPage = await checkForNextPage();

    console.log(`Extracted ${orderNumbers.length} order numbers. Has next page: ${hasNextPage}`);
    return { orderNumbers, additionalFields, hasNextPage };
  } catch (error) {
    console.error("Error during collection:", error);
    // If we timed out waiting for an order, it likely means there are no more.
    if (error.message.includes("not found after")) {
        console.log("No order cards found. Assuming end of orders.");
        return { orderNumbers: [], additionalFields: {}, hasNextPage: false };
    }
    return { orderNumbers: [], additionalFields: {}, hasNextPage: false };
  }
}

async function handleClickNextButton() {
  try {
    // Wait for the Purchase history heading first
    await waitForElement(CONSTANTS.SELECTORS.MAIN_HEADING);

    // Then wait for the next button to be present and clickable
    const nextButton = await waitForElement(CONSTANTS.SELECTORS.NEXT_BUTTON);

    nextButton.click();
    return { success: true };
  } catch (error) {
    console.error("Error clicking next button:", error);
    return { success: false };
  }
}

// Replaced the JSON parsing and old DOM scraping with a single, reliable DOM scraping method.
function extractOrderNumbers() {
  const orderNumbers = [];
  const additionalFields = {};

  // Select all order cards. They all have a `data-testid` starting with "order-"
  const orderCards = document.querySelectorAll(CONSTANTS.SELECTORS.ORDER_CARDS);
  
  if (orderCards.length === 0) {
      console.warn("No order cards found with selector '[data-testid^=\"order-\"]'");
  }

  orderCards.forEach((card, index) => {
    try {
      // Find the main H2 title, which contains the status/date.
      // e.g., "Delivered on Oct 29" or "Nov 01, 2025 purchase"
      const titleElement = card.querySelector('h2.w_kV33.w_Sl3f.w_mvVb.f3');
      
      // Find the "View details" button, which reliably contains the order number in its automation ID.
      const buttonElement = card.querySelector('button[data-automation-id^="view-order-details-link-"]');

      if (!titleElement) {
        console.warn(`Could not find title element for order card ${index}`);
        return; // skip this card
      }

      if (!buttonElement) {
        console.warn(`Could not find button element for order card ${index}`);
        return; // skip this card
      }

      const title = titleElement.textContent.trim();
      const automationId = buttonElement.getAttribute('data-automation-id');
      
      // Extract the order number from an ID like "view-order-details-link-xxxxxxxxxxx"
      const orderNumber = automationId.replace('view-order-details-link-', '');

      if (orderNumber && title) {
        orderNumbers.push(orderNumber);
        additionalFields[orderNumber] = title;
      } else {
         console.warn(`Failed to parse order number or title for order card ${index}`);
      }
    } catch (e) {
      console.error(`Error processing order card ${index}:`, e);
    }
  });

  return { orderNumbers, additionalFields };
}

async function checkForNextPage() {
  try {
    // Wait for the Purchase history heading first
    await waitForElement(CONSTANTS.SELECTORS.MAIN_HEADING);

    // Then check for the next button
    const nextButton = document.querySelector(CONSTANTS.SELECTORS.NEXT_BUTTON);
    return !!nextButton;
  } catch (error) {
    console.error("Error checking for next page:", error);
    return false;
  }
}


