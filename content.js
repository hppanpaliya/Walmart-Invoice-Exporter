/**
 * Content script for Walmart Invoice Exporter
 * Handles DOM extraction and image blocking on Walmart order pages
 */

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
      rules.forEach((rule) => {
        if (rule.style && rule.style.backgroundImage) {
          rule.style.backgroundImage = "none";
        }
      });
    } catch (e) {
      // Handle cross-origin stylesheet errors silently
    }
  });
}

// Store observer reference for cleanup
let imageBlockingObserver = null;

// Store original prototypes for potential restoration
const originalImage = window.Image;
const originalSetAttribute = HTMLImageElement.prototype.setAttribute;

function blockImageLoading() {
  // Override Image constructor to prevent new image loading
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
  HTMLImageElement.prototype.setAttribute = new Proxy(originalSetAttribute, {
    apply(target, thisArg, argumentsList) {
      const [attr] = argumentsList;
      if (attr === "src" || attr === "srcset") {
        return;
      }
      return Reflect.apply(target, thisArg, argumentsList);
    },
  });

  // Disconnect existing observer if any to prevent memory leaks
  if (imageBlockingObserver) {
    imageBlockingObserver.disconnect();
  }

  // Intercept image loading with optimized MutationObserver
  // Only monitor childList changes to reduce CPU overhead
  imageBlockingObserver = new MutationObserver((mutations) => {
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

  // Disable attribute and characterData monitoring to reduce observer firing frequency
  imageBlockingObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: false,
    characterData: false
  });
}

function aggressiveImageBlocking() {
  // Handle failed image loads by hiding them
  document.addEventListener('error', (e) => {
    if (e.target.tagName === 'IMG' || e.target.tagName === 'PICTURE') {
      e.target.style.display = 'none';
    }
  }, true);

  removeAllImages();
  blockImageLoading();

  // Additional cleanup passes
  setTimeout(removeAllImages, 500);
  setTimeout(removeAllImages, 1000);
}

// Function to wait for an element to appear
// Timeout reduced to 10s with 200ms polling for faster response
async function waitForElement(selector, timeout = 10000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const element = document.querySelector(selector);
    if (element) {
      return element;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
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

/**
 * Scrapes order data from an individual order detail page.
 * Extracts product details, pricing, and order metadata from the print view.
 * @returns {Object} Order data including items, totals, and order info
 */
function scrapeOrderData() {
  const orderItems = [];

  // Query the hidden print items list which contains reliable product data
  const printItemsList = document.querySelectorAll(CONSTANTS.SELECTORS.PRINT_ITEMS);

  printItemsList.forEach((item) => {
    const productName = item.querySelector(CONSTANTS.SELECTORS.PRINT_ITEM_NAME)?.innerText;
    // Fall back to default delivery label if status element not found
    const deliveryStatus = item.querySelector(CONSTANTS.SELECTORS.PRINT_BILL_TYPE)?.innerText || CONSTANTS.TEXT.DELIVERY_LABEL;
    const quantity = item.querySelector(CONSTANTS.SELECTORS.PRINT_BILL_QTY)?.innerText;
    const price = item.querySelector(CONSTANTS.SELECTORS.PRINT_BILL_PRICE)?.innerText;

    // Find the corresponding visible item to get the product link
    let productLink = "N/A";
    const visibleItems = document.querySelectorAll(CONSTANTS.SELECTORS.VISIBLE_ITEMS);
    for (const visibleItem of visibleItems) {
      if (visibleItem?.innerText.trim() === (productName || '').trim()) {
        const linkElement = visibleItem.closest(CONSTANTS.SELECTORS.ITEM_STACK)?.querySelector(CONSTANTS.SELECTORS.PRODUCT_LINK);
        if (linkElement) {
          productLink = linkElement.href;
          break;
        }
      }
    }

    orderItems.push({
      productName,
      productLink,
      deliveryStatus,
      quantity,
      price,
    });
  });

  /**
   * Finds order number using fallback selectors.
   * Tries multiple locations where order number might appear.
   */
  function findOrderNumber() {
    const selectors = [
      CONSTANTS.SELECTORS.ORDER_NUMBER_BAR,
      CONSTANTS.SELECTORS.ORDER_INFO_CARD,
      CONSTANTS.SELECTORS.ORDER_NUMBER_HEADING,
      CONSTANTS.SELECTORS.PRINT_BILL_ID,
    ];

    for (const selector of selectors) {
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

  // Extract order metadata
  const orderNumber = findOrderNumber();
  let orderDate = document.querySelector(CONSTANTS.SELECTORS.ORDER_DATE)?.innerText || '';
  orderDate = orderDate.replace("order", "").trim();
  const orderTotal = document.querySelector(CONSTANTS.SELECTORS.ORDER_TOTAL)?.innerText || '';
  const deliveryCharges = document.querySelector(CONSTANTS.SELECTORS.DELIVERY_CHARGES)?.innerText || "$0.00";

  // Find tax by searching for "Tax" label and extracting the corresponding amount
  let tax = "$0.00";
  const taxElements = document.querySelectorAll(CONSTANTS.SELECTORS.TAX_ELEMENTS);
  for (const element of taxElements) {
    if (element.textContent.includes('Tax')) {
      const taxItem = element.closest('.print-fees-item');
      const taxAmount = taxItem?.querySelector('.w_U9_0.w_sD6D.w_QcqU.ml2');
      if (taxAmount) {
        tax = taxAmount.innerText;
        break;
      }
    }
  }

  const tip =
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

/**
 * Handles order number collection from order history page.
 * Waits for page elements to load, then extracts order data.
 */
async function handleCollectOrderNumbers() {
  try {
    // Wait for the main heading, which should be present on all pages
    await waitForElement(CONSTANTS.SELECTORS.MAIN_HEADING);
    
    // Wait for order cards to render after page navigation
    await waitForElement('[data-testid^="order-"]');

    const { orderNumbers, additionalFields } = extractOrderNumbers();
    const hasNextPage = await checkForNextPage();

    console.log(`Extracted ${orderNumbers.length} order numbers. Has next page: ${hasNextPage}`);
    return { orderNumbers, additionalFields, hasNextPage };
  } catch (error) {
    console.error("Error during collection:", error);
    // Timeout errors indicate no more orders on this page
    if (error.message.includes("not found after")) {
      console.log("No order cards found. Assuming end of orders.");
      return { orderNumbers: [], additionalFields: {}, hasNextPage: false };
    }
    return { orderNumbers: [], additionalFields: {}, hasNextPage: false };
  }
}

/**
 * Handles pagination by clicking the next page button.
 * @returns {Object} Success status of the click operation
 */
async function handleClickNextButton() {
  try {
    await waitForElement(CONSTANTS.SELECTORS.MAIN_HEADING);
    const nextButton = await waitForElement(CONSTANTS.SELECTORS.NEXT_BUTTON);
    nextButton.click();
    return { success: true };
  } catch (error) {
    console.error("Error clicking next button:", error);
    return { success: false };
  }
}

/**
 * Single-pass order extraction using efficient DOM traversal.
 * Queries order cards once, then finds child elements within each card.
 * @returns {Object} Object containing orderNumbers array and additionalFields map
 */
function extractOrderNumbers() {
  const orderNumbers = [];
  const additionalFields = {};

  // Single DOM query for all order cards
  const orderCards = document.querySelectorAll(CONSTANTS.SELECTORS.ORDER_CARDS);
  
  if (orderCards.length === 0) {
    console.warn("No order cards found with selector '[data-testid^=\"order-\"]'");
    return { orderNumbers, additionalFields };
  }

  // Single-pass traversal: query within each card to avoid redundant global queries
  orderCards.forEach((card, index) => {
    try {
      const title = card.querySelector('h2');
      const button = card.querySelector('button[data-automation-id^="view-order-details-link-"]');
      
      if (title && button) {
        const orderNumber = button.getAttribute('data-automation-id').replace('view-order-details-link-', '');
        if (orderNumber) {
          orderNumbers.push(orderNumber);
          additionalFields[orderNumber] = title.textContent.trim();
        }
      }
    } catch (e) {
      console.error(`Error processing order card ${index}:`, e);
    }
  });

  return { orderNumbers, additionalFields };
}

/**
 * Checks if a next page button exists for pagination.
 * @returns {boolean} True if more pages are available
 */
async function checkForNextPage() {
  try {
    await waitForElement(CONSTANTS.SELECTORS.MAIN_HEADING);
    const nextButton = document.querySelector(CONSTANTS.SELECTORS.NEXT_BUTTON);
    return !!nextButton;
  } catch (error) {
    console.error("Error checking for next page:", error);
    return false;
  }
}