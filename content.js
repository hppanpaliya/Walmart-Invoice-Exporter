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

// Wait until the order detail page has rendered its product cards before
// scraping. The combined-export flow loads each order in a background tab, which
// browsers throttle, so a scrape can otherwise run against a still-blank page and
// yield empty rows. Poll until at least one card has a name, or give up after the
// timeout.
async function waitForOrderItems(
  timeout = CONSTANTS.TIMING.COLLECTION_TIMEOUT,
  pollInterval = CONSTANTS.TIMING.ELEMENT_POLL_INTERVAL
) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const named = Array.from(
      document.querySelectorAll(CONSTANTS.SELECTORS.ITEM_STACK)
    ).some((card) => card.querySelector(CONSTANTS.SELECTORS.CARD_NAME)?.innerText?.trim());
    if (named) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
  console.warn("waitForOrderItems: no populated item cards before timeout");
  return false;
}

// Pull the price actually charged for a line item out of its card. The card's
// price block mixes several dollar amounts - per-item savings ("$3.98 from
// savings"), the discounted price, and the struck-through "Was" price - so we
// strip the savings and "Was" amounts first, then take the remaining price.
function extractCardPrice(card) {
  const priceEl = card.querySelector(CONSTANTS.SELECTORS.CARD_PRICE) || card;
  const text = (priceEl.innerText || "")
    .replace(/\$[\d,.]+\s*from\s+[a-z ]*?(savings|discount)/gi, "")
    .replace(/Was\s*\$[\d,.]+/gi, "");
  const match = text.match(/\$([\d,]+\.\d{2})/);
  return match ? match[1].replace(/,/g, "") : "";
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
    await waitForOrderItems();
    const data = scrapeOrderData();
    // Convert the order details to an XLSX file using the shared convertToXlsx function
    convertToXlsx(data, ExcelJS, { mode: 'single' });
    return { data };
  }),
  [CONSTANTS.MESSAGES.GET_ORDER_DATA]: withImageBlocking(async () => {
    await waitForOrderItems();
    return { data: scrapeOrderData() };
  }),
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

  // Read line items straight from the visible product cards. Walmart removed the
  // hidden ".dn.print-items-list" print markup this used to scrape, which is why
  // name, price, and the product link all stopped populating (the link, in
  // particular, came out "N/A" because the old code matched a print-markup name
  // against a card name by exact string equality across two separately-rendered
  // DOM trees). Each card now carries the product's name, href (with the item id
  // in its /ip/<slug>/<itemId> URL), quantity, and price together, so there is no
  // fragile cross-tree matching.
  const cards = document.querySelectorAll(CONSTANTS.SELECTORS.ITEM_STACK);

  cards.forEach((card) => {
    const productName = card.querySelector(CONSTANTS.SELECTORS.CARD_NAME)?.innerText.trim();
    if (!productName) {
      return; // skip stray cards that carry no product
    }

    const linkEl = card.querySelector(CONSTANTS.SELECTORS.PRODUCT_LINK);
    const productLink = linkEl?.href || "N/A";
    if (productLink === "N/A") {
      console.warn("No product link found for:", productName);
    }

    const qtyMatch = (card.innerText || "").match(/Qty\s*(\d+)/i);

    orderItems.push({
      productName,
      productLink,
      // Per-item delivery status lived in the removed print markup; the live page
      // only exposes delivery status at the order level, so default it here.
      deliveryStatus: CONSTANTS.TEXT.DELIVERY_LABEL,
      quantity: qtyMatch ? qtyMatch[1] : "1",
      price: extractCardPrice(card),
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
  const orderSubtotal = document.querySelector(CONSTANTS.SELECTORS.ORDER_SUBTOTAL)?.innerText || '';
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
    document.querySelector(CONSTANTS.SELECTORS.TIP)?.innerText || "$0.00";

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
