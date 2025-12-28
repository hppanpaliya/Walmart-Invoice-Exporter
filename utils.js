/**
 * Shared utility functions for Excel export functionality
 * Used by both content.js and popup.js
 */

// Define font styles as constants
const STYLES = {
  headerFont: { size: 12, bold: true, name: "Times New Roman" },
  productFont: { size: 12, name: "Times New Roman" },
  boldFont: { size: 12, bold: true, name: "Times New Roman" },
  linkFont: { color: { argb: "FF0000FF" }, underline: true },
};

/**
 * Parse a numeric value from a string, removing currency symbols and formatting
 * @param {string} value - The value to parse (e.g., "$123.45", "100")
 * @returns {number} The parsed number value
 */
function parseNumericValue(value) {
  if (typeof value === 'number') return value;
  return Number(String(value || '').replace(/[^0-9.-]+/g, '')) || 0;
}

/**
 * Configure columns for a single order export worksheet
 * @param {ExcelJS.Worksheet} worksheet - The worksheet to configure
 */
function configureSingleOrderColumns(worksheet) {
  worksheet.columns = [
    { header: "Product Name", key: "productName", width: 60 },
    { header: "Quantity", key: "quantity", width: 20, style: { numFmt: "#,##0", alignment: { horizontal: "center" } } },
    { header: "Price", key: "price", width: 20, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: "Delivery Status", key: "deliveryStatus", width: 30, style: { alignment: { horizontal: "center" } } },
    { header: "Product Link", key: "productLink", width: 60, style: { font: STYLES.linkFont } },
  ];
}

/**
 * Configure columns for a combined multiple orders export worksheet
 * @param {ExcelJS.Worksheet} worksheet - The worksheet to configure
 */
function configureMultipleOrdersColumns(worksheet) {
  worksheet.columns = [
    { header: 'Order Number', key: 'orderNumber', width: 20, style: { alignment: { horizontal: "center" } } },
    { header: 'Order Date', key: 'orderDate', width: 20, style: { alignment: { horizontal: "center" } } },
    { header: 'Product Name', key: 'productName', width: 60, style: { alignment: { horizontal: "center" } } },
    { header: 'Quantity', key: 'quantity', width: 10, style: { numFmt: "#,##0", alignment: { horizontal: "center" } } },
    { header: 'Price', key: 'price', width: 10, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: 'Delivery Status', key: 'deliveryStatus', width: 20, style: { alignment: { horizontal: "center" } } },
    { header: 'Product Link', key: 'productLink', width: 60 , style: { font: STYLES.linkFont } },
  ];
}

/**
 * Add items from a single order to a worksheet
 * @param {ExcelJS.Worksheet} worksheet - The worksheet to add items to
 * @param {Array} items - The items to add
 */
function addItemsToWorksheet(worksheet, items) {
  items.forEach((item) => {
    const row = worksheet.addRow({
      productName: item.productName,
      productLink: {
        text: truncateText(item.productName),
        hyperlink: item.productLink
      },
      quantity: parseNumericValue(item.quantity),
      price: parseNumericValue(item.price),
      deliveryStatus: item.deliveryStatus,
    });
    row.font = STYLES.productFont;
  });
}

/**
 * Add items from multiple orders to a worksheet
 * @param {ExcelJS.Worksheet} worksheet - The worksheet to add items to
 * @param {Array} items - The items to add (with orderNumber and orderDate)
 */
function addMultipleOrderItemsToWorksheet(worksheet, items) {
  items.forEach((item) => {
    worksheet.addRow({
      orderNumber: item.orderNumber || '',
      orderDate: item.orderDate || '',
      productName: item.productName || '',
      quantity: parseNumericValue(item.quantity),
      price: parseNumericValue(item.price),
      deliveryStatus: item.deliveryStatus || '',
      productLink: {
        text: truncateText(item.productName),
        hyperlink: item.productLink
      },
    });
  });
}

/**
 * Apply styling to worksheet for single order export
 * @param {ExcelJS.Worksheet} worksheet - The worksheet to style
 */
function styleSingleOrderWorksheet(worksheet) {
  // Apply product font to all cells
  worksheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.font = STYLES.productFont;
    });
    const cell = row.getCell("productLink");
    if (cell) {
      cell.font = STYLES.linkFont;
    }
  });

  // Apply header font to first row
  worksheet.getRow(1).eachCell((cell) => {
    cell.font = STYLES.headerFont;
  });
}

/**
 * Apply styling to worksheet for multiple orders export
 * @param {ExcelJS.Worksheet} worksheet - The worksheet to style
 */
function styleMultipleOrdersWorksheet(worksheet) {
  worksheet.getRow(1).font = { bold: true };
}

/**
 * Add order summary details to a worksheet (for single order export)
 * @param {ExcelJS.Worksheet} worksheet - The worksheet to add details to
 * @param {Object} orderDetails - The order details object
 */
function addOrderSummary(worksheet, orderDetails) {
  // Add empty row for spacing
  worksheet.addRow([]);

  // Add order details
  const rows = [
    ['Order Number', orderDetails.orderNumber],
    ['Order Date', orderDetails.orderDate],
    ['Delivery Charges', parseNumericValue(orderDetails.deliveryCharges)],
    ['Tax', parseNumericValue(orderDetails.tax)],
    ['Tip', parseNumericValue(orderDetails.tip)],
    ['Order Total', parseNumericValue(orderDetails.orderTotal)],
  ];

  const summaryRows = rows.map(([label, value]) => {
    const row = worksheet.addRow([label, value]);
    row.font = { ...STYLES.productFont, bold: true };
    return row;
  });

  // Apply currency formatting to numeric values
  summaryRows.slice(2).forEach((row) => {
    row.getCell(2).numFmt = "$#,##0.00";
    row.getCell(2).font = { ...STYLES.productFont, bold: true };
    row.getCell(1).font = { ...STYLES.productFont, bold: true };
    row.getCell(2).alignment = { horizontal: "center" };
  });
}

/**
 * Trigger download of a workbook as an Excel file
 * @param {ExcelJS.Workbook} workbook - The workbook to download
 * @param {string} filename - The filename for the download
 */
async function downloadWorkbook(workbook, filename) {
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.URL.revokeObjectURL(url);
}

/**
 * Convert order data to Excel format and download
 * Flexible function that handles both single order and multiple order exports
 * 
 * @param {Object} orderDetails - The order data (for single) or array of orders (for multiple)
 * @param {Object} ExcelJS - The ExcelJS library
 * @param {Object} options - Configuration options
 * @param {string} options.mode - Export mode: 'single' (one order with summary) or 'multiple' (all items combined)
 * @param {string} options.filename - Optional custom filename
 */
async function convertToXlsx(orderDetails, ExcelJS, options = {}) {
  const { mode = 'single', filename = null } = options;

  if (mode === 'single') {
    // Single order export with full details
    return convertSingleOrderToXlsx(orderDetails, ExcelJS, filename);
  } else if (mode === 'multiple') {
    // Multiple orders combined into one sheet
    return convertMultipleOrdersToXlsx(orderDetails, ExcelJS, filename);
  }
}

/**
 * Convert a single order to XLSX format with full details including summary
 * @param {Object} orderDetails - The order details object
 * @param {Object} ExcelJS - The ExcelJS library
 * @param {string} filename - Optional custom filename
 */
async function convertSingleOrderToXlsx(orderDetails, ExcelJS, filename = null) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Order Invoice");

  // Configure columns for single order
  configureSingleOrderColumns(worksheet);

  // Add items
  addItemsToWorksheet(worksheet, orderDetails.items || []);

  // Add order summary
  addOrderSummary(worksheet, orderDetails);

  // Apply styling
  styleSingleOrderWorksheet(worksheet);

  // Download
  const downloadFilename = filename || `Order_${orderDetails.orderNumber}.xlsx`;
  await downloadWorkbook(workbook, downloadFilename);
}

/**
 * Convert multiple orders data to a single XLSX file with all items combined
 * @param {Array} ordersData - Array of order data objects, each containing items with order details
 * @param {Object} ExcelJS - The ExcelJS library
 * @param {string} filename - Optional custom filename
 */
async function convertMultipleOrdersToXlsx(ordersData, ExcelJS, filename = null) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Walmart Orders');

  // Configure columns for multiple orders
  configureMultipleOrdersColumns(worksheet);

  // Flatten all items from all orders into a single list with order info
  const allItems = [];
  const ordersArray = Array.isArray(ordersData) ? ordersData : [ordersData];
  
  ordersArray.forEach((orderDetails) => {
    (orderDetails.items || []).forEach((item) => {
      allItems.push({
        orderNumber: orderDetails.orderNumber || '',
        orderDate: orderDetails.orderDate || '',
        productName: item.productName || '',
        quantity: item.quantity,
        price: item.price,
        deliveryStatus: item.deliveryStatus || '',
        productLink: item.productLink || '',
      });
    });
  });

  // Add all items to worksheet
  addMultipleOrderItemsToWorksheet(worksheet, allItems);

  // Apply styling
  styleMultipleOrdersWorksheet(worksheet);

  // Download
  const downloadFilename = filename || 'Walmart_Orders.xlsx';
  await downloadWorkbook(workbook, downloadFilename);
}

/**
 * SVG Icon constants - Centralized icon definitions used throughout the extension
 */
const SVG_ICONS = {
  ERROR_CIRCLE: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
  
  SUCCESS_CHECKMARK: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>',
  
  TRASH: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>',
  
  PACKAGE: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>',
  
  INFO_CIRCLE: '<svg width="12" height="12" viewBox="0 0 50 50" fill="none" stroke="currentColor" stroke-width="2"><path d="M 25 2 C 12.309295 2 2 12.309295 2 25 C 2 37.690705 12.309295 48 25 48 C 37.690705 48 48 37.690705 48 25 C 48 12.309295 37.690705 2 25 2 z M 25 4 C 36.609824 4 46 13.390176 46 25 C 46 36.609824 36.609824 46 25 46 C 13.390176 46 4 36.609824 4 25 C 4 13.390176 13.390176 4 25 4 z M 25 11 A 3 3 0 0 0 22 14 A 3 3 0 0 0 25 17 A 3 3 0 0 0 28 14 A 3 3 0 0 0 25 11 z M 21 21 L 21 23 L 22 23 L 23 23 L 23 36 L 22 36 L 21 36 L 21 38 L 22 38 L 23 38 L 27 38 L 28 38 L 29 38 L 29 36 L 28 36 L 27 36 L 27 21 L 26 21 L 22 21 L 21 21 z"></path></svg>',
  
  DOWNLOAD: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
  
  ERROR_LARGE: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#e41e31" stroke-width="2" style="margin-bottom: 16px;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
  
  STAR: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>',
  
  X_CLOSE: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',

  CACHE: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3c4.97 0 9 3.582 9 8s-4.03 8-9 8-9-3.582-9-8 4.03-8 9-8m0-2C6.477 1 2 4.925 2 9.72c0 3.45 2.563 6.43 6 7.723V22h8v-4.558c3.437-1.294 6-4.273 6-7.723 0-4.795-4.477-8.72-10-8.72z"></path></svg>',
};

/**
 * Render an SVG icon with optional styling
 * @param {string} iconKey - Key from SVG_ICONS object
 * @param {string} color - Optional color variable (e.g., 'var(--success)', 'var(--danger)')
 * @returns {string} HTML string of the icon
 */
function renderIcon(iconKey, color = null) {
  let svg = SVG_ICONS[iconKey] || '';
  if (color && svg) {
    svg = svg.replace('stroke="currentColor"', `stroke="${color}"`);
  }
  return svg;
}

/**
 * UI Message Templates - Centralized message factory functions
 */

/**
 * Create a progress message with spinner and text
 * @param {number} current - Current item number
 * @param {number} total - Total items
 * @param {string} action - Action being performed (e.g., "Collecting data", "Downloading order")
 * @param {string} identifier - Item identifier (e.g., order number)
 * @param {string} spinnerColor - CSS color for spinner (default: var(--success))
 * @returns {string} HTML string
 */
function createProgressMessage(current, total, action, identifier, spinnerColor = 'var(--success)') {
  return `
    <span class="loading-spinner" style="border-color: ${spinnerColor}; border-top-color: transparent;"></span>
    ${action} ${current} of ${total} (#${identifier})...
  `;
}

/**
 * Create a success completion message
 * @param {string} message - Success message text
 * @returns {string} HTML string with success icon
 */
function createSuccessMessage(message) {
  return `
    ${renderIcon('SUCCESS_CHECKMARK', 'var(--success)')}
    ${message}
  `.replace('stroke="currentColor"', 'stroke="var(--success)"');
}

/**
 * Create an error completion message
 * @param {string} message - Error message text
 * @returns {string} HTML string with error icon
 */
function createErrorMessage(message) {
  return `
    ${renderIcon('ERROR_CIRCLE', 'var(--danger)')}
    ${message}
  `.replace('stroke="currentColor"', 'stroke="var(--danger)"');
}

/**
 * Constants for CSS classes, selectors, and text strings
 */
const CONSTANTS = {
  // CSS Classes
  CSS_CLASSES: {
    BTN_SUCCESS: 'btn btn-success',
    BTN_PRIMARY: 'btn btn-primary',
    BTN_DANGER: 'btn btn-danger',
    BTN_CLEAR: 'btn btn-clear',
    CHECKBOX_CONTAINER: 'checkbox-container',
    ORDER_LABEL: 'order-label',
    INFO_ICON: 'info-icon',
    ORDER_TOOLTIP: 'order-tooltip',
    LOADING_SPINNER: 'loading-spinner',
  },

  // DOM Selectors (content.js)
  SELECTORS: {
    PRINT_ITEMS: '.dn.print-items-list',
    PRINT_ITEM_NAME: '.w_U9_0.w_sD6D.w_QcqU',
    PRINT_BILL_TYPE: '.print-bill-type .w_U9_0.w_sD6D.w_QcqU',
    PRINT_BILL_QTY: '.print-bill-qty .w_U9_0.w_sD6D.w_QcqU',
    PRINT_BILL_PRICE: '.print-bill-price .w_U9_0.w_sD6D.w_QcqU',
    VISIBLE_ITEMS: '[data-testid="itemtile-stack"] [data-testid="productName"] span',
    ITEM_STACK: '[data-testid="itemtile-stack"]',
    PRODUCT_LINK: 'a[link-identifier="itemClick"]',
    ORDER_NUMBER_BAR: '.f-subheadline-m.dark-gray-m.print-bill-bar-id',
    ORDER_INFO_CARD: "[data-testid='orderInfoCard'] .dark-gray",
    ORDER_NUMBER_HEADING: '.print-bill-heading .dark-gray',
    PRINT_BILL_ID: '.print-bill-bar-id',
    ORDER_DATE: '.print-bill-date',
    ORDER_TOTAL: '.bill-order-total-payment h2:last-child',
    DELIVERY_CHARGES: '.print-fees',
    TAX_ELEMENTS: '.w_iUH7',
    TIP: '.print-bill-payment-section .flex.justify-between.pb2.pt3 .w_U9_0.w_U0S3.w_QcqU:last-child',
    ORDER_CARDS: '[data-testid^="order-"]',
    NEXT_BUTTON: 'button[data-automation-id="next-pages-button"]:not([disabled])',
    MAIN_HEADING: 'h1.w_kV33.w_LD4J.w_mvVb',
  },

  // Text Strings
  TEXT: {
    ORDER_PREFIX: 'Order #',
    SELECT_ALL: 'Select All',
    DOWNLOADING: 'Downloading order',
    COLLECTING: 'Collecting data',
    EXPORT_SUCCESS: 'Export completed successfully!',
    RETRY_PREFIX: 'Retrying order',
    DELIVERY_LABEL: 'Delivered',
    CART_ICON_TITLE: 'Walmart Invoice Exporter',
    SELECT_ORDERS: 'Select orders to download',
    CLEAR_CACHE_BTN: 'Clear Cache',
    USING_CACHE: 'Using cached data:',
    ORDERS: 'orders from',
    PAGES: 'pages',
  },

  // Chrome Messages
  MESSAGES: {
    START_COLLECTION: 'startCollection',
    STOP_COLLECTION: 'stopCollection',
    GET_PROGRESS: 'getProgress',
    CLEAR_CACHE: 'clearCache',
    COLLECT_ORDER_NUMBERS: 'collectOrderNumbers',
    CLICK_NEXT_BUTTON: 'clickNextButton',
    BLOCK_IMAGES: 'blockImagesForDownload',
    DOWNLOAD_XLSX: 'downloadXLSX',
    GET_ORDER_DATA: 'getOrderData',
  },

  // URL Parameters
  URLS: {
    WALMART_ORDERS: 'https://www.walmart.com/orders',
    WALMART_REVIEWS: 'https://chromewebstore.google.com/detail/walmart-invoice-exporter/bndkihecbbkoligeekekdgommmdllfpe/reviews',
  },

  // Timing Constants (in milliseconds)
  TIMING: {
    IMAGE_BLOCK_DELAY: 500,
    PAGE_LOAD_WAIT: 800,
    DOWNLOAD_TIMEOUT: 10000,      // Reduced from 30s for faster failure detection
    COLLECTION_TIMEOUT: 10000,    // Reduced from 30s for faster failure detection
    ELEMENT_POLL_INTERVAL: 200,   // Polling interval for waitForElement
    RETRY_DELAY: 400,
    RATING_DELAY: 500,
    HINT_DISMISS_DELAY: 5000,
    CACHE_EXPIRATION: 24 * 60 * 60 * 1000, // 24 hours
  },

  // Order Number Regex
  ORDER_NUMBER_REGEX: /#\s*([\d-]+)/,

  // Export Modes
  EXPORT_MODES: {
    SINGLE: 'single',
    MULTIPLE: 'multiple',
  },
};

/**
 * DOM Factory Functions - Reusable DOM element creation
 */

/**
 * Create a checkbox element with label and optional tooltip
 * @param {Object} config - Configuration object
 * @param {string} config.id - Checkbox ID
 * @param {string} config.value - Checkbox value
 * @param {string} config.label - Label text
 * @param {string} config.tooltip - Optional tooltip text
 * @param {string} config.className - Optional additional CSS class
 * @returns {HTMLElement} Div containing checkbox and label
 */
function createCheckboxElement(config) {
  const { id, value, label, tooltip = null, className = CONSTANTS.CSS_CLASSES.CHECKBOX_CONTAINER } = config;

  const div = document.createElement('div');
  div.className = className;

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = id;
  checkbox.value = value;

  const labelEl = document.createElement('label');
  labelEl.htmlFor = id;
  labelEl.className = CONSTANTS.CSS_CLASSES.ORDER_LABEL;

  const labelText = document.createElement('span');
  labelText.textContent = label;
  labelEl.appendChild(labelText);

  // Add tooltip if provided
  if (tooltip) {
    const infoIcon = document.createElement('span');
    infoIcon.className = CONSTANTS.CSS_CLASSES.INFO_ICON;
    infoIcon.innerHTML = renderIcon('INFO_CIRCLE');
    labelEl.appendChild(infoIcon);

    const tooltipEl = document.createElement('span');
    tooltipEl.className = CONSTANTS.CSS_CLASSES.ORDER_TOOLTIP;
    tooltipEl.textContent = tooltip;
    labelEl.appendChild(tooltipEl);
  }

  div.appendChild(checkbox);
  div.appendChild(labelEl);

  return div;
}

/**
 * Create a button element
 * @param {Object} config - Configuration object
 * @param {string} config.id - Button ID
 * @param {string} config.className - CSS classes
 * @param {string} config.innerHTML - Inner HTML content
 * @param {Function} config.onClick - Optional click handler
 * @returns {HTMLElement} Button element
 */
function createButtonElement(config) {
  const { id, className, innerHTML, onClick = null } = config;

  const button = document.createElement('button');
  if (id) button.id = id;
  button.className = className;
  button.innerHTML = innerHTML;

  if (onClick) {
    button.addEventListener('click', onClick);
  }

  return button;
}

/**
 * Create a div element with optional styling
 * @param {Object} config - Configuration object
 * @param {string} config.id - Div ID
 * @param {string} config.className - CSS classes
 * @param {string} config.innerHTML - Inner HTML content
 * @param {Object} config.style - Optional inline styles object
 * @returns {HTMLElement} Div element
 */
function createDivElement(config) {
  const { id = null, className = '', innerHTML = '', style = {} } = config;

  const div = document.createElement('div');
  if (id) div.id = id;
  if (className) div.className = className;
  if (innerHTML) div.innerHTML = innerHTML;

  Object.assign(div.style, style);

  return div;
}

/**
 * Checkbox & Selection Utilities - Repeated DOM query patterns
 */

/**
 * Get all selected order numbers from checkboxes
 * @returns {Array<string>} Array of selected order numbers
 */
function getSelectedOrderNumbers() {
  return Array.from(document.querySelectorAll('input[type="checkbox"]:checked'))
    .map((cb) => cb.value)
    .filter((value) => value !== 'on');
}

/**
 * Set disabled state for all order checkboxes
 * @param {boolean} disabled - True to disable, false to enable
 */
function setCheckboxesDisabled(disabled) {
  document.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.disabled = disabled;
  });
}

/**
 * Toggle all checkboxes in a container
 * @param {HTMLElement} container - Container with checkboxes
 * @param {boolean} checked - True to check all, false to uncheck
 */
function toggleAllCheckboxes(container, checked) {
  container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = checked;
  });
}

/**
 * Element Visibility & Display Utilities
 */

/**
 * Set display property for multiple elements
 * @param {Array<string|HTMLElement>} elements - Elements (IDs or DOM elements)
 * @param {string} display - Display value ('block', 'none', 'inline-flex', etc.)
 */
function setElementsDisplay(elements, display) {
  elements.forEach((el) => {
    let element = el;
    if (typeof el === 'string') {
      element = document.getElementById(el);
    }
    if (element) {
      element.style.display = display;
    }
  });
}

/**
 * Show elements
 * @param {Array<string|HTMLElement>} elements - Elements to show
 */
function showElements(elements) {
  setElementsDisplay(elements, 'block');
}

/**
 * Hide elements
 * @param {Array<string|HTMLElement>} elements - Elements to hide
 */
function hideElements(elements) {
  setElementsDisplay(elements, 'none');
}

/**
 * Promise & Async Utilities
 */

/**
 * Create a promise that resolves after a delay
 * @param {number} ms - Delay in milliseconds
 * @returns {Promise}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap a promise with a timeout
 * @param {Promise} promise - Promise to wrap
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} errorMessage - Error message if timeout occurs
 * @returns {Promise}
 */
function promiseWithTimeout(promise, timeoutMs, errorMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    ),
  ]);
}

/**
 * Text Processing Utilities
 */

/**
 * Truncate text to a maximum length
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length (default: 60)
 * @param {string} suffix - Suffix for truncated text (default: "...")
 * @returns {string} Truncated text
 */
function truncateText(text, maxLength = 60, suffix = '...') {
  if (!text || text.length <= maxLength) return text;
  return text.substring(0, maxLength) + suffix;
}

/**
 * Invoice Caching Utilities
 */

const INVOICE_CACHE_KEY = 'walmart_invoice_cache';
const INVOICE_CACHE_EXPIRATION = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get cached invoice data for an order
 * @param {string} orderNumber - The order number
 * @returns {Promise<Object|null>} Cached invoice data or null if not cached or expired
 */
function getCachedInvoice(orderNumber) {
  return new Promise((resolve) => {
    chrome.storage.local.get([INVOICE_CACHE_KEY], (result) => {
      if (!result[INVOICE_CACHE_KEY]) {
        resolve(null);
        return;
      }
      
      const cache = result[INVOICE_CACHE_KEY];
      const cached = cache[orderNumber];
      
      if (!cached) {
        resolve(null);
        return;
      }
      
      // Check if cache is expired
      if (Date.now() - cached.timestamp > INVOICE_CACHE_EXPIRATION) {
        // Remove expired cache
        deleteInvoiceCache(orderNumber);
        resolve(null);
        return;
      }
      
      resolve(cached.data);
    });
  });
}

/**
 * Save invoice data to cache
 * @param {string} orderNumber - The order number
 * @param {Object} invoiceData - The invoice data to cache
 * @returns {Promise<void>}
 */
function cacheInvoice(orderNumber, invoiceData) {
  return new Promise((resolve) => {
    chrome.storage.local.get([INVOICE_CACHE_KEY], (result) => {
      const cache = result[INVOICE_CACHE_KEY] || {};
      
      cache[orderNumber] = {
        data: invoiceData,
        timestamp: Date.now(),
      };
      
      chrome.storage.local.set({ [INVOICE_CACHE_KEY]: cache }, () => {
        console.log(`Cached invoice data for order ${orderNumber}`);
        resolve();
      });
    });
  });
}

/**
 * Delete cached invoice for a specific order
 * @param {string} orderNumber - The order number
 * @returns {Promise<void>}
 */
function deleteInvoiceCache(orderNumber) {
  return new Promise((resolve) => {
    chrome.storage.local.get([INVOICE_CACHE_KEY], (result) => {
      const cache = result[INVOICE_CACHE_KEY] || {};
      delete cache[orderNumber];
      
      if (Object.keys(cache).length === 0) {
        chrome.storage.local.remove(INVOICE_CACHE_KEY, resolve);
      } else {
        chrome.storage.local.set({ [INVOICE_CACHE_KEY]: cache }, () => {
          console.log(`Deleted cache for order ${orderNumber}`);
          resolve();
        });
      }
    });
  });
}

/**
 * Get all cached order numbers
 * @returns {Promise<Array>} Array of cached order numbers
 */
function getCachedOrderNumbers() {
  return new Promise((resolve) => {
    chrome.storage.local.get([INVOICE_CACHE_KEY], (result) => {
      if (!result[INVOICE_CACHE_KEY]) {
        resolve([]);
        return;
      }
      
      const orderNumbers = Object.keys(result[INVOICE_CACHE_KEY]);
      // Filter out expired ones
      const validOrders = [];
      for (const order of orderNumbers) {
        const cached = result[INVOICE_CACHE_KEY][order];
        if (Date.now() - cached.timestamp <= INVOICE_CACHE_EXPIRATION) {
          validOrders.push(order);
        }
      }
      resolve(validOrders);
    });
  });
}

/**
 * Clear all invoice cache
 * @returns {Promise<void>}
 */
function clearAllInvoiceCache() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(INVOICE_CACHE_KEY, () => {
      console.log('All invoice cache cleared');
      resolve();
    });
  });
}

