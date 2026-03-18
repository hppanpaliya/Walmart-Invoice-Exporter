/**
 * Content script for Walmart Invoice Exporter
 * Handles DOM extraction and image blocking on Walmart order pages
 */

const ImageBlocker = (() => {
  let observer = null;
  let errorHandlerBound = false;
  const originalSetAttribute = HTMLImageElement.prototype.setAttribute;
  const CSP_META_SELECTOR = 'meta[data-wie-img-csp="true"]';

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

  function ensureCspMeta() {
    if (document.querySelector(CSP_META_SELECTOR)) {
      return;
    }
    const meta = document.createElement("meta");
    meta.setAttribute("http-equiv", "Content-Security-Policy");
    meta.setAttribute("content", "img-src 'none'");
    meta.setAttribute("data-wie-img-csp", "true");
    document.head.appendChild(meta);
  }

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
    ensureCspMeta();

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
    if (observer) {
      observer.disconnect();
    }

    // Intercept image loading with optimized MutationObserver
    // Only monitor childList changes to reduce CPU overhead
    observer = new MutationObserver((mutations) => {
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
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });
  }

  function aggressive() {
    // Handle failed image loads by hiding them
    if (!errorHandlerBound) {
      document.addEventListener('error', (e) => {
        if (e.target.tagName === 'IMG' || e.target.tagName === 'PICTURE') {
          e.target.style.display = 'none';
        }
      }, true);
      errorHandlerBound = true;
    }

    removeAllImages();
    blockImageLoading();

    // Additional cleanup passes
    setTimeout(removeAllImages, CONSTANTS.TIMING.IMAGE_BLOCK_DELAY);
    setTimeout(removeAllImages, CONSTANTS.TIMING.IMAGE_BLOCK_DELAY * 2);
  }

  function cleanup() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  return {
    aggressive,
    cleanup,
  };
})();

// Cleanup observer when page unloads to prevent memory leaks
window.addEventListener('beforeunload', () => {
  ImageBlocker.cleanup();
});

// Function to wait for an element to appear
// Timeout reduced to 10s with 200ms polling for faster response
async function waitForElement(
  selector,
  timeout = CONSTANTS.TIMING.COLLECTION_TIMEOUT,
  pollInterval = CONSTANTS.TIMING.ELEMENT_POLL_INTERVAL
) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const element = document.querySelector(selector);
    if (element) {
      return element;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Element ${selector} not found after ${timeout}ms`);
}

const withImageBlocking = (handler) => async (request) => {
  ImageBlocker.aggressive();
  return handler(request);
};

const MessageHandlers = {
  [CONSTANTS.MESSAGES.COLLECT_ORDER_NUMBERS]: withImageBlocking(handleCollectOrderNumbers),
  [CONSTANTS.MESSAGES.CLICK_NEXT_BUTTON]: withImageBlocking(handleClickNextButton),
  [CONSTANTS.MESSAGES.BLOCK_IMAGES]: withImageBlocking(async () => ({ success: true })),
  [CONSTANTS.MESSAGES.DOWNLOAD_XLSX]: withImageBlocking(async () => {
    const data = scrapeOrderData();
    // Convert the order details to an XLSX file using the shared convertToXlsx function
    convertToXlsx(data, ExcelJS, { mode: 'single' });
    return { data };
  }),
  [CONSTANTS.MESSAGES.GET_ORDER_DATA]: withImageBlocking(async () => ({ data: scrapeOrderData() })),
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action = request.action || request.method;
  const handler = MessageHandlers[action];
  if (!handler) {
    return false;
  }

  handler(request)
    .then(sendResponse)
    .catch((error) => {
      console.error(`Error handling message ${action}:`, error);
      sendResponse({ success: false, error: error.message });
    });

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
  // This list is always present in the DOM (hidden via .dn class) and is populated on page load.
  // It provides a cleaner data structure compared to the complex interactive UI.
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
  // ----- Extract order totals -----

  // Subtotal: grab the last span inside the subtotal row
  let orderSubtotal = '';
  const subtotalEl = document.querySelector(CONSTANTS.SELECTORS.ORDER_SUBTOTAL);
  if (subtotalEl) {
    const spans = subtotalEl.querySelectorAll('span');
    if (spans.length > 0) {
      orderSubtotal = spans[spans.length - 1].innerText.trim();
    }
    if (!orderSubtotal) {
      orderSubtotal = subtotalEl.innerText.trim();
    }
  }

  // Order total: grab the last span inside the total row
  let orderTotal = '';
  const totalEl = document.querySelector(CONSTANTS.SELECTORS.ORDER_TOTAL);
  if (totalEl) {
    const spans = totalEl.querySelectorAll('span');
    if (spans.length > 0) {
      orderTotal = spans[spans.length - 1].innerText.trim();
    }
    if (!orderTotal) {
      orderTotal = totalEl.innerText.trim();
    }
  }

  // Helper: find a dollar amount from an ld_FS (or ld_FS-equivalent) screen-reader label
  // The labels look like:  " Tax $5.66"  or  " Bag fee $0.16"
  function extractAmountFromFeeLabel(keyword) {
    const feeLabels = document.querySelectorAll(CONSTANTS.SELECTORS.FEE_LABEL);
    for (const el of feeLabels) {
      const text = el.textContent || '';
      if (text.toLowerCase().includes(keyword.toLowerCase())) {
        const match = text.match(/\$(\d+\.\d{2})/);
        if (match) return `$${match[1]}`;
      }
    }
    return null;
  }

  // Helper: find amount from a .print-fees-item by looking for a visible label text
  function extractAmountFromFeeItem(keyword) {
    const feeItems = document.querySelectorAll(CONSTANTS.SELECTORS.DELIVERY_CHARGES);
    for (const item of feeItems) {
      const labelText = item.textContent || '';
      if (labelText.toLowerCase().includes(keyword.toLowerCase())) {
        // The actual charged amount is always the LAST span inside the
        // "flex justify-between items-end" price row (the first span may be
        // struck-through original price, e.g. "$9.95" crossed out → "$0" actual).
        const priceRow = item.querySelector('.flex.justify-between.items-end');
        if (priceRow) {
          const spans = priceRow.querySelectorAll('span');
          if (spans.length > 0) {
            const t = spans[spans.length - 1].innerText.trim();
            if (t) return t.startsWith('$') ? t : `$${t}`;
          }
        }
        // Fallback: last aria-hidden span with a dollar value
        const spans = Array.from(item.querySelectorAll('span[aria-hidden="true"]'));
        for (let i = spans.length - 1; i >= 0; i--) {
          const t = spans[i].innerText && spans[i].innerText.trim();
          if (t && t.match(/^\$\d/)) return t;
        }
      }
    }
    return null;
  }

  // Tax
  let tax = extractAmountFromFeeItem('Tax') ||
             extractAmountFromFeeLabel('Tax') ||
             '$0.00';

  // Delivery charges (look for "Delivery" fee; Walmart+ shows it as Free/$0)
  let deliveryCharges = extractAmountFromFeeItem('Delivery') ||
                        extractAmountFromFeeLabel('Delivery') ||
                        '$0.00';

  // Tip: look for "Driver tip" or "Tip" in a flex justify-between row
  let tip = '$0.00';
  const tipRows = document.querySelectorAll(CONSTANTS.SELECTORS.TIP);
  for (const row of tipRows) {
    const rowText = row.textContent || '';
    if (rowText.toLowerCase().includes('tip')) {
      const spans = Array.from(row.querySelectorAll('span'));
      for (let i = spans.length - 1; i >= 0; i--) {
        const t = spans[i].innerText && spans[i].innerText.trim();
        if (t && t.match(/^\$\d/)) { tip = t; break; }
      }
      if (tip !== '$0.00') break;
    }
  }


  // Extract payment metadata
  const paymentMethods = [];
  const paymentElements = document.querySelectorAll(CONSTANTS.SELECTORS.PAYMENT_METHODS);
  paymentElements.forEach(el => {
    const text = el.innerText.trim();
    if (text && (
      text.includes('Ending in') || 
      text.includes('Visa') || 
      text.includes('Mastercard') || 
      text.includes('Amex') || 
      text.includes('Discover') ||
      text.toLowerCase().includes('benefit card')
    )) {
      // Avoid duplicates
      if (!paymentMethods.includes(text)) {
        paymentMethods.push(text);
      }
    }
  });

  // Extract address - join lines with comma
  const addressParts = [];
  const addressElements = document.querySelectorAll(CONSTANTS.SELECTORS.ADDRESS);
  addressElements.forEach(el => {
    if (el.innerText && el.innerText.trim()) {
      addressParts.push(el.innerText.trim());
    }
  });
  const address = addressParts.slice(0, 2).join(', ');

  return {
    orderNumber,
    orderDate,
    orderSubtotal,
    orderTotal,
    deliveryCharges,
    tax,
    tip,
    address,
    paymentMethods: paymentMethods.join('; '),
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
