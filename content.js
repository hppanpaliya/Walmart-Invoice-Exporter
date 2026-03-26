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

async function waitForAnyElement(
  selectors,
  timeout = CONSTANTS.TIMING.COLLECTION_TIMEOUT,
  pollInterval = CONSTANTS.TIMING.ELEMENT_POLL_INTERVAL
) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`None of the selectors matched after ${timeout}ms: ${selectors.join(", ")}`);
}

const PurchaseHistoryDataSource = (() => {
  const MESSAGE_SOURCE = "WIE_PURCHASE_HISTORY_BRIDGE";
  const MESSAGE_TYPE = "PURCHASE_HISTORY_SNAPSHOT";
  const NEXT_DATA_SELECTOR = 'script#__NEXT_DATA__';
  const SNAPSHOT_MAX_AGE_MS = 30000;

  let latestSnapshot = null;
  let consumedSnapshotTimestamp = 0;
  let messageListenerAttached = false;

  const normalizeOrderNumber = (value) => String(value || "").replace(/[^\d]/g, "");

  function extractPurchaseHistoryNode(payload) {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    return (
      payload.purchaseHistory ||
      payload.data?.purchaseHistory ||
      payload.props?.pageProps?.phRedesignInitialData?.data?.purchaseHistory ||
      payload.pageProps?.phRedesignInitialData?.data?.purchaseHistory ||
      payload.props?.pageProps?.initialData?.data?.purchaseHistory ||
      payload.pageProps?.initialData?.data?.purchaseHistory ||
      null
    );
  }

  function buildSnapshot(purchaseHistory, source = "unknown") {
    const orders = Array.isArray(purchaseHistory?.orders) ? purchaseHistory.orders : [];
    if (orders.length === 0) {
      return null;
    }

    const orderNumbers = [];
    const additionalFields = {};
    const seen = new Set();

    orders.forEach((order) => {
      const rawOrderNumber =
        order?.id ||
        order?.orderId ||
        order?.displayId ||
        order?.groups?.[0]?.orderId ||
        "";

      const normalizedOrderNumber = normalizeOrderNumber(rawOrderNumber);
      if (!normalizedOrderNumber || seen.has(normalizedOrderNumber)) {
        return;
      }

      seen.add(normalizedOrderNumber);
      orderNumbers.push(normalizedOrderNumber);

      const title = cleanText(
        order?.title ||
        order?.shortTitle ||
        order?.displayId ||
        order?.groups?.[0]?.status?.message?.parts?.[0]?.text ||
        ""
      );
      additionalFields[normalizedOrderNumber] = title;
    });

    if (orderNumbers.length === 0) {
      return null;
    }

    const nextPageCursor = purchaseHistory?.pageInfo?.nextPageCursor || null;
    const signature = `${orderNumbers.slice(0, 3).join("|")}|${nextPageCursor || ""}`;

    return {
      orderNumbers,
      additionalFields,
      hasNextPage: Boolean(nextPageCursor),
      nextPageCursor,
      source,
      signature,
      timestamp: Date.now(),
    };
  }

  function parseSnapshotFromNextData() {
    try {
      const script = document.querySelector(NEXT_DATA_SELECTOR);
      const text = script?.textContent;
      if (!text) {
        return null;
      }

      const parsed = JSON.parse(text);
      const purchaseHistory = extractPurchaseHistoryNode(parsed);
      return buildSnapshot(purchaseHistory, "next-data");
    } catch (error) {
      console.warn("Failed to parse __NEXT_DATA__ purchase history payload", error);
      return null;
    }
  }

  function updateLatestSnapshot(snapshot) {
    if (!snapshot) {
      return;
    }

    if (
      latestSnapshot &&
      latestSnapshot.signature === snapshot.signature &&
      snapshot.timestamp <= latestSnapshot.timestamp
    ) {
      return;
    }

    latestSnapshot = snapshot;
  }

  function getLatestSnapshotTimestamp() {
    return latestSnapshot?.timestamp || 0;
  }

  function getFreshUnconsumedNetworkSnapshot() {
    if (!latestSnapshot || latestSnapshot.source !== "network") {
      return null;
    }

    if (Date.now() - latestSnapshot.timestamp > SNAPSHOT_MAX_AGE_MS) {
      return null;
    }

    if (latestSnapshot.timestamp <= consumedSnapshotTimestamp) {
      return null;
    }

    consumedSnapshotTimestamp = latestSnapshot.timestamp;
    return latestSnapshot;
  }

  function handleBridgeMessage(event) {
    if (event.source !== window) {
      return;
    }

    const message = event.data;
    if (
      !message ||
      message.source !== MESSAGE_SOURCE ||
      message.type !== MESSAGE_TYPE ||
      !message.payload
    ) {
      return;
    }

    const purchaseHistory = extractPurchaseHistoryNode(message.payload) || message.payload;
    const snapshot = buildSnapshot(purchaseHistory, "network");
    updateLatestSnapshot(snapshot);
  }

  function attachBridgeMessageListener() {
    if (messageListenerAttached) {
      return;
    }
    window.addEventListener("message", handleBridgeMessage);
    messageListenerAttached = true;
  }

  function injectNetworkBridgeScript() {
    if (!document.documentElement || document.documentElement.dataset.wiePhBridgeInjected === "true") {
      return;
    }
    document.documentElement.dataset.wiePhBridgeInjected = "true";

    const bridgeScript = document.createElement("script");
    bridgeScript.setAttribute("data-wie-bridge", "purchase-history");
    bridgeScript.textContent = `(() => {
      const SOURCE = ${JSON.stringify(MESSAGE_SOURCE)};
      const TYPE = ${JSON.stringify(MESSAGE_TYPE)};
      const hasOwn = Object.prototype.hasOwnProperty;

      if (window.__wiePurchaseHistoryBridgeInstalled) return;
      window.__wiePurchaseHistoryBridgeInstalled = true;

      const extractPurchaseHistoryNode = (payload) => {
        if (!payload || typeof payload !== "object") return null;
        return (
          payload.purchaseHistory ||
          (payload.data && payload.data.purchaseHistory) ||
          (payload.props && payload.props.pageProps && payload.props.pageProps.phRedesignInitialData && payload.props.pageProps.phRedesignInitialData.data && payload.props.pageProps.phRedesignInitialData.data.purchaseHistory) ||
          (payload.pageProps && payload.pageProps.phRedesignInitialData && payload.pageProps.phRedesignInitialData.data && payload.pageProps.phRedesignInitialData.data.purchaseHistory) ||
          null
        );
      };

      const emit = (purchaseHistory) => {
        if (!purchaseHistory || !Array.isArray(purchaseHistory.orders) || purchaseHistory.orders.length === 0) {
          return;
        }

        window.postMessage(
          {
            source: SOURCE,
            type: TYPE,
            payload: {
              purchaseHistory: {
                orders: purchaseHistory.orders,
                pageInfo: purchaseHistory.pageInfo || null,
              },
            },
          },
          "*"
        );
      };

      const handlePayload = (payload) => {
        const purchaseHistory = extractPurchaseHistoryNode(payload);
        if (purchaseHistory) {
          emit(purchaseHistory);
        }
      };

      const maybeParseJsonText = (text) => {
        if (!text || typeof text !== "string") return;
        if (text.indexOf("purchaseHistory") === -1) return;

        try {
          const parsed = JSON.parse(text);
          handlePayload(parsed);
        } catch (_) {
          // Not a JSON payload we care about
        }
      };

      const patchFetch = () => {
        if (typeof window.fetch !== "function" || window.fetch.__wiePurchaseHistoryWrapped) {
          return;
        }

        const originalFetch = window.fetch.bind(window);
        const wrappedFetch = (...args) =>
          originalFetch(...args).then((response) => {
            try {
              const cloned = response.clone();
              cloned.text().then(maybeParseJsonText).catch(() => {});
            } catch (_) {
              // Ignore clone/read errors
            }
            return response;
          });

        wrappedFetch.__wiePurchaseHistoryWrapped = true;
        window.fetch = wrappedFetch;
      };

      const patchXHR = () => {
        if (XMLHttpRequest.prototype.__wiePurchaseHistoryWrapped) {
          return;
        }

        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.send = function(...args) {
          this.addEventListener(
            "load",
            function () {
              try {
                if (this.responseType && this.responseType !== "" && this.responseType !== "text") {
                  return;
                }
                maybeParseJsonText(this.responseText);
              } catch (_) {
                // Ignore XHR read errors
              }
            },
            { once: true }
          );

          return originalSend.apply(this, args);
        };

        XMLHttpRequest.prototype.__wiePurchaseHistoryWrapped = true;
      };

      const captureInitialNextData = () => {
        const script = document.getElementById("__NEXT_DATA__");
        if (!script || !script.textContent) return;
        maybeParseJsonText(script.textContent);
      };

      patchFetch();
      patchXHR();
      captureInitialNextData();
    })();`;

    (document.head || document.documentElement).appendChild(bridgeScript);
    bridgeScript.remove();
  }

  function initialize() {
    attachBridgeMessageListener();
    injectNetworkBridgeScript();

    // Prime the snapshot cache from initial HTML payload when available.
    updateLatestSnapshot(parseSnapshotFromNextData());
  }

  function getBestSnapshot({ currentPage = 1 } = {}) {
    if (currentPage <= 1) {
      const nextDataSnapshot = parseSnapshotFromNextData();
      if (nextDataSnapshot) {
        updateLatestSnapshot(nextDataSnapshot);
        return nextDataSnapshot;
      }

      const networkSnapshot = getFreshUnconsumedNetworkSnapshot();
      if (networkSnapshot) {
        return networkSnapshot;
      }

      return null;
    }

    const networkSnapshot = getFreshUnconsumedNetworkSnapshot();
    if (networkSnapshot) {
      return networkSnapshot;
    }

    return null;
  }

  return {
    initialize,
    getBestSnapshot,
    getLatestSnapshotTimestamp,
  };
})();

PurchaseHistoryDataSource.initialize();

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
function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeLookupText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[’]/g, "'");
}

function normalizeOrderNumberValue(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function buildProductLinkLookup() {
  const lookup = new Map();
  const itemStacks = document.querySelectorAll(CONSTANTS.SELECTORS.ITEM_STACK);

  itemStacks.forEach((stack) => {
    const productName = cleanText(
      stack.querySelector('[data-testid="productName"] span')?.textContent ||
      stack.querySelector('[data-testid="productName"]')?.textContent
    );
    const productLink = stack.querySelector(CONSTANTS.SELECTORS.PRODUCT_LINK)?.href;

    if (!productName || !productLink) {
      return;
    }

    const normalizedName = normalizeLookupText(productName);
    if (!lookup.has(normalizedName)) {
      lookup.set(normalizedName, productLink);
    }
  });

  return lookup;
}

function resolveProductLink(productName, productLinkLookup) {
  const fallback = "N/A";
  if (!productName || !productLinkLookup || productLinkLookup.size === 0) {
    return fallback;
  }

  const normalizedName = normalizeLookupText(productName);
  if (productLinkLookup.has(normalizedName)) {
    return productLinkLookup.get(normalizedName);
  }

  for (const [name, href] of productLinkLookup.entries()) {
    if (name.includes(normalizedName) || normalizedName.includes(name)) {
      return href;
    }
  }

  return fallback;
}

function extractPrintItem(item) {
  const row = item.querySelector('.flex.justify-between');
  const primaryColumn = row?.querySelector(':scope > :first-child');

  const productName = cleanText(
    primaryColumn?.textContent ||
    item.querySelector(CONSTANTS.SELECTORS.PRINT_ITEM_NAME)?.textContent
  );

  const deliveryStatus = cleanText(
    item.querySelector('.print-bill-type')?.textContent ||
    item.querySelector(CONSTANTS.SELECTORS.PRINT_BILL_TYPE)?.textContent
  ) || CONSTANTS.TEXT.DELIVERY_LABEL;

  const quantity = cleanText(
    item.querySelector('.print-bill-qty')?.textContent ||
    item.querySelector('.print-bill-qty-mobile-view')?.textContent ||
    item.querySelector(CONSTANTS.SELECTORS.PRINT_BILL_QTY)?.textContent
  );

  const price = cleanText(
    item.querySelector('.print-bill-price')?.textContent ||
    item.querySelector(CONSTANTS.SELECTORS.PRINT_BILL_PRICE)?.textContent
  );

  return {
    productName,
    deliveryStatus,
    quantity,
    price,
  };
}

function extractCurrencyValues(value) {
  if (!value) return [];
  const matches = String(value).match(/-?\$[\d,]+(?:\.\d{2})?/g);
  return matches ? matches.map((match) => cleanText(match)) : [];
}

function getLastCurrencyValue(value) {
  const amounts = extractCurrencyValues(value);
  return amounts[amounts.length - 1] || "";
}

function findElementByAriaLabel(fragment, root = document) {
  const searchRoot = root || document;
  const target = normalizeLookupText(fragment);
  return (
    Array.from(searchRoot.querySelectorAll('[aria-label]')).find((el) => {
      const ariaLabel = normalizeLookupText(el.getAttribute('aria-label'));
      return ariaLabel.includes(target);
    }) || null
  );
}

function parseOrderNextDataPayload() {
  try {
    const script = document.querySelector('script#__NEXT_DATA__');
    const payloadText = script?.textContent;
    if (!payloadText) {
      return null;
    }
    return JSON.parse(payloadText);
  } catch (error) {
    console.warn("Unable to parse __NEXT_DATA__ payload for order detail", error);
    return null;
  }
}

function getOrderNodeFromNextDataPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  return (
    payload?.props?.pageProps?.initialData?.data?.order ||
    payload?.pageProps?.initialData?.data?.order ||
    payload?.props?.pageProps?.order ||
    payload?.pageProps?.order ||
    payload?.order ||
    null
  );
}

function extractTextFromNextData(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return cleanText(value);
  }

  if (Array.isArray(value)) {
    return cleanText(value.map((entry) => extractTextFromNextData(entry)).filter(Boolean).join(' '));
  }

  if (Array.isArray(value.parts)) {
    return cleanText(
      value.parts
        .map((part) => cleanText(part?.text || ''))
        .filter(Boolean)
        .join(' ')
    );
  }

  if (value.message) {
    return extractTextFromNextData(value.message);
  }

  if (value.title) {
    return extractTextFromNextData(value.title);
  }

  if (value.text) {
    return cleanText(value.text);
  }

  return '';
}

function formatOrderDateFromIsoString(value) {
  if (!value) {
    return '';
  }

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    return cleanText(value);
  }

  return parsedDate.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });
}

function toAbsoluteWalmartUrl(value) {
  const rawValue = cleanText(value);
  if (!rawValue) {
    return '';
  }

  try {
    return new URL(rawValue, window.location.origin).href;
  } catch (error) {
    return rawValue;
  }
}

function extractNextDataAddressDetails(orderNode) {
  const groups = Array.isArray(orderNode?.groups_2101) ? orderNode.groups_2101 : [];

  const groupWithAddress = groups.find((group) => group?.deliveryAddress?.address) || null;
  const deliveryAddress = groupWithAddress?.deliveryAddress || orderNode?.deliveryAddress || null;

  const addressNode = deliveryAddress?.address || {};
  const recipient = cleanText(
    deliveryAddress?.fullName ||
      [deliveryAddress?.firstName, deliveryAddress?.lastName].filter(Boolean).join(' ') ||
      [orderNode?.customer?.firstName, orderNode?.customer?.lastName].filter(Boolean).join(' ')
  );

  const line = cleanText(
    addressNode?.addressString ||
      [
        addressNode?.addressLineOne,
        addressNode?.addressLineTwo,
        [addressNode?.city, addressNode?.state, addressNode?.postalCode].filter(Boolean).join(' '),
      ]
        .filter(Boolean)
        .join(', ')
  );

  const address = cleanText([recipient, line].filter(Boolean).join(', ')) || line;
  return {
    recipient,
    line,
    address,
  };
}

function extractNextDataPaymentMethods(orderNode) {
  const paymentMethods = Array.isArray(orderNode?.paymentMethods) ? orderNode.paymentMethods : [];

  return paymentMethods
    .map((paymentMethod, index) => {
      const brand = cleanText(paymentMethod?.cardType || paymentMethod?.paymentType || '');
      const ending = cleanText(paymentMethod?.description || paymentMethod?.title || '');
      const amount = cleanText(
        paymentMethod?.displayValues?.[0]?.displayValue ||
          paymentMethod?.displayValues?.[0] ||
          ''
      );
      const message = extractTextFromNextData(paymentMethod?.message);

      return {
        cardId: cleanText(paymentMethod?.paymentPreferenceId || `nextdata-card-${index}`),
        brand,
        ending,
        amount,
        message,
      };
    })
    .filter((entry) => entry.brand || entry.ending || entry.amount || entry.message);
}

function extractNextDataFeeBreakdown(orderNode) {
  const fees = Array.isArray(orderNode?.priceDetails?.fees) ? orderNode.priceDetails.fees : [];

  return fees
    .map((fee) => {
      const label = cleanText(fee?.label || fee?.info?.title || '');
      const amount = cleanText(fee?.displayValue || '');
      const originalAmount = cleanText(fee?.strikeThroughValue || fee?.strikeValue || '');

      return {
        label,
        amount,
        originalAmount,
        rawText: cleanText([label, originalAmount, amount].filter(Boolean).join(' ')),
      };
    })
    .filter((entry) => entry.label || entry.amount || entry.originalAmount);
}

function collectItemsFromNextDataGroups(groups, pushItem) {
  if (!Array.isArray(groups)) {
    return;
  }

  groups.forEach((group) => {
    const groupStatus = extractTextFromNextData(group?.status?.message) || extractTextFromNextData(group?.status);

    if (Array.isArray(group?.items) && group.items.length > 0) {
      group.items.forEach((item) => pushItem(item, groupStatus));
      return;
    }

    const subGroups = Array.isArray(group?.subGroups) ? group.subGroups : [];
    subGroups.forEach((subGroup) => {
      const categories = Array.isArray(subGroup?.categories) ? subGroup.categories : [];
      categories.forEach((category) => {
        const items = Array.isArray(category?.items) ? category.items : [];
        items.forEach((item) => pushItem(item, groupStatus));
      });
    });
  });
}

function extractItemsFromNextData(orderNode) {
  const items = [];
  const seen = new Set();

  const pushItem = (item, groupStatus = '') => {
    const productName = cleanText(item?.productInfo?.name || item?.name || '');
    const quantity = item?.quantity === 0 || item?.quantity
      ? String(item.quantity)
      : '';
    const price = cleanText(
      item?.priceInfo?.linePrice?.displayValue ||
        item?.priceInfo?.itemPrice?.displayValue ||
        item?.linePrice?.displayValue ||
        item?.price?.displayValue ||
        ''
    );

    if (!productName && !quantity && !price) {
      return;
    }

    const key = `${normalizeLookupText(productName)}|${quantity}|${price}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    const canonicalUrl = cleanText(item?.productInfo?.canonicalUrl || item?.canonicalUrl || '');
    const productLink = canonicalUrl ? toAbsoluteWalmartUrl(canonicalUrl) : 'N/A';

    items.push({
      productName,
      productLink,
      deliveryStatus: cleanText(groupStatus) || CONSTANTS.TEXT.DELIVERY_LABEL,
      quantity,
      price,
    });
  };

  collectItemsFromNextDataGroups(orderNode?.groups_2101, pushItem);

  if (items.length === 0) {
    collectItemsFromNextDataGroups(orderNode?.groups, pushItem);
  }

  if (items.length === 0 && Array.isArray(orderNode?.items)) {
    orderNode.items.forEach((item) => pushItem(item, ''));
  }

  return items;
}

function mergeOrderItems(domItems, nextDataItems) {
  const primaryItems = Array.isArray(domItems) ? domItems : [];
  const fallbackItems = Array.isArray(nextDataItems) ? nextDataItems : [];

  if (primaryItems.length === 0) {
    return fallbackItems;
  }

  if (fallbackItems.length === 0) {
    return primaryItems;
  }

  const mergedItems = [...primaryItems];
  const seen = new Set(
    primaryItems.map((item) => {
      const productName = normalizeLookupText(item?.productName || '');
      const quantity = cleanText(item?.quantity || '');
      const price = cleanText(item?.price || '');
      return `${productName}|${quantity}|${price}`;
    })
  );

  fallbackItems.forEach((item) => {
    const productName = normalizeLookupText(item?.productName || '');
    const quantity = cleanText(item?.quantity || '');
    const price = cleanText(item?.price || '');
    const key = `${productName}|${quantity}|${price}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    mergedItems.push(item);
  });

  return mergedItems;
}

function extractOrderDataFromNextData() {
  const payload = parseOrderNextDataPayload();
  const orderNode = getOrderNodeFromNextDataPayload(payload);
  if (!orderNode) {
    return null;
  }

  const feeBreakdown = extractNextDataFeeBreakdown(orderNode);
  const paymentMethodDetails = extractNextDataPaymentMethods(orderNode);
  const paymentMethods = paymentMethodDetails
    .map((method) => [method.brand, method.ending].filter(Boolean).join(' - '))
    .filter(Boolean)
    .join('; ');
  const paymentMessages = Array.from(
    new Set(paymentMethodDetails.map((method) => method.message).filter(Boolean))
  ).join('; ');

  const priceDetails = orderNode?.priceDetails || {};
  const deliveryInstructions = cleanText(
    orderNode?.groups_2101?.find((group) => group?.deliveryInstructions)?.deliveryInstructions?.text ||
      orderNode?.deliveryInstructions?.text ||
      ''
  );

  const addressDetails = extractNextDataAddressDetails(orderNode);

  return {
    orderNumber: normalizeOrderNumberValue(orderNode?.id || orderNode?.displayId),
    orderDate:
      formatOrderDateFromIsoString(orderNode?.orderDate) ||
      cleanText(orderNode?.shortTitle || orderNode?.title).replace(/order/i, '').trim(),
    orderSubtotal: cleanText(priceDetails?.subTotal?.displayValue || ''),
    subtotalBeforeSavings: cleanText(priceDetails?.strikethroughSubTotal?.displayValue || ''),
    savings: cleanText(priceDetails?.savings?.displayValue || ''),
    orderTotal: cleanText(priceDetails?.grandTotalWithTips?.displayValue || priceDetails?.grandTotal?.displayValue || ''),
    deliveryCharges: getFeeAmount(feeBreakdown, 'delivery') || '',
    bagFee: getFeeAmount(feeBreakdown, 'bag fee') || getFeeAmount(feeBreakdown, 'bag') || '',
    tax: cleanText(priceDetails?.taxTotal?.displayValue || ''),
    tip: cleanText(priceDetails?.driverTip?.displayValue || ''),
    address: addressDetails.address,
    addressRecipient: addressDetails.recipient,
    addressLine: addressDetails.line,
    deliveryInstructions,
    paymentMethods,
    paymentMethodDetails,
    paymentMessages,
    items: extractItemsFromNextData(orderNode),
  };
}

function extractAddressDetailsFromOrderPage() {
  const addressContainers = Array.from(
    document.querySelectorAll('.print-bill-payment-section .flex.flex-column.mid-gray, .print-bill-payment-section [data-sensitivity="severe"]')
  );

  const parts = [];
  const seen = new Set();

  addressContainers.forEach((container) => {
    const lines = Array.from(container.querySelectorAll('[data-sensitivity="medium"], span'))
      .map((el) => cleanText(el.textContent))
      .filter(Boolean);

    lines.forEach((line) => {
      const key = line.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        parts.push(line);
      }
    });
  });

  if (parts.length > 0) {
    const recipient = parts[0] || "";
    const line = parts.slice(1).join(', ');
    const address = parts.slice(0, 2).join(', ');
    return { recipient, line, address };
  }

  const fallbackParts = Array.from(document.querySelectorAll(CONSTANTS.SELECTORS.ADDRESS))
    .map((el) => cleanText(el.textContent))
    .filter(Boolean);

  const deduped = Array.from(new Set(fallbackParts));
  return {
    recipient: deduped[0] || "",
    line: deduped.slice(1).join(', '),
    address: deduped.slice(0, 2).join(', '),
  };
}

function extractAddressFromOrderPage() {
  return extractAddressDetailsFromOrderPage().address;
}

function extractDeliveryInstructionsFromOrderPage() {
  const heading = Array.from(document.querySelectorAll('.print-bill-payment-section h2'))
    .find((node) => normalizeLookupText(node.textContent).includes('delivery instructions'));
  const toggleButton = document.querySelector('button[data-automation-id="delivery-instruction-hide-show-link"]');
  const expanded = toggleButton?.getAttribute('aria-expanded') === 'true';

  if (!heading) {
    return { instructions: '', expanded };
  }

  const section =
    heading.closest('div.ph3.pv4.pb3-m.ph0-m.pt0-m') ||
    heading.parentElement?.parentElement ||
    heading.parentElement;

  if (!section) {
    return { instructions: '', expanded };
  }

  const clone = section.cloneNode(true);
  clone.querySelectorAll('h1, h2, h3, h4, h5, h6, button').forEach((el) => el.remove());

  const instructions = cleanText(clone.textContent)
    .replace(/show delivery instructions/i, '')
    .replace(/hide delivery instructions/i, '')
    .trim();

  return { instructions, expanded };
}

function extractFeeBreakdownFromOrderPage() {
  const feeRows = Array.from(document.querySelectorAll('.print-bill-payment-section .print-fees-item'));

  return feeRows
    .map((row) => {
      const srText = cleanText(row.querySelector('.ld_FS')?.textContent || '');
      const labelText = cleanText(
        row.querySelector('.pr3 .ld_Ek.ld_Eq.ld_Eo')?.textContent ||
        row.querySelector('.pr3 .ld_Ek.ld_Eq.ld_En')?.textContent ||
        row.querySelector('.pr3 .ld_Ek.ld_Eq')?.textContent
      );

      const visibleAmounts = Array.from(
        row.querySelectorAll('.flex.justify-between.items-end span, .flex.justify-between.items-end .ld_Ek')
      )
        .map((el) => cleanText(el.textContent))
        .filter((value) => /\$/.test(value));

      const srAmounts = extractCurrencyValues(srText);
      const amount = visibleAmounts[visibleAmounts.length - 1] || srAmounts[srAmounts.length - 1] || '';
      const originalAmount = visibleAmounts.length > 1
        ? visibleAmounts[0]
        : (srAmounts.length > 1 ? srAmounts[0] : '');

      let label = labelText;
      if (!label && srText) {
        label = cleanText(srText.replace(/-?\$[\d,]+(?:\.\d{2})?/g, ' '));
      }

      return {
        label,
        amount,
        originalAmount,
        rawText: srText,
      };
    })
    .filter((fee) => fee.label || fee.amount || fee.originalAmount);
}

function getFeeAmount(feeBreakdown, keyword) {
  const normalizedKeyword = normalizeLookupText(keyword);
  const fee = feeBreakdown.find((entry) => {
    const label = normalizeLookupText(entry.label || '');
    const rawText = normalizeLookupText(entry.rawText || '');
    return label.includes(normalizedKeyword) || rawText.includes(normalizedKeyword);
  });

  return fee?.amount || '';
}

function extractPaymentDetailsFromOrderPage() {
  const methods = [];
  const seen = new Set();

  const paymentRows = Array.from(document.querySelectorAll('.bill-order-payment-info .flex.items-center.mb3'));

  paymentRows.forEach((row) => {
    const endingElement = row.querySelector('[aria-labelledby^="card-description-"]');
    const ending = cleanText(endingElement?.textContent || '');
    const cardId = cleanText(endingElement?.getAttribute('aria-labelledby') || ending);
    if (!cardId && !ending) {
      return;
    }

    const brand = cleanText(row.querySelector('img[alt]')?.alt || '');
    const amount = cleanText(row.querySelector('.tr.flex-auto')?.textContent || '');
    const message = cleanText(row.parentElement?.querySelector('.mt3')?.textContent || '');

    const key = `${cardId}|${brand}|${ending}|${amount}|${message}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    methods.push({ cardId, brand, ending, amount, message });
  });

  if (methods.length > 0) {
    return methods;
  }

  // Legacy fallback
  const fallbackElements = document.querySelectorAll(CONSTANTS.SELECTORS.PAYMENT_METHODS);
  fallbackElements.forEach((el) => {
    const ending = cleanText(el.textContent || '');
    if (!ending) {
      return;
    }

    const cardId = cleanText(el.getAttribute('aria-labelledby') || ending);
    const brand = cleanText(el.closest('.flex.items-center')?.querySelector('img[alt]')?.alt || '');
    const key = `${cardId}|${brand}|${ending}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    methods.push({ cardId, brand, ending, amount: '', message: '' });
  });

  return methods;
}

function scrapeOrderData() {
  const orderItems = [];
  const productLinkLookup = buildProductLinkLookup();
  const nextDataOrder = extractOrderDataFromNextData();

  // Query the hidden print items list which contains reliable product data
  // This list is always present in the DOM (hidden via .dn class) and is populated on page load.
  // It provides a cleaner data structure compared to the complex interactive UI.
  const printItemsList = document.querySelectorAll(CONSTANTS.SELECTORS.PRINT_ITEMS);

  printItemsList.forEach((item) => {
    const { productName, deliveryStatus, quantity, price } = extractPrintItem(item);
    if (!productName && !quantity && !price) {
      return;
    }

    const productLink = resolveProductLink(productName, productLinkLookup);

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
          const normalized = normalizeOrderNumberValue(match[1]);
          if (normalized) {
            return normalized;
          }
        }
      }
    }

    const pathMatch = window.location.pathname.match(/\/orders\/([\d-]+)/);
    if (pathMatch?.[1]) {
      const normalized = normalizeOrderNumberValue(pathMatch[1]);
      if (normalized) {
        return normalized;
      }
    }

    console.log("Order number not found with current selectors");
    return null;
  }

  // Extract order metadata
  const orderNumber = findOrderNumber() || nextDataOrder?.orderNumber || null;
  let orderDate = document.querySelector(CONSTANTS.SELECTORS.ORDER_DATE)?.innerText || '';
  orderDate = orderDate.replace("order", "").trim();
  if (!orderDate) {
    orderDate = cleanText(nextDataOrder?.orderDate || '');
  }

  // ----- Extract order totals and fee breakdown -----
  const paymentSection = document.querySelector('.print-bill-payment-section') || document;
  const subtotalAfterSavingsNode = findElementByAriaLabel('subtotal after savings', paymentSection);
  let orderSubtotal = getLastCurrencyValue(
    subtotalAfterSavingsNode?.getAttribute('aria-label') || subtotalAfterSavingsNode?.textContent
  );

  // Fallback for layouts that do not expose subtotal-after-savings aria labels.
  if (!orderSubtotal) {
    const subtotalEl = document.querySelector(CONSTANTS.SELECTORS.ORDER_SUBTOTAL);
    if (subtotalEl) {
      const spans = subtotalEl.querySelectorAll('span');
      if (spans.length > 0) {
        orderSubtotal = cleanText(spans[spans.length - 1].innerText);
      }
      if (!orderSubtotal) {
        orderSubtotal = cleanText(subtotalEl.innerText);
      }
    }
  }

  if (!orderSubtotal && nextDataOrder?.orderSubtotal) {
    orderSubtotal = cleanText(nextDataOrder.orderSubtotal);
  }

  const subtotalBeforeSavingsNode = findElementByAriaLabel('subtotal was', paymentSection);
  let subtotalBeforeSavings = getLastCurrencyValue(
    subtotalBeforeSavingsNode?.getAttribute('aria-label') || subtotalBeforeSavingsNode?.textContent
  );
  if (!subtotalBeforeSavings && nextDataOrder?.subtotalBeforeSavings) {
    subtotalBeforeSavings = cleanText(nextDataOrder.subtotalBeforeSavings);
  }

  let savings = '';
  const savingsNode = findElementByAriaLabel('savings', paymentSection);
  if (savingsNode) {
    const savingsText = savingsNode.getAttribute('aria-label') || savingsNode.textContent || '';
    const savingsAmount = getLastCurrencyValue(savingsText);
    if (savingsAmount) {
      savings = savingsAmount.startsWith('-') ? savingsAmount : `-${savingsAmount.replace(/^-/, '')}`;
    }
  }

  if (!savings) {
    const savingsBadgeText = cleanText(document.querySelector('.bill-order-payment-spacing .Tag_tag__9ThK9')?.textContent || '');
    const savingsAmount = getLastCurrencyValue(savingsBadgeText);
    if (savingsAmount) {
      savings = savingsAmount.startsWith('-') ? savingsAmount : `-${savingsAmount.replace(/^-/, '')}`;
    }
  }

  if (!savings && nextDataOrder?.savings) {
    savings = cleanText(nextDataOrder.savings);
  }

  let orderTotal = '';
  const totalEl = document.querySelector(CONSTANTS.SELECTORS.ORDER_TOTAL);
  if (totalEl) {
    const spans = totalEl.querySelectorAll('span');
    if (spans.length > 0) {
      orderTotal = cleanText(spans[spans.length - 1].innerText);
    }
    if (!orderTotal) {
      orderTotal = cleanText(totalEl.innerText);
    }
  }

  if (!orderTotal && nextDataOrder?.orderTotal) {
    orderTotal = cleanText(nextDataOrder.orderTotal);
  }

  let feeBreakdown = extractFeeBreakdownFromOrderPage();

  let deliveryCharges = getFeeAmount(feeBreakdown, 'delivery') || '$0.00';
  let bagFee = getFeeAmount(feeBreakdown, 'bag fee') || getFeeAmount(feeBreakdown, 'bag') || '$0.00';
  let tax = getFeeAmount(feeBreakdown, 'tax') || '$0.00';

  // Additional fallbacks from screen-reader labels when line-item parsing misses.
  if (!tax || tax === '$0.00') {
    const taxFromLabel = getLastCurrencyValue(
      Array.from(document.querySelectorAll(CONSTANTS.SELECTORS.FEE_LABEL))
        .map((el) => cleanText(el.textContent))
        .find((text) => normalizeLookupText(text).includes('tax'))
    );
    tax = taxFromLabel || '$0.00';
  }

  if (!bagFee || bagFee === '$0.00') {
    const bagFromLabel = getLastCurrencyValue(
      Array.from(document.querySelectorAll(CONSTANTS.SELECTORS.FEE_LABEL))
        .map((el) => cleanText(el.textContent))
        .find((text) => normalizeLookupText(text).includes('bag fee'))
    );
    bagFee = bagFromLabel || '$0.00';
  }

  if ((!deliveryCharges || deliveryCharges === '$0.00') && nextDataOrder?.deliveryCharges) {
    deliveryCharges = cleanText(nextDataOrder.deliveryCharges);
  }

  if ((!bagFee || bagFee === '$0.00') && nextDataOrder?.bagFee) {
    bagFee = cleanText(nextDataOrder.bagFee);
  }

  if ((!tax || tax === '$0.00') && nextDataOrder?.tax) {
    tax = cleanText(nextDataOrder.tax);
  }

  // Tip: look for "Driver tip" or "Tip" in a flex justify-between row
  let tip = '$0.00';
  const tipRows = document.querySelectorAll(CONSTANTS.SELECTORS.TIP + ', .print-bill-payment-section .flex.justify-between');
  for (const row of tipRows) {
    const rowText = cleanText(row.textContent || '');
    if (normalizeLookupText(rowText).includes('tip')) {
      const parsedTip = getLastCurrencyValue(rowText);
      if (parsedTip) {
        tip = parsedTip;
      }
      if (tip !== '$0.00') break;
    }
  }

  if ((!tip || tip === '$0.00') && nextDataOrder?.tip) {
    tip = cleanText(nextDataOrder.tip);
  }

  let paymentMethodDetails = extractPaymentDetailsFromOrderPage();
  if (
    (!Array.isArray(paymentMethodDetails) || paymentMethodDetails.length === 0) &&
    Array.isArray(nextDataOrder?.paymentMethodDetails)
  ) {
    paymentMethodDetails = nextDataOrder.paymentMethodDetails;
  }

  const paymentMethods = paymentMethodDetails
    .map((method) => [method.brand, method.ending].filter(Boolean).join(' - '))
    .filter(Boolean);
  let paymentMessages = Array.from(new Set(
    paymentMethodDetails.map((method) => method.message).filter(Boolean)
  ));
  if (paymentMessages.length === 0 && nextDataOrder?.paymentMessages) {
    paymentMessages = cleanText(nextDataOrder.paymentMessages)
      .split(';')
      .map((value) => cleanText(value))
      .filter(Boolean);
  }

  let addressDetails = extractAddressDetailsFromOrderPage();
  if (!addressDetails.address && (nextDataOrder?.address || nextDataOrder?.addressRecipient)) {
    addressDetails = {
      recipient: cleanText(nextDataOrder?.addressRecipient || ''),
      line: cleanText(nextDataOrder?.addressLine || nextDataOrder?.address || ''),
      address: cleanText(nextDataOrder?.address || ''),
    };
  }

  const address =
    addressDetails.address ||
    cleanText(nextDataOrder?.address || '') ||
    extractAddressFromOrderPage();

  let { instructions: deliveryInstructions, expanded: deliveryInstructionsExpanded } =
    extractDeliveryInstructionsFromOrderPage();
  if (!deliveryInstructions && nextDataOrder?.deliveryInstructions) {
    deliveryInstructions = cleanText(nextDataOrder.deliveryInstructions);
  }

  const items = mergeOrderItems(orderItems, nextDataOrder?.items || []);
  const resolvedOrderNumber = orderNumber || nextDataOrder?.orderNumber || null;
  const resolvedOrderDate = orderDate || cleanText(nextDataOrder?.orderDate || '');

  return {
    schemaVersion: 1,
    orderNumber: resolvedOrderNumber,
    orderDate: resolvedOrderDate,
    orderSubtotal,
    subtotalBeforeSavings,
    savings,
    orderTotal,
    deliveryCharges,
    bagFee,
    tax,
    tip,
    address,
    addressRecipient: addressDetails.recipient,
    addressLine: addressDetails.line,
    deliveryInstructions,
    deliveryInstructionsExpanded,
    paymentMethods: paymentMethods.join('; ') || cleanText(nextDataOrder?.paymentMethods || ''),
    paymentMethodDetails,
    paymentMessages: paymentMessages.join('; '),
    items,
  };
}

function extractOrderNumberFromText(text) {
  if (!text) return null;

  const hashMatch = String(text).match(CONSTANTS.ORDER_NUMBER_REGEX);
  if (hashMatch?.[1]) {
    return hashMatch[1];
  }

  const looseMatch = String(text).match(/\b(\d[\d-]{9,})\b/);
  return looseMatch?.[1] || null;
}

function getOrderCardTitle(card) {
  const titleSelectors = [
    "h2",
    "h3",
    "[data-testid*='title']",
    "[class*='title']",
    "button[data-automation-id^='view-order-details-link-']",
  ];

  for (const selector of titleSelectors) {
    const element = card.querySelector(selector);
    const text = element?.textContent?.trim();
    if (text) {
      return text;
    }
  }

  return card.textContent?.trim() || "";
}

function extractOrderNumberFromButton(button, fallbackContainer = null) {
  const automationId = button?.getAttribute?.("data-automation-id") || "";
  const automationMatch = automationId.match(/view-order-details-link-([\d-]+)/);
  if (automationMatch?.[1]) {
    return automationMatch[1];
  }

  const buttonText = button?.textContent?.trim();
  const buttonFallback = extractOrderNumberFromText(buttonText);
  if (buttonFallback) {
    return buttonFallback;
  }

  if (fallbackContainer) {
    return extractOrderNumberFromText(fallbackContainer.textContent || "");
  }

  return null;
}

/**
 * Handles order number collection from order history page.
 * Waits for page elements to load, then extracts order data.
 */
async function handleCollectOrderNumbers(request = {}) {
  const currentPage = Number(request.currentPage || 1);

  try {
    // Page 1 can use server-hydrated HTML payload; later pages should rely on
    // network snapshots or updated DOM after pagination.
    const readinessSelectors = currentPage <= 1
      ? [
          'script#__NEXT_DATA__',
          CONSTANTS.SELECTORS.ORDER_CARDS,
          'button[data-automation-id^="view-order-details-link-"]',
          CONSTANTS.SELECTORS.MAIN_HEADING,
        ]
      : [
          CONSTANTS.SELECTORS.ORDER_CARDS,
          'button[data-automation-id^="view-order-details-link-"]',
          CONSTANTS.SELECTORS.MAIN_HEADING,
        ];

    await waitForAnyElement(readinessSelectors);

    let sourceSnapshot = PurchaseHistoryDataSource.getBestSnapshot({ currentPage });
    // Give page-2+ network payloads a short extra window before falling back to DOM.
    if (!sourceSnapshot && currentPage > 1) {
      await delay(300);
      sourceSnapshot = PurchaseHistoryDataSource.getBestSnapshot({ currentPage });
    }

    if (sourceSnapshot) {
      console.log(
        `Collected ${sourceSnapshot.orderNumbers.length} order numbers from ${sourceSnapshot.source} on page ${currentPage}. Has next page: ${sourceSnapshot.hasNextPage}`
      );
      return {
        orderNumbers: sourceSnapshot.orderNumbers,
        additionalFields: sourceSnapshot.additionalFields,
        hasNextPage: sourceSnapshot.hasNextPage,
      };
    }

    const { orderNumbers, additionalFields } = extractOrderNumbers();
    const hasNextPage = await checkForNextPage();

    console.log(`Extracted ${orderNumbers.length} order numbers. Has next page: ${hasNextPage}`);
    return { orderNumbers, additionalFields, hasNextPage };
  } catch (error) {
    console.error("Error during collection:", error);
    // Timeout errors indicate no more orders on this page
    if (
      error.message.includes("not found after") ||
      error.message.includes("None of the selectors matched")
    ) {
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
    await waitForAnyElement([
      CONSTANTS.SELECTORS.NEXT_BUTTON,
      'button[aria-label*="Next"]',
      'button[data-automation-id*="next-pages-button"]',
    ]);

    const nextButton = findNextPageButton();
    if (!nextButton) {
      console.warn("Next page button not found or is disabled");
      return { success: false };
    }

    const previousSignature = getOrderListSignature();
    const previousUrl = window.location.href;
    const previousSnapshotTimestamp = PurchaseHistoryDataSource.getLatestSnapshotTimestamp();

    nextButton.scrollIntoView({ block: "center", inline: "center" });
    nextButton.click();

    const pageChanged = await waitForOrdersListTransition(
      previousSignature,
      previousUrl,
      previousSnapshotTimestamp
    );
    if (!pageChanged) {
      console.warn("Next page click did not trigger a visible page transition");
      return { success: false };
    }

    return { success: true };
  } catch (error) {
    console.error("Error clicking next button:", error);
    return { success: false };
  }
}

function isButtonDisabled(button) {
  if (!button) return true;
  return (
    button.disabled ||
    button.hasAttribute("disabled") ||
    button.getAttribute("aria-disabled") === "true"
  );
}

function isElementVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findNextPageButton() {
  const selectors = [
    CONSTANTS.SELECTORS.NEXT_BUTTON,
    'button[data-automation-id="next-pages-button"]',
    'button[data-automation-id*="next-pages-button"]',
    'button[aria-label*="Next page"]',
    'button[aria-label*="Next"]',
  ];

  for (const selector of selectors) {
    const buttons = Array.from(document.querySelectorAll(selector));
    const candidate = buttons.find((button) => !isButtonDisabled(button) && isElementVisible(button));
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function getOrderListSignature() {
  const detailButtonIds = Array.from(
    document.querySelectorAll('button[data-automation-id^="view-order-details-link-"]')
  )
    .slice(0, 3)
    .map((button) => button.getAttribute("data-automation-id"))
    .filter(Boolean);

  if (detailButtonIds.length > 0) {
    return detailButtonIds.join("|");
  }

  const cards = Array.from(document.querySelectorAll(CONSTANTS.SELECTORS.ORDER_CARDS)).slice(0, 2);
  const fallback = cards
    .map((card) => {
      const keyNode = card.querySelector("[id^='caption-'], h2, h3");
      const text = keyNode?.textContent || card.textContent || "";
      return text.replace(/\s+/g, " ").trim().slice(0, 120);
    })
    .filter(Boolean);

  return fallback.join("|");
}

async function waitForOrdersListTransition(
  previousSignature,
  previousUrl,
  previousSnapshotTimestamp = 0,
  timeout = CONSTANTS.TIMING.COLLECTION_TIMEOUT,
  pollInterval = CONSTANTS.TIMING.ELEMENT_POLL_INTERVAL
) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const latestSnapshotTimestamp = PurchaseHistoryDataSource.getLatestSnapshotTimestamp();
    const currentUrl = window.location.href;
    const currentSignature = getOrderListSignature();

    if (latestSnapshotTimestamp > previousSnapshotTimestamp) {
      return true;
    }

    if (currentUrl !== previousUrl) {
      return true;
    }

    if (currentSignature && previousSignature && currentSignature !== previousSignature) {
      return true;
    }

    if (currentSignature && !previousSignature) {
      return true;
    }

    await delay(pollInterval);
  }

  return false;
}

/**
 * Single-pass order extraction using efficient DOM traversal.
 * Queries order cards once, then finds child elements within each card.
 * @returns {Object} Object containing orderNumbers array and additionalFields map
 */
function extractOrderNumbers() {
  const orderNumbers = [];
  const additionalFields = {};
  const seenOrderNumbers = new Set();

  // Prefer the current card wrapper, but fall back to the order details button
  // when Walmart reshuffles the surrounding DOM structure.
  const orderCards = Array.from(document.querySelectorAll(CONSTANTS.SELECTORS.ORDER_CARDS));
  const detailButtons = Array.from(
    document.querySelectorAll('button[data-automation-id^="view-order-details-link-"]')
  );

  const cardSources = orderCards.length > 0
    ? orderCards
    : detailButtons.map((button) => button.closest('[data-testid^="order-"], article, section, li, div') || button);

  if (cardSources.length === 0) {
    console.warn("No order cards or order detail buttons found on the page");
    return { orderNumbers, additionalFields };
  }

  // Single-pass traversal: query within each card to avoid redundant global queries
  cardSources.forEach((card, index) => {
    try {
      const button = card.querySelector('button[data-automation-id^="view-order-details-link-"]')
        || (card.matches?.('button[data-automation-id^="view-order-details-link-"]') ? card : null)
        || detailButtons[index]
        || null;
      const title = getOrderCardTitle(card);
      const orderNumber = extractOrderNumberFromButton(button, card);

      if (orderNumber && !seenOrderNumbers.has(orderNumber)) {
        seenOrderNumbers.add(orderNumber);
        orderNumbers.push(orderNumber);
        additionalFields[orderNumber] = title;
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
    return !!findNextPageButton();
  } catch (error) {
    console.error("Error checking for next page:", error);
    return false;
  }
}
