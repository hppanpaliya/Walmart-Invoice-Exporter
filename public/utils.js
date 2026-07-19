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
 * Format detailed payment method metadata into a readable string
 * @param {Object} orderDetails - Order details containing payment info
 * @returns {string}
 */
function formatPaymentMethodDetails(orderDetails) {
  const details = Array.isArray(orderDetails?.paymentMethodDetails)
    ? orderDetails.paymentMethodDetails
    : [];

  if (details.length === 0) {
    return orderDetails?.paymentMethods || '';
  }

  return details
    .map((entry) => {
      const primary = [entry.brand, entry.ending].filter(Boolean).join(' - ');
      const amount = entry.amount ? `Amount: ${entry.amount}` : '';
      return [primary, amount].filter(Boolean).join(' | ');
    })
    .filter(Boolean)
    .join(' || ');
}

/**
 * Format the order type for export columns.
 * In-store purchases show a friendly label; online orders keep the
 * payload's raw type (e.g. "GLASS") so no information is lost.
 * @param {string} orderType - Raw order type from the payload
 * @param {boolean} isInStore - Payload's in-store flag
 * @returns {string}
 */
function formatOrderType(orderType, isInStore) {
  return isInStore ? 'In-store' : String(orderType || '');
}

/**
 * Configure columns for a single order export worksheet
 * @param {ExcelJS.Worksheet} worksheet - The worksheet to configure
 */
function configureSingleOrderColumns(worksheet, options = {}) {
  const columns = [
    { header: "Product Name", key: "productName", width: 60 },
    { header: "Quantity", key: "quantity", width: 20, style: { numFmt: "#,##0", alignment: { horizontal: "center" } } },
    { header: "Price", key: "price", width: 20, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: "Delivery Status", key: "deliveryStatus", width: 30, style: { alignment: { horizontal: "center" } } },
    { header: "Product Link", key: "productLink", width: 60, style: { font: STYLES.linkFont } },
  ];
  if (options.includeThumbnails) {
    columns.push({ header: "Thumbnail", key: "thumbnail", width: 9, style: { alignment: { horizontal: "center" } } });
  }
  worksheet.columns = columns;
}

/**
 * Configure columns for the Quick Export order summary worksheet
 * @param {ExcelJS.Worksheet} worksheet - The worksheet to configure
 */
function configureOrderSummaryColumns(worksheet) {
  worksheet.columns = [
    { header: 'Order Number', key: 'orderNumber', width: 20, style: { alignment: { horizontal: "center" } } },
    { header: 'Order Date', key: 'orderDate', width: 22, style: { alignment: { horizontal: "center" } } },
    { header: 'Order Date (ISO)', key: 'orderDateIso', width: 28, style: { alignment: { horizontal: "center" } } },
    { header: 'Items', key: 'itemCount', width: 10, style: { numFmt: "#,##0", alignment: { horizontal: "center" } } },
    { header: 'Item Names', key: 'itemNames', width: 80 },
    { header: 'Status', key: 'status', width: 30, style: { alignment: { horizontal: "center" } } },
    { header: 'Fulfillment', key: 'fulfillment', width: 20, style: { alignment: { horizontal: "center" } } },
    { header: 'Subtotal', key: 'subTotal', width: 15, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: 'Driver Tip', key: 'driverTip', width: 12, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: 'Order Total', key: 'orderTotal', width: 15, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: 'Order Type', key: 'orderType', width: 14, style: { alignment: { horizontal: "center" } } },
  ];
}

/**
 * Convert Quick Export summary rows to a single XLSX file (one row per order)
 * Rows without summary data keep their cells blank instead of showing zeros.
 * @param {Array} summaryRows - Array of pre-built summary row objects
 * @param {Object} ExcelJS - The ExcelJS library
 * @param {string} filename - Optional custom filename
 */
async function convertOrderSummariesToXlsx(summaryRows, ExcelJS, filename = null, options = {}) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Orders');

  configureOrderSummaryColumns(worksheet);

  const rowsArray = Array.isArray(summaryRows) ? summaryRows : [];
  rowsArray.forEach((row) => {
    worksheet.addRow({
      orderNumber: row.orderNumber || '',
      orderDate: row.orderDate || '',
      orderDateIso: row.orderDateIso || '',
      itemCount: row.itemCount === '' || row.itemCount === null || row.itemCount === undefined ? '' : parseNumericValue(row.itemCount),
      itemNames: row.itemNames || '',
      status: row.status || '',
      fulfillment: row.fulfillment || '',
      subTotal: row.subTotal ? parseNumericValue(row.subTotal) : '',
      driverTip: row.driverTip ? parseNumericValue(row.driverTip) : '',
      orderTotal: row.orderTotal ? parseNumericValue(row.orderTotal) : '',
      orderType: row.orderType || '',
    });
  });

  // Apply styling (bold header row, matching the multi-order export)
  styleMultipleOrdersWorksheet(worksheet);

  // Second sheet: one row per item (prices join in from downloaded invoices).
  const itemRows = Array.isArray(options.itemRows) ? options.itemRows : [];
  if (itemRows.length > 0) {
    const itemsSheet = workbook.addWorksheet('Items');
    itemsSheet.columns = [
      { header: 'Order Number', key: 'orderNumber', width: 20, style: { alignment: { horizontal: "center" } } },
      { header: 'Order Date', key: 'orderDate', width: 16, style: { alignment: { horizontal: "center" } } },
      { header: 'Item', key: 'name', width: 60 },
      { header: 'Qty', key: 'quantity', width: 8, style: { numFmt: "#,##0", alignment: { horizontal: "center" } } },
      { header: 'Price', key: 'price', width: 12, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
      { header: 'Status', key: 'status', width: 18, style: { alignment: { horizontal: "center" } } },
    ];
    itemRows.forEach((row) => {
      itemsSheet.addRow({
        orderNumber: row.orderNumber || '',
        orderDate: row.orderDate || '',
        name: row.name || '',
        quantity: row.quantity === '' || row.quantity === null || row.quantity === undefined ? '' : parseNumericValue(row.quantity),
        price: row.price ? parseNumericValue(row.price) : '',
        status: row.status || '',
      });
    });
    styleMultipleOrdersWorksheet(itemsSheet);
  }

  // Download
  const downloadFilename = filename || 'Walmart_Orders_Summary.xlsx';
  await downloadWorkbook(workbook, downloadFilename);
}

/**
 * Build one row per item for the Quick Export items sheet.
 * Item names/quantities come from the list-payload summaries; per-item
 * prices are not in the list payload, so they join in from any stored
 * deep-export invoice (matched by normalized product name). Orders with an
 * invoice but no summary items use the invoice items directly.
 * @param {string[]} orderNumbers - Selected order numbers, in export order
 * @param {Object} orderSummaries - orderNumber → Quick Export summary
 * @param {Object} invoiceByOrder - orderNumber → stored invoice data
 * @param {Object} dateByOrder - orderNumber → display date for the rows
 * @returns {Object[]} rows {orderNumber, orderDate, name, quantity, price, status}
 */
function buildSummaryItemRows(orderNumbers, orderSummaries = {}, invoiceByOrder = {}, dateByOrder = {}) {
  const normalizeName = (name) => String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const rows = [];

  (orderNumbers || []).forEach((orderNumber) => {
    const summary = orderSummaries[orderNumber] || null;
    const invoice = invoiceByOrder[orderNumber] || null;
    const orderDate = dateByOrder[orderNumber] || summary?.orderDate || '';

    const priceByName = new Map();
    (invoice?.items || []).forEach((item) => {
      const key = normalizeName(item.productName);
      if (key && !priceByName.has(key)) {
        priceByName.set(key, item.price || '');
      }
    });

    const summaryItems = Array.isArray(summary?.items) ? summary.items : [];
    if (summaryItems.length > 0) {
      summaryItems.forEach((item) => {
        rows.push({
          orderNumber,
          orderDate,
          name: item.name || '',
          quantity: item.quantity ?? '',
          price: priceByName.get(normalizeName(item.name)) || '',
          status: summary?.status || '',
        });
      });
      return;
    }

    (invoice?.items || []).forEach((item) => {
      rows.push({
        orderNumber,
        orderDate,
        name: item.productName || '',
        quantity: item.quantity ?? '',
        price: item.price || '',
        status: item.deliveryStatus || '',
      });
    });
  });

  return rows;
}

/**
 * Add items from a single order to a worksheet
 * @param {ExcelJS.Worksheet} worksheet - The worksheet to add items to
 * @param {Array} items - The items to add
 */
function addItemsToWorksheet(worksheet, items) {
  items.forEach((item) => {
    const productName = item.productName || "";
    const productLink = item.productLink || "";
    const row = worksheet.addRow({
      productName,
      productLink: {
        text: truncateText(productName),
        hyperlink: productLink
      },
      quantity: excelNumber(item.quantity),
      price: excelNumber(item.price),
      deliveryStatus: item.deliveryStatus,
    });
    row.font = STYLES.productFont;
  });
}

/**
 * Apply styling to worksheet for single order export
 * @param {ExcelJS.Worksheet} worksheet - The worksheet to style
 */
function styleSingleOrderWorksheet(worksheet) {
  const currencyLabels = new Set([
    'Subtotal (Before Savings)',
    'Savings',
    'Subtotal',
    'Delivery Charges',
    'Bag Fee',
    'Tax',
    'Tip',
    'Refund',
    'Donations',
    'Order Total',
  ]);

  // Apply product font to all cells
  worksheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.font = STYLES.productFont;
    });
    const linkCell = row.getCell(5);
    if (linkCell && linkCell.value) {
      linkCell.font = STYLES.linkFont;
    }
  });

  // Apply header font to first row
  worksheet.getRow(1).eachCell((cell) => {
    cell.font = STYLES.headerFont;
  });

  // Keep only the monetary summary rows formatted as currency.
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 1) return;
    const label = row.getCell(1).value;
    if (currencyLabels.has(label)) {
      row.getCell(2).numFmt = "$#,##0.00";
      row.getCell(2).alignment = { horizontal: "center" };
    }
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

  const paymentMethodsDetailed = formatPaymentMethodDetails(orderDetails);

  // Add order details. Unknown values stay BLANK — never a fake $0.00.
  const rows = [
    ['Order Number', orderDetails.orderNumber],
    ['Order Date', orderDetails.orderDate],
    ['Data', orderDataLabel(orderDetails)],
    ['Address Recipient', orderDetails.addressRecipient],
    ['Shipping Address', orderDetails.address],
    ['Delivery Instructions', orderDetails.deliveryInstructions],
    ['Payment Method', paymentMethodsDetailed || orderDetails.paymentMethods],
    ['Payment Messages', orderDetails.paymentMessages],
    ['Subtotal (Before Savings)', excelNumber(orderDetails.subtotalBeforeSavings)],
    ['Savings', excelNumber(orderDetails.savings)],
    ['Subtotal', excelNumber(orderDetails.orderSubtotal)],
    ['Delivery Charges', excelNumber(orderDetails.deliveryCharges)],
    ['Bag Fee', excelNumber(orderDetails.bagFee)],
    ['Tax', excelNumber(orderDetails.tax)],
    ['Tip', excelNumber(orderDetails.tip)],
    ['Refund', excelNumber(orderDetails.refund)],
    ['Donations', excelNumber(orderDetails.donations)],
    ['Order Total', excelNumber(orderDetails.orderTotal)],
    ['Seller(s)', orderDetails.sellers || ''],
    ['Fulfillment', orderDetails.fulfillmentTypes || ''],
    ['Delivered Date', orderDetails.deliveredDate || ''],
    ['Tracking Numbers', orderDetails.trackingNumbers || ''],
    ['Payment Split', orderDetails.paymentSplit || ''],
    [
      'Receipt Barcode',
      orderDetails.barcodeImageUrl
        ? { text: 'Barcode', hyperlink: orderDetails.barcodeImageUrl }
        : '',
    ],
    ['Order Type', formatOrderType(orderDetails.orderType, orderDetails.isInStore)],
  ];

  // Rows with no value are omitted entirely — a quick (summary-only) report
  // simply has fewer lines than a full-invoice report, and the 'Data' row
  // says why. Real zeros (a genuine $0.00) are kept.
  const summaryRows = rows
    .filter(([, value]) => !(value === '' || value === null || value === undefined))
    .map(([label, value]) => {
      const row = worksheet.addRow([label, value]);
      row.font = { ...STYLES.productFont, bold: true };
      return row;
    });

  // Apply currency formatting only to money fields.
  const currencyLabels = new Set([
    'Subtotal (Before Savings)',
    'Savings',
    'Subtotal',
    'Delivery Charges',
    'Bag Fee',
    'Tax',
    'Tip',
    'Refund',
    'Donations',
    'Order Total',
  ]);
  summaryRows.forEach((row) => {
    const label = row.getCell(1).value;
    if (!currencyLabels.has(label)) return;
    row.getCell(2).numFmt = "$#,##0.00";
    row.getCell(2).font = { ...STYLES.productFont, bold: true };
    row.getCell(1).font = { ...STYLES.productFont, bold: true };
    row.getCell(2).alignment = { horizontal: "center" };
  });
}

/**
 * Embed product thumbnails into a worksheet's Thumbnail column.
 * The extension has no host permission for i5.walmartimages.com, so fetches
 * may be blocked — each failure falls back to a hyperlink cell instead.
 * Never throws: thumbnails are cosmetic and must not break an export.
 * @param {ExcelJS.Workbook} workbook - Workbook (owns the image store)
 * @param {ExcelJS.Worksheet} worksheet - Worksheet with a trailing Thumbnail column
 * @param {Array} items - Item objects (uses item.thumbnailUrl), one per data row
 * @param {number} columnIndex - 1-based index of the Thumbnail column
 * @param {number} firstDataRow - 1-based row number of the first item row
 */
async function embedItemThumbnails(workbook, worksheet, items, columnIndex, firstDataRow = 2) {
  // Prefetch every unique URL in parallel — serial round-trips would stall
  // large exports for tens of seconds. Failures simply stay out of the map.
  const uniqueUrls = [...new Set(items.map((item) => String(item?.thumbnailUrl || '')).filter(Boolean))];
  const bufferByUrl = new Map();
  await Promise.all(
    uniqueUrls.map(async (url) => {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        bufferByUrl.set(url, await response.arrayBuffer());
      } catch (error) {
        // Blocked (no host permission / CORS) or failed — hyperlink fallback below.
      }
    })
  );

  const imageIdByUrl = new Map();
  items.forEach((item, i) => {
    const url = String(item?.thumbnailUrl || '');
    if (!url) return;
    const rowNumber = firstDataRow + i;

    const buffer = bufferByUrl.get(url);
    if (buffer === undefined) {
      const cell = worksheet.getRow(rowNumber).getCell(columnIndex);
      cell.value = { text: 'Image', hyperlink: url };
      cell.font = STYLES.linkFont;
      return;
    }

    let imageId = imageIdByUrl.get(url);
    if (imageId === undefined) {
      const extension = /\.png(\?|$)/i.test(url) ? 'png' : 'jpeg';
      imageId = workbook.addImage({ buffer, extension });
      imageIdByUrl.set(url, imageId);
    }
    worksheet.addImage(imageId, {
      tl: { col: columnIndex - 1, row: rowNumber - 1 },
      ext: { width: 40, height: 40 },
      editAs: 'oneCell',
    });
    worksheet.getRow(rowNumber).height = 32;
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
  const { mode = 'single', filename = null, includeThumbnails = false } = options;

  if (mode === 'single') {
    // Single order export with full details
    return convertSingleOrderToXlsx(orderDetails, ExcelJS, filename, { includeThumbnails });
  } else if (mode === 'multiple') {
    // Multiple orders combined into one sheet
    return convertMultipleOrdersToXlsx(orderDetails, ExcelJS, filename, { includeThumbnails });
  }
}

/**
 * Convert a single order to XLSX format with full details including summary
 * @param {Object} orderDetails - The order details object
 * @param {Object} ExcelJS - The ExcelJS library
 * @param {string} filename - Optional custom filename
 */
async function convertSingleOrderToXlsx(orderDetails, ExcelJS, filename = null, options = {}) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Order Invoice");

  // Configure columns for single order
  configureSingleOrderColumns(worksheet, options);

  // Add items
  const items = orderDetails.items || [];
  addItemsToWorksheet(worksheet, items);

  // Add order summary
  addOrderSummary(worksheet, orderDetails);

  // Apply styling
  styleSingleOrderWorksheet(worksheet);
  polishWorksheet(worksheet, { filter: false });

  if (options.includeThumbnails) {
    await embedItemThumbnails(workbook, worksheet, items, worksheet.columns.length);
  }

  // Download
  const downloadFilename = filename || `Order_${orderDetails.orderNumber}.xlsx`;
  await downloadWorkbook(workbook, downloadFilename);
}

/**
 * Blank-preserving number conversion for spreadsheet cells: unknown values
 * stay EMPTY instead of rendering as a misleading $0.00 / 0.
 * @param {*} value - Raw value ("$7.96", 2, '', null)
 * @returns {number|string} number, or '' when the value is unknown
 */
function excelNumber(value) {
  if (value === '' || value === null || value === undefined) return '';
  return parseNumericValue(value);
}

/**
 * Human label describing how complete an exported order's data is.
 * Deep-downloaded invoices are complete; Quick Export rows built from the
 * order-list summary have not had their detail page scanned yet.
 * @param {Object} orderDetails
 * @returns {string}
 */
function orderDataLabel(orderDetails) {
  return orderDetails?.dataSource === 'summary'
    ? 'Summary only — not scanned yet (run Download Selected for prices, fees, payment)'
    : 'Full invoice';
}


/**
 * Polish a worksheet: Walmart-blue bold header, frozen header row, and
 * (optionally) an auto-filter across the header.
 * @param {ExcelJS.Worksheet} worksheet
 * @param {Object} options
 * @param {boolean} options.filter - Add an auto-filter over the columns
 */
function polishWorksheet(worksheet, { filter = true } = {}) {
  const header = worksheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0071DC' } };
    cell.alignment = { vertical: 'middle' };
  });
  header.height = 20;
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (filter && worksheet.columns.length > 0) {
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: worksheet.columns.length },
    };
  }
}

/**
 * Convert multiple orders into one workbook with two sheets:
 *  - "Orders": one row per order — financial columns sum correctly.
 *  - "Items":  one row per item — lean columns, no repeated order noise.
 * Unknown values stay blank (never a fake $0.00).
 * @param {Array} ordersData - Array of order data objects
 * @param {Object} ExcelJS - The ExcelJS library
 * @param {string} filename - Optional custom filename
 * @param {Object} options - { includeThumbnails }
 */
async function convertMultipleOrdersToXlsx(ordersData, ExcelJS, filename = null, options = {}) {
  const workbook = new ExcelJS.Workbook();
  const ordersArray = Array.isArray(ordersData) ? ordersData : [ordersData];

  // ----- Sheet 1: one row per order -----
  const ordersSheet = workbook.addWorksheet('Orders');
  ordersSheet.columns = [
    { header: 'Order Number', key: 'orderNumber', width: 20 },
    { header: 'Order Date', key: 'orderDate', width: 14 },
    { header: 'Order Type', key: 'orderType', width: 11, style: { alignment: { horizontal: 'center' } } },
    { header: 'Data', key: 'dataLabel', width: 26 },
    { header: 'Items', key: 'itemCount', width: 7, style: { numFmt: '#,##0', alignment: { horizontal: 'center' } } },
    { header: 'Subtotal (Before Savings)', key: 'subtotalBeforeSavings', width: 13, style: { numFmt: '$#,##0.00' } },
    { header: 'Savings', key: 'savings', width: 10, style: { numFmt: '$#,##0.00' } },
    { header: 'Subtotal', key: 'orderSubtotal', width: 11, style: { numFmt: '$#,##0.00' } },
    { header: 'Delivery Charges', key: 'deliveryCharges', width: 10, style: { numFmt: '$#,##0.00' } },
    { header: 'Bag Fee', key: 'bagFee', width: 9, style: { numFmt: '$#,##0.00' } },
    { header: 'Tax', key: 'tax', width: 9, style: { numFmt: '$#,##0.00' } },
    { header: 'Tip', key: 'tip', width: 9, style: { numFmt: '$#,##0.00' } },
    { header: 'Refund', key: 'refund', width: 10, style: { numFmt: '$#,##0.00' } },
    { header: 'Donations', key: 'donations', width: 10, style: { numFmt: '$#,##0.00' } },
    { header: 'Order Total', key: 'orderTotal', width: 12, style: { numFmt: '$#,##0.00' } },
    { header: 'Payment Method', key: 'paymentMethods', width: 32 },
    { header: 'Payment Split', key: 'paymentSplit', width: 32 },
    { header: 'Payment Messages', key: 'paymentMessages', width: 32 },
    { header: 'Seller(s)', key: 'sellers', width: 24 },
    { header: 'Fulfillment', key: 'fulfillmentTypes', width: 14 },
    { header: 'Delivered Date', key: 'deliveredDate', width: 14 },
    { header: 'Tracking Numbers', key: 'trackingNumbers', width: 24 },
    { header: 'Ship To', key: 'address', width: 36 },
    { header: 'Delivery Instructions', key: 'deliveryInstructions', width: 24 },
    { header: 'Receipt Barcode', key: 'barcodeLink', width: 14 },
  ];

  ordersArray.forEach((orderDetails) => {
    ordersSheet.addRow({
      orderNumber: orderDetails.orderNumber || '',
      orderDate: orderDetails.orderDate || '',
      orderType: formatOrderType(orderDetails.orderType, orderDetails.isInStore),
      dataLabel: orderDataLabel(orderDetails),
      itemCount: Array.isArray(orderDetails.items) ? orderDetails.items.length : '',
      subtotalBeforeSavings: excelNumber(orderDetails.subtotalBeforeSavings),
      savings: excelNumber(orderDetails.savings),
      orderSubtotal: excelNumber(orderDetails.orderSubtotal),
      deliveryCharges: excelNumber(orderDetails.deliveryCharges),
      bagFee: excelNumber(orderDetails.bagFee),
      tax: excelNumber(orderDetails.tax),
      tip: excelNumber(orderDetails.tip),
      refund: excelNumber(orderDetails.refund),
      donations: excelNumber(orderDetails.donations),
      orderTotal: excelNumber(orderDetails.orderTotal),
      paymentMethods: formatPaymentMethodDetails(orderDetails) || orderDetails.paymentMethods || '',
      paymentSplit: orderDetails.paymentSplit || '',
      paymentMessages: orderDetails.paymentMessages || '',
      sellers: orderDetails.sellers || '',
      fulfillmentTypes: orderDetails.fulfillmentTypes || '',
      deliveredDate: orderDetails.deliveredDate || '',
      trackingNumbers: orderDetails.trackingNumbers || '',
      address: [orderDetails.addressRecipient, orderDetails.addressLine || orderDetails.address]
        .filter(Boolean)
        .join(', ') || orderDetails.address || '',
      deliveryInstructions: orderDetails.deliveryInstructions || '',
      barcodeLink: orderDetails.barcodeImageUrl
        ? { text: 'Barcode', hyperlink: orderDetails.barcodeImageUrl }
        : '',
    });
  });
  polishWorksheet(ordersSheet);

  // ----- Sheet 2: one row per item -----
  const itemsSheet = workbook.addWorksheet('Items');
  const itemColumns = [
    { header: 'Order Number', key: 'orderNumber', width: 20 },
    { header: 'Order Date', key: 'orderDate', width: 14 },
    { header: 'Product Name', key: 'productName', width: 64 },
    { header: 'Qty', key: 'quantity', width: 7, style: { numFmt: '#,##0', alignment: { horizontal: 'center' } } },
    { header: 'Price', key: 'price', width: 11, style: { numFmt: '$#,##0.00' } },
    { header: 'Status', key: 'deliveryStatus', width: 16 },
    { header: 'Order Type', key: 'orderType', width: 11, style: { alignment: { horizontal: 'center' } } },
    { header: 'Product Link', key: 'productLink', width: 46, style: { font: STYLES.linkFont } },
  ];
  if (options.includeThumbnails) {
    itemColumns.push({ header: 'Thumbnail', key: 'thumbnail', width: 9, style: { alignment: { horizontal: 'center' } } });
  }
  itemsSheet.columns = itemColumns;

  const allItems = [];
  ordersArray.forEach((orderDetails) => {
    (orderDetails.items || []).forEach((item) => {
      allItems.push({ orderDetails, item });
      const productName = item.productName || '';
      const productLink = item.productLink || '';
      itemsSheet.addRow({
        orderNumber: orderDetails.orderNumber || '',
        orderDate: orderDetails.orderDate || '',
        productName,
        quantity: excelNumber(item.quantity),
        price: excelNumber(item.price),
        deliveryStatus: item.deliveryStatus || '',
        orderType: formatOrderType(orderDetails.orderType, orderDetails.isInStore),
        productLink: productLink && productLink !== 'N/A'
          ? { text: truncateText(productName), hyperlink: productLink }
          : '',
      });
    });
  });
  polishWorksheet(itemsSheet);

  if (options.includeThumbnails) {
    await embedItemThumbnails(
      workbook,
      itemsSheet,
      allItems.map(({ item }) => item),
      itemsSheet.columns.length
    );
  }

  // Download
  const downloadFilename = filename || 'Walmart_Orders.xlsx';
  await downloadWorkbook(workbook, downloadFilename);
}

/**
 * ---------------------------------------------------------------------
 * Legacy Excel export (pre-6.18 single-sheet layout, opt-in)
 * ---------------------------------------------------------------------
 * Recovered verbatim from the workbook shipped before release 6.18, when
 * a combined export was one wide 'Walmart Orders' sheet: item rows carry
 * the parent order's fields repeated on every row (so summing a
 * financial column double-counts), and a missing number renders as 0
 * rather than blank. That is a real limitation next to the current
 * Orders+Items writer above, but some users have spreadsheets/macros
 * built against this exact old shape, so it stays available behind an
 * explicit opt-in ("Use legacy Excel layout" — design spec §5.3).
 *
 * ADDITIVE ONLY: nothing above this block is modified, and the side
 * panel does not call any of the functions below yet — that wiring
 * lands in a later phase. The current (non-legacy) writers remain the
 * default for every export.
 */

/**
 * Configure columns for the legacy combined multiple-orders worksheet
 * (pre-6.18 shape: one row per item, order fields repeated per row).
 * @param {ExcelJS.Worksheet} worksheet - The worksheet to configure
 */
function configureMultipleOrdersColumnsLegacy(worksheet, options = {}) {
  const columns = [
    { header: 'Order Number', key: 'orderNumber', width: 20, style: { alignment: { horizontal: "center" } } },
    { header: 'Order Date', key: 'orderDate', width: 20, style: { alignment: { horizontal: "center" } } },
    { header: 'Address Recipient', key: 'addressRecipient', width: 24, style: { alignment: { horizontal: "center" } } },
    { header: 'Shipping Address', key: 'address', width: 45, style: { alignment: { horizontal: "center" } } },
    { header: 'Delivery Instructions', key: 'deliveryInstructions', width: 36, style: { alignment: { horizontal: "center" } } },
    { header: 'Payment Method', key: 'paymentMethods', width: 42, style: { alignment: { horizontal: "center" } } },
    { header: 'Payment Messages', key: 'paymentMessages', width: 52, style: { alignment: { horizontal: "center" } } },
    { header: 'Subtotal (Before Savings)', key: 'subtotalBeforeSavings', width: 22, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: 'Savings', key: 'savings', width: 14, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: 'Subtotal', key: 'orderSubtotal', width: 15, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: 'Product Name', key: 'productName', width: 60, style: { alignment: { horizontal: "center" } } },
    { header: 'Quantity', key: 'quantity', width: 10, style: { numFmt: "#,##0", alignment: { horizontal: "center" } } },
    { header: 'Price', key: 'price', width: 10, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: 'Delivery Charges', key: 'deliveryCharges', width: 20, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: 'Bag Fee', key: 'bagFee', width: 12, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: 'Tax', key: 'tax', width: 10, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: 'Tip', key: 'tip', width: 10, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: 'Order Total', key: 'orderTotal', width: 15, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: 'Delivery Status', key: 'deliveryStatus', width: 20, style: { alignment: { horizontal: "center" } } },
    { header: 'Product Link', key: 'productLink', width: 60 , style: { font: STYLES.linkFont } },
    { header: 'Seller(s)', key: 'sellers', width: 26, style: { alignment: { horizontal: "center" } } },
    { header: 'Fulfillment', key: 'fulfillmentTypes', width: 16, style: { alignment: { horizontal: "center" } } },
    { header: 'Delivered Date', key: 'deliveredDate', width: 18, style: { alignment: { horizontal: "center" } } },
    { header: 'Tracking Numbers', key: 'trackingNumbers', width: 28, style: { alignment: { horizontal: "center" } } },
    { header: 'Payment Split', key: 'paymentSplit', width: 40, style: { alignment: { horizontal: "center" } } },
    { header: 'Refund', key: 'refund', width: 12, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: 'Donations', key: 'donations', width: 12, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: 'Receipt Barcode', key: 'barcodeLink', width: 16, style: { alignment: { horizontal: "center" } } },
    { header: 'Order Type', key: 'orderType', width: 14, style: { alignment: { horizontal: "center" } } },
  ];
  if (options.includeThumbnails) {
    columns.push({ header: 'Thumbnail', key: 'thumbnail', width: 9, style: { alignment: { horizontal: "center" } } });
  }
  worksheet.columns = columns;
}

/**
 * Add items from multiple orders to the legacy combined worksheet (one row
 * per item; order-level fields repeated on every row of that order).
 * @param {ExcelJS.Worksheet} worksheet - The worksheet to add items to
 * @param {Array} items - Flattened item+order records (see convertMultipleOrdersToXlsxLegacy)
 */
function addMultipleOrderItemsToWorksheetLegacy(worksheet, items) {
  items.forEach((item) => {
    const productName = item.productName || "";
    const productLink = item.productLink || "";
    worksheet.addRow({
      orderNumber: item.orderNumber || '',
      orderDate: item.orderDate || '',
      addressRecipient: item.addressRecipient || '',
      address: item.address || '',
      deliveryInstructions: item.deliveryInstructions || '',
      paymentMethods: item.paymentMethods || '',
      paymentMessages: item.paymentMessages || '',
      subtotalBeforeSavings: parseNumericValue(item.subtotalBeforeSavings),
      savings: parseNumericValue(item.savings),
      orderSubtotal: parseNumericValue(item.orderSubtotal),
      productName,
      quantity: parseNumericValue(item.quantity),
      price: parseNumericValue(item.price),
      deliveryStatus: item.deliveryStatus || '',
      productLink: {
        text: truncateText(productName),
        hyperlink: productLink
      },
      deliveryCharges: parseNumericValue(item.deliveryCharges),
      bagFee: parseNumericValue(item.bagFee),
      tax: parseNumericValue(item.tax),
      tip: parseNumericValue(item.tip),
      orderTotal: parseNumericValue(item.orderTotal),
      sellers: item.sellers || '',
      fulfillmentTypes: item.fulfillmentTypes || '',
      deliveredDate: item.deliveredDate || '',
      trackingNumbers: item.trackingNumbers || '',
      paymentSplit: item.paymentSplit || '',
      // Blank (not $0.00) when the order had no refund or donation.
      refund: item.refund ? parseNumericValue(item.refund) : '',
      donations: item.donations ? parseNumericValue(item.donations) : '',
      barcodeLink: item.barcodeImageUrl
        ? { text: 'Barcode', hyperlink: item.barcodeImageUrl }
        : '',
      orderType: formatOrderType(item.orderType, item.isInStore),
    });
  });
}

/**
 * Convert a single order to the legacy XLSX layout. A single order was
 * never split into an Orders+Items pair, so this reuses the exact same
 * "Order Invoice" sheet, columns, item rows, and summary block as the
 * current single-order writer below — the only difference is it skips
 * the frozen/colored header polish that release 6.18 added.
 * @param {Object} orderDetails - The order details object
 * @param {Object} ExcelJS - The ExcelJS library
 * @param {string} filename - Optional custom filename
 */
async function convertSingleOrderToXlsxLegacy(orderDetails, ExcelJS, filename = null, options = {}) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Order Invoice");

  configureSingleOrderColumns(worksheet, options);

  const items = orderDetails.items || [];
  addItemsToWorksheet(worksheet, items);
  addOrderSummary(worksheet, orderDetails);
  styleSingleOrderWorksheet(worksheet);

  if (options.includeThumbnails) {
    await embedItemThumbnails(workbook, worksheet, items, worksheet.columns.length);
  }

  // Download
  const downloadFilename = filename || `Order_${orderDetails.orderNumber}.xlsx`;
  await downloadWorkbook(workbook, downloadFilename);
}

/**
 * Convert multiple orders into the legacy single-sheet 'Walmart Orders'
 * workbook (pre-6.18): one row per item, with order-level fields (address,
 * payment, fees, totals...) repeated on every item row of that order.
 * Restored verbatim for the opt-in "legacy Excel layout" toggle; the
 * default combined export is convertMultipleOrdersToXlsx above, which
 * this function does not touch.
 * @param {Array} ordersData - Array of order data objects
 * @param {Object} ExcelJS - The ExcelJS library
 * @param {string} filename - Optional custom filename
 */
async function convertMultipleOrdersToXlsxLegacy(ordersData, ExcelJS, filename = null, options = {}) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Walmart Orders');

  // Configure columns for multiple orders
  configureMultipleOrdersColumnsLegacy(worksheet, options);

  // Flatten all items from all orders into a single list with order info
  const allItems = [];
  const ordersArray = Array.isArray(ordersData) ? ordersData : [ordersData];

  ordersArray.forEach((orderDetails) => {
    const paymentMethodsDetailed = formatPaymentMethodDetails(orderDetails);

    (orderDetails.items || []).forEach((item) => {
      allItems.push({
        orderNumber: orderDetails.orderNumber || '',
        orderDate: orderDetails.orderDate || '',
        addressRecipient: orderDetails.addressRecipient || '',
        address: orderDetails.address || '',
        deliveryInstructions: orderDetails.deliveryInstructions || '',
        paymentMethods: paymentMethodsDetailed || orderDetails.paymentMethods || '',
        paymentMessages: orderDetails.paymentMessages || '',
        subtotalBeforeSavings: orderDetails.subtotalBeforeSavings || '',
        savings: orderDetails.savings || '',
        orderSubtotal: orderDetails.orderSubtotal || '',
        orderTotal: orderDetails.orderTotal || '',
        productName: item.productName || '',
        quantity: item.quantity,
        price: item.price,
        deliveryStatus: item.deliveryStatus || '',
        productLink: item.productLink || '',
        thumbnailUrl: item.thumbnailUrl || '',
        deliveryCharges: orderDetails.deliveryCharges || '',
        bagFee: orderDetails.bagFee || '',
        tax: orderDetails.tax || '',
        tip: orderDetails.tip || '',
        refund: orderDetails.refund || '',
        donations: orderDetails.donations || '',
        barcodeImageUrl: orderDetails.barcodeImageUrl || '',
        sellers: orderDetails.sellers || '',
        fulfillmentTypes: orderDetails.fulfillmentTypes || '',
        deliveredDate: orderDetails.deliveredDate || '',
        trackingNumbers: orderDetails.trackingNumbers || '',
        paymentSplit: orderDetails.paymentSplit || '',
        orderType: orderDetails.orderType || '',
        isInStore: Boolean(orderDetails.isInStore),
      });
    });
  });

  // Add all items to worksheet
  addMultipleOrderItemsToWorksheetLegacy(worksheet, allItems);

  // Apply styling
  styleMultipleOrdersWorksheet(worksheet);

  if (options.includeThumbnails) {
    await embedItemThumbnails(workbook, worksheet, allItems, worksheet.columns.length);
  }

  // Download
  const downloadFilename = filename || 'Walmart_Orders.xlsx';
  await downloadWorkbook(workbook, downloadFilename);
}

/**
 * Convert order data to the legacy XLSX layout and download — dispatcher
 * mirroring convertToXlsx (mode 'single' | 'multiple'). Not wired into the
 * side panel yet; the "Use legacy Excel layout" toggle that routes here
 * lands in a later phase (design spec §5.3).
 * @param {Object} orderDetails - The order data (for single) or array of orders (for multiple)
 * @param {Object} ExcelJS - The ExcelJS library
 * @param {Object} options - Configuration options
 * @param {string} options.mode - Export mode: 'single' or 'multiple'
 * @param {string} options.filename - Optional custom filename
 */
async function convertToXlsxLegacy(orderDetails, ExcelJS, options = {}) {
  const { mode = 'single', filename = null, includeThumbnails = false } = options;

  if (mode === 'single') {
    return convertSingleOrderToXlsxLegacy(orderDetails, ExcelJS, filename, { includeThumbnails });
  } else if (mode === 'multiple') {
    return convertMultipleOrdersToXlsxLegacy(orderDetails, ExcelJS, filename, { includeThumbnails });
  }
}

/**
 * CSV / JSON export
 */

/**
 * Escape a single CSV field per RFC 4180: fields containing commas, quotes,
 * or line breaks are wrapped in double quotes with inner quotes doubled.
 * String fields starting with formula characters are prefixed with a quote
 * so spreadsheet apps don't execute them (CSV formula injection — product
 * names are third-party-seller controlled). Numbers pass through untouched.
 * @param {*} value - The field value
 * @returns {string}
 */
function csvEscape(value) {
  if (typeof value === 'number') {
    return String(value);
  }
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Build RFC-4180 CSV content (CRLF line endings, trailing newline).
 * Prefixed with a UTF-8 BOM so Excel decodes non-ASCII product names
 * (e.g. "2× Milk") correctly when the file is double-clicked open.
 * @param {Array<string>} header - Column headers
 * @param {Array<Array>} rows - Data rows
 * @returns {string}
 */
function buildCsvContent(header, rows) {
  return '\uFEFF' + [header, ...rows]
    .map((row) => row.map(csvEscape).join(','))
    .join('\r\n') + '\r\n';
}

/**
 * Trigger download of a text file (CSV, JSON)
 * @param {string} content - File content
 * @param {string} filename - Download filename
 * @param {string} mimeType - MIME type
 */
function downloadTextFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.URL.revokeObjectURL(url);
}

/** Money helper for CSV: numeric value, or blank when the field is empty. */
function csvMoney(value, { blankWhenEmpty = false } = {}) {
  if (blankWhenEmpty && !value) return '';
  return parseNumericValue(value);
}

/**
 * Order-level CSV columns (one row per order) — accounting-friendly:
 * money fields are plain numbers, not "$1.23" strings.
 */
const ORDER_CSV_COLUMNS = [
  ['Order Number', (o) => o.orderNumber || ''],
  ['Order Date', (o) => o.orderDate || ''],
  ['Items', (o) => (Array.isArray(o.items) ? o.items.length : '')],
  ['Address Recipient', (o) => o.addressRecipient || ''],
  ['Shipping Address', (o) => o.address || ''],
  ['Delivery Instructions', (o) => o.deliveryInstructions || ''],
  ['Payment Method', (o) => formatPaymentMethodDetails(o)],
  ['Payment Messages', (o) => o.paymentMessages || ''],
  ['Payment Split', (o) => o.paymentSplit || ''],
  ['Subtotal (Before Savings)', (o) => csvMoney(o.subtotalBeforeSavings)],
  ['Savings', (o) => csvMoney(o.savings)],
  ['Subtotal', (o) => csvMoney(o.orderSubtotal)],
  ['Delivery Charges', (o) => csvMoney(o.deliveryCharges)],
  ['Bag Fee', (o) => csvMoney(o.bagFee)],
  ['Tax', (o) => csvMoney(o.tax)],
  ['Tip', (o) => csvMoney(o.tip)],
  ['Refund', (o) => csvMoney(o.refund, { blankWhenEmpty: true })],
  ['Donations', (o) => csvMoney(o.donations, { blankWhenEmpty: true })],
  ['Order Total', (o) => csvMoney(o.orderTotal)],
  ['Seller(s)', (o) => o.sellers || ''],
  ['Fulfillment', (o) => o.fulfillmentTypes || ''],
  ['Delivered Date', (o) => o.deliveredDate || ''],
  ['Tracking Numbers', (o) => o.trackingNumbers || ''],
  ['Receipt Barcode URL', (o) => o.barcodeImageUrl || ''],
  ['Order Type', (o) => formatOrderType(o.orderType, o.isInStore)],
];

/** Item-level CSV columns (one row per item) — the "items sheet" equivalent. */
const ITEM_CSV_COLUMNS = [
  ['Order Number', (o) => o.orderNumber || ''],
  ['Order Date', (o) => o.orderDate || ''],
  ['Product Name', (o, item) => item.productName || ''],
  ['Quantity', (o, item) => parseNumericValue(item.quantity)],
  ['Price', (o, item) => parseNumericValue(item.price)],
  ['Delivery Status', (o, item) => item.deliveryStatus || ''],
  ['Product Link', (o, item) => item.productLink || ''],
];

/**
 * Export orders as accounting-friendly CSV: one file with a row per order,
 * plus a companion items file with a row per item (CSV has no sheets).
 * @param {Array|Object} ordersData - Order data object(s)
 * @param {Object} options
 * @param {string} options.ordersFilename - Filename for the per-order file
 * @param {string} options.itemsFilename - Filename for the per-item file
 */
async function convertOrdersToCsv(ordersData, options = {}) {
  const {
    ordersFilename = 'Walmart_Orders.csv',
    itemsFilename = 'Walmart_Order_Items.csv',
  } = options;
  const ordersArray = Array.isArray(ordersData) ? ordersData : [ordersData];

  const orderRows = ordersArray.map((order) =>
    ORDER_CSV_COLUMNS.map(([, getter]) => getter(order))
  );
  downloadTextFile(
    buildCsvContent(ORDER_CSV_COLUMNS.map(([header]) => header), orderRows),
    ordersFilename,
    'text/csv'
  );

  // Space out the second download so Chrome's multiple-download throttle
  // surfaces its permission prompt instead of silently dropping the file.
  await delay(CONSTANTS.TIMING.RETRY_DELAY);

  const itemRows = [];
  ordersArray.forEach((order) => {
    (order.items || []).forEach((item) => {
      itemRows.push(ITEM_CSV_COLUMNS.map(([, getter]) => getter(order, item)));
    });
  });
  downloadTextFile(
    buildCsvContent(ITEM_CSV_COLUMNS.map(([header]) => header), itemRows),
    itemsFilename,
    'text/csv'
  );
}

/**
 * Format an order date as MM/DD/YYYY for accounting imports.
 * Accepts ISO 8601 strings (with or without a time part) and the short
 * "Jul 01, 2026" form the detail extraction produces. A leading
 * YYYY-MM-DD is used as-is so timezone offsets never shift the calendar
 * date; anything unparseable falls back to the raw string.
 * @param {string} value - Date string from the order data
 * @returns {string}
 */
function formatAccountingDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const parsed = isoMatch
    ? new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]))
    : new Date(text);
  if (isNaN(parsed.getTime())) return text;
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${month}/${day}/${parsed.getFullYear()}`;
}

/**
 * Summarize an order's items for the Xero description field: the first
 * few product names, truncated to ~120 characters. Falls back to the
 * order title, then to the order number.
 * @param {Object} order - Order data object
 * @returns {string}
 */
function buildAccountingDescription(order) {
  const names = (Array.isArray(order?.items) ? order.items : [])
    .map((item) => String(item?.productName || '').trim())
    .filter(Boolean);
  let description = names.slice(0, 3).join('; ');
  if (names.length > 3) {
    description += `; +${names.length - 3} more`;
  }
  if (!description) {
    description = String(order?.title || '').trim() || `Walmart order #${order?.orderNumber || ''}`;
  }
  if (description.length > 120) {
    description = `${description.slice(0, 117)}...`;
  }
  return description;
}

/**
 * Build header + rows for an accounting CSV preset. Amounts are the
 * NEGATIVE order total (money spent), matching bank-statement imports.
 * @param {Array|Object} ordersData - Order data object(s)
 * @param {string} preset - A CONSTANTS.CSV_PRESETS value
 * @returns {{header: string[], rows: Array[]}}
 */
function buildAccountingCsvRows(ordersData, preset) {
  const ordersArray = Array.isArray(ordersData) ? ordersData : [ordersData];
  // Orders with an UNKNOWN total (summary-built, never scanned) are skipped
  // outright — a fabricated $0.00 transaction corrupts a bank import.
  const withTotals = ordersArray.filter((order) => String(order.orderTotal || '').trim() !== '');
  const spentAmount = (order) => -Math.abs(parseNumericValue(order.orderTotal));

  if (preset === CONSTANTS.CSV_PRESETS.XERO) {
    return {
      header: ['Date', 'Amount', 'Payee', 'Description', 'Reference'],
      skipped: ordersArray.length - withTotals.length,
      rows: withTotals.map((order) => [
        formatAccountingDate(order.orderDate),
        spentAmount(order),
        'Walmart',
        buildAccountingDescription(order),
        order.orderNumber || '',
      ]),
    };
  }

  // QuickBooks 3-column bank format (Date, Description, Amount).
  return {
    header: ['Date', 'Description', 'Amount'],
    skipped: ordersArray.length - withTotals.length,
    rows: withTotals.map((order) => {
      const itemCount = Array.isArray(order.items) ? order.items.length : 0;
      return [
        formatAccountingDate(order.orderDate),
        `Walmart order #${order.orderNumber || ''} (${itemCount} items)`,
        spentAmount(order),
      ];
    }),
  };
}

/**
 * Export orders as a single accounting-preset CSV (QuickBooks or Xero).
 * Goes through buildCsvContent so the UTF-8 BOM and RFC-4180 escaping
 * (incl. formula-injection neutralization) apply.
 * @param {Array|Object} ordersData - Order data object(s)
 * @param {string} preset - A CONSTANTS.CSV_PRESETS value
 * @param {string} filename - Optional download filename
 */
function convertOrdersToAccountingCsv(ordersData, preset, filename = null) {
  const { header, rows } = buildAccountingCsvRows(ordersData, preset);
  const defaultFilename = preset === CONSTANTS.CSV_PRESETS.XERO
    ? 'Walmart_Orders_Xero.csv'
    : 'Walmart_Orders_QuickBooks.csv';
  downloadTextFile(buildCsvContent(header, rows), filename || defaultFilename, 'text/csv');
}

/**
 * Export orders as pretty-printed JSON (full structured data, items nested).
 * @param {Array|Object} ordersData - Order data object(s)
 * @param {string} filename - Download filename
 */
function convertOrdersToJson(ordersData, filename = 'Walmart_Orders.json') {
  const ordersArray = Array.isArray(ordersData) ? ordersData : [ordersData];
  downloadTextFile(JSON.stringify(ordersArray, null, 2), filename, 'application/json');
}

/** Quick Export summary columns shared by the CSV and JSON writers. */
const SUMMARY_CSV_COLUMNS = [
  ['Order Number', (row) => row.orderNumber || ''],
  ['Order Date', (row) => row.orderDate || ''],
  ['Order Date (ISO)', (row) => row.orderDateIso || ''],
  ['Items', (row) => (row.itemCount === '' || row.itemCount === null || row.itemCount === undefined ? '' : parseNumericValue(row.itemCount))],
  ['Item Names', (row) => row.itemNames || ''],
  ['Status', (row) => row.status || ''],
  ['Fulfillment', (row) => row.fulfillment || ''],
  ['Subtotal', (row) => csvMoney(row.subTotal, { blankWhenEmpty: true })],
  ['Driver Tip', (row) => csvMoney(row.driverTip, { blankWhenEmpty: true })],
  ['Order Total', (row) => csvMoney(row.orderTotal, { blankWhenEmpty: true })],
  ['Order Type', (row) => row.orderType || ''],
];

/**
 * Export Quick Export summary rows as CSV (one row per order).
 * @param {Array} summaryRows - Pre-built summary row objects
 * @param {string} filename - Download filename
 */
function convertOrderSummariesToCsv(summaryRows, filename = 'Walmart_Orders_Summary.csv') {
  const rowsArray = Array.isArray(summaryRows) ? summaryRows : [];
  const rows = rowsArray.map((row) => SUMMARY_CSV_COLUMNS.map(([, getter]) => getter(row)));
  downloadTextFile(
    buildCsvContent(SUMMARY_CSV_COLUMNS.map(([header]) => header), rows),
    filename,
    'text/csv'
  );
}

/** Quick Export per-item columns for the companion items CSV. */
const SUMMARY_ITEM_CSV_COLUMNS = [
  ['Order Number', (row) => row.orderNumber || ''],
  ['Order Date', (row) => row.orderDate || ''],
  ['Item', (row) => row.name || ''],
  ['Qty', (row) => (row.quantity === '' || row.quantity === null || row.quantity === undefined ? '' : parseNumericValue(row.quantity))],
  ['Price', (row) => csvMoney(row.price, { blankWhenEmpty: true })],
  ['Status', (row) => row.status || ''],
];

/**
 * Export Quick Export item rows as the companion CSV (one row per item).
 * @param {Array} itemRows - Rows from buildSummaryItemRows
 * @param {string} filename - Download filename
 */
function convertOrderSummaryItemsToCsv(itemRows, filename = 'Walmart_Orders_Summary_Items.csv') {
  const rowsArray = Array.isArray(itemRows) ? itemRows : [];
  const rows = rowsArray.map((row) => SUMMARY_ITEM_CSV_COLUMNS.map(([, getter]) => getter(row)));
  downloadTextFile(
    buildCsvContent(SUMMARY_ITEM_CSV_COLUMNS.map(([header]) => header), rows),
    filename,
    'text/csv'
  );
}

/**
 * Printable HTML receipt export (user prints to PDF from the browser)
 */

const RECEIPT_STYLES = `
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 24px; }
  .receipt { max-width: 640px; margin: 0 auto 32px; padding: 24px; border: 1px solid #ddd; border-radius: 8px; page-break-after: always; }
  .receipt:last-of-type { page-break-after: auto; }
  .receipt header { text-align: center; border-bottom: 2px solid #0071dc; padding-bottom: 12px; margin-bottom: 16px; }
  .receipt h1 { font-size: 18px; margin: 0 0 4px; }
  .receipt .order-date { color: #555; font-size: 13px; }
  .barcode { display: block; margin: 12px auto; max-width: 320px; max-height: 90px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 16px; }
  th { text-align: left; border-bottom: 1px solid #ccc; padding: 6px 4px; }
  td { padding: 5px 4px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  .amt, th.amt { text-align: right; white-space: nowrap; }
  .totals td { border-bottom: none; padding: 3px 4px; }
  .totals .grand td { border-top: 2px solid #1a1a1a; font-weight: bold; padding-top: 6px; }
  .meta { font-size: 12px; color: #555; line-height: 1.5; }
  .footer-note { text-align: center; color: #999; font-size: 11px; margin-top: 24px; }
  @media print { body { padding: 0; } .receipt { border: none; margin-bottom: 0; } }
`;

/** Wrap body markup in a standalone printable HTML document. */
function buildPrintableHtmlDocument(title, bodyHtml) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>${RECEIPT_STYLES}</style>
</head>
<body>
${bodyHtml}
<p class="footer-note">Generated by Walmart Invoice Exporter — open in a browser and print to save as PDF.</p>
</body>
</html>`;
}

/** Render one "label / amount" totals row, skipping empty values. */
function receiptTotalsRow(label, value, extraClass = '') {
  if (!value) return '';
  return `<tr${extraClass ? ` class="${extraClass}"` : ''}><td>${escapeHtml(label)}</td><td class="amt">${escapeHtml(value)}</td></tr>`;
}

/**
 * Build the printable receipt markup for one order.
 * The barcode image is loaded by the browser when the receipt is opened; it
 * links back to Walmart's receipt service and may require a signed-in session.
 * @param {Object} order - Order data object from the deep export
 * @returns {string} HTML for one receipt article
 */
function buildReceiptArticle(order) {
  const itemsRows = (order.items || [])
    .map(
      (item) => `<tr>
        <td>${escapeHtml(item.productName || '')}</td>
        <td class="amt">${escapeHtml(item.quantity || '')}</td>
        <td class="amt">${escapeHtml(item.price || '')}</td>
        <td>${escapeHtml(item.deliveryStatus || '')}</td>
      </tr>`
    )
    .join('');

  const barcodeHtml = order.barcodeImageUrl
    ? `<img class="barcode" src="${escapeHtml(order.barcodeImageUrl)}" alt="Order receipt barcode">`
    : '';

  const metaLines = [
    order.address ? `Ship to: ${order.address}` : '',
    formatPaymentMethodDetails(order) ? `Payment: ${formatPaymentMethodDetails(order)}` : '',
    order.paymentSplit ? `Charged: ${order.paymentSplit}` : '',
    order.sellers ? `Sold by: ${order.sellers}` : '',
    order.trackingNumbers ? `Tracking: ${order.trackingNumbers}` : '',
    order.deliveredDate ? `Delivered: ${order.deliveredDate}` : '',
  ]
    .filter(Boolean)
    .map((line) => `<div>${escapeHtml(line)}</div>`)
    .join('');

  return `<article class="receipt">
  <header>
    <h1>Walmart Order #${escapeHtml(order.orderNumber || '')}</h1>
    <div class="order-date">${escapeHtml(order.orderDate || '')}</div>
  </header>
  ${barcodeHtml}
  <table class="items">
    <thead><tr><th>Item</th><th class="amt">Qty</th><th class="amt">Price</th><th>Status</th></tr></thead>
    <tbody>${itemsRows}</tbody>
  </table>
  <table class="totals">
    ${receiptTotalsRow('Subtotal (before savings)', order.subtotalBeforeSavings)}
    ${receiptTotalsRow('Savings', order.savings)}
    ${receiptTotalsRow('Subtotal', order.orderSubtotal)}
    ${receiptTotalsRow('Delivery charges', order.deliveryCharges)}
    ${receiptTotalsRow('Bag fee', order.bagFee)}
    ${receiptTotalsRow('Tax', order.tax)}
    ${receiptTotalsRow('Tip', order.tip)}
    ${receiptTotalsRow('Refund', order.refund)}
    ${receiptTotalsRow('Donations', order.donations)}
    ${receiptTotalsRow('Order total', order.orderTotal, 'grand')}
  </table>
  <div class="meta">${metaLines}</div>
</article>`;
}

/**
 * Export orders as a printable HTML receipt file.
 * Multiple orders get one receipt each with a page break between them.
 * @param {Array|Object} ordersData - Order data object(s)
 * @param {string} filename - Download filename
 */
function convertOrdersToReceiptHtml(ordersData, filename = 'Walmart_Orders_Receipts.html') {
  const ordersArray = Array.isArray(ordersData) ? ordersData : [ordersData];
  const body = ordersArray.map(buildReceiptArticle).join('\n');
  downloadTextFile(buildPrintableHtmlDocument('Walmart Receipts', body), filename, 'text/html');
}

/**
 * Export Quick Export summary rows as a printable HTML table.
 * @param {Array} summaryRows - Pre-built summary row objects
 * @param {string} filename - Download filename
 */
function convertOrderSummariesToHtml(summaryRows, filename = 'Walmart_Orders_Summary.html') {
  const rowsArray = Array.isArray(summaryRows) ? summaryRows : [];
  const header = SUMMARY_CSV_COLUMNS.map(([label]) => `<th>${escapeHtml(label)}</th>`).join('');
  const rows = rowsArray
    .map(
      (row) =>
        `<tr>${SUMMARY_CSV_COLUMNS.map(([, getter]) => `<td>${escapeHtml(getter(row))}</td>`).join('')}</tr>`
    )
    .join('\n');
  const body = `<h1 style="text-align:center;font-size:18px;">Walmart Orders Summary</h1>
<table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
  downloadTextFile(buildPrintableHtmlDocument('Walmart Orders Summary', body), filename, 'text/html');
}

/**
 * True PDF receipt export (PdfLite — no external libraries)
 */

/**
 * Trigger download of a binary file (PDF)
 * @param {Uint8Array} bytes - File bytes
 * @param {string} filename - Download filename
 * @param {string} mimeType - MIME type
 */
function downloadBinaryFile(bytes, filename, mimeType) {
  const blob = new Blob([bytes], { type: mimeType });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.URL.revokeObjectURL(url);
}

/** Shared layout constants for the PdfLite renderers (points; y from page top). */
const PDF_LAYOUT = {
  MARGIN_X: 54,
  RIGHT_EDGE: 558,
  TOP_Y: 56,
  MAX_Y: 740,          // paginate before content passes this baseline
  ROW_HEIGHT: 14,
  BODY_SIZE: 9,
  FOOTER_Y: 772,
  FOOTER_SIZE: 7,
  FOOTER_NOTE: 'Generated by Walmart Invoice Exporter',
};

/** Item-table column geometry shared by the header row and item rows. */
const PDF_ITEM_COLUMNS = {
  ITEM_X: 54,
  ITEM_MAX_WIDTH: 330,
  QTY_RIGHT_X: 420,
  PRICE_RIGHT_X: 490,
  STATUS_X: 500,
  STATUS_MAX_WIDTH: 58,
};

/** Receipt totals rows in display order: [label, order field key]. */
const PDF_TOTALS_ROWS = [
  ['Subtotal (before savings)', 'subtotalBeforeSavings'],
  ['Savings', 'savings'],
  ['Subtotal', 'orderSubtotal'],
  ['Delivery charges', 'deliveryCharges'],
  ['Bag fee', 'bagFee'],
  ['Tax', 'tax'],
  ['Tip', 'tip'],
  ['Refund', 'refund'],
  ['Donations', 'donations'],
];

/**
 * Truncate text (via truncateText) until it fits within maxWidth points.
 * @param {string} text - Text to fit
 * @param {number} size - Font size in points
 * @param {boolean} bold - Measure with the bold width table
 * @param {number} maxWidth - Available width in points
 * @returns {string}
 */
function fitPdfText(text, size, bold, maxWidth) {
  const value = String(text || '');
  const fullWidth = PdfLite.textWidth(value, size, bold);
  if (fullWidth <= maxWidth) return value;
  // Start from a proportional estimate, then trim until it fits.
  let length = Math.max(1, Math.floor((value.length * maxWidth) / fullWidth));
  let candidate = truncateText(value, length);
  while (length > 1 && PdfLite.textWidth(candidate, size, bold) > maxWidth) {
    length -= 1;
    candidate = truncateText(value, length);
  }
  return candidate;
}

/**
 * Create a top-down page cursor for a PdfLite document: tracks the current
 * baseline y, starts pages (stamping the footer note on each), and breaks
 * to a new page when content would overflow the printable area.
 * @param {Object} doc - PdfLite document builder
 * @returns {{y: number, newPage: Function, ensureRoom: Function}}
 */
function createPdfCursor(doc) {
  const cursor = {
    y: PDF_LAYOUT.TOP_Y,
    /** Start a new page with the footer note and reset y to the top. */
    newPage() {
      doc.addPage();
      doc.text(PDF_LAYOUT.FOOTER_NOTE, PdfLite.PAGE_WIDTH / 2, PDF_LAYOUT.FOOTER_Y, {
        size: PDF_LAYOUT.FOOTER_SIZE,
        align: 'center',
      });
      cursor.y = PDF_LAYOUT.TOP_Y;
    },
    /**
     * Break to a new page if drawing `height` more points would overflow.
     * @param {number} height - Vertical room needed in points
     * @param {Function} [onNewPage] - Re-draw callback (e.g. a table header)
     */
    ensureRoom(height, onNewPage) {
      if (cursor.y + height > PDF_LAYOUT.MAX_Y) {
        cursor.newPage();
        if (onNewPage) onNewPage();
      }
    },
  };
  return cursor;
}

/** Draw one order's centered receipt header (title, date, divider). */
function drawPdfOrderHeader(doc, cursor, order) {
  const centerX = PdfLite.PAGE_WIDTH / 2;
  doc.text(`Walmart Order #${order.orderNumber || ''}`, centerX, cursor.y, {
    size: 14,
    bold: true,
    align: 'center',
  });
  if (order.orderDate) {
    doc.text(String(order.orderDate), centerX, cursor.y + 16, { size: 10, align: 'center' });
  }
  doc.line(PDF_LAYOUT.MARGIN_X, cursor.y + 26, PDF_LAYOUT.RIGHT_EDGE, cursor.y + 26, { width: 1 });
  cursor.y += 44;
}

/** Draw the bold items-table header row with its underline. */
function drawPdfItemsHeader(doc, cursor) {
  const size = PDF_LAYOUT.BODY_SIZE;
  doc.text('Item', PDF_ITEM_COLUMNS.ITEM_X, cursor.y, { size, bold: true });
  doc.text('Qty', PDF_ITEM_COLUMNS.QTY_RIGHT_X, cursor.y, { size, bold: true, align: 'right' });
  doc.text('Price', PDF_ITEM_COLUMNS.PRICE_RIGHT_X, cursor.y, { size, bold: true, align: 'right' });
  doc.text('Status', PDF_ITEM_COLUMNS.STATUS_X, cursor.y, { size, bold: true });
  doc.line(PDF_LAYOUT.MARGIN_X, cursor.y + 4, PDF_LAYOUT.RIGHT_EDGE, cursor.y + 4);
  cursor.y += PDF_LAYOUT.ROW_HEIGHT;
}

/** Draw one item row of the receipt items table. */
function drawPdfItemRow(doc, cursor, item) {
  const size = PDF_LAYOUT.BODY_SIZE;
  doc.text(
    fitPdfText(item.productName, size, false, PDF_ITEM_COLUMNS.ITEM_MAX_WIDTH),
    PDF_ITEM_COLUMNS.ITEM_X, cursor.y, { size }
  );
  doc.text(String(item.quantity || ''), PDF_ITEM_COLUMNS.QTY_RIGHT_X, cursor.y, { size, align: 'right' });
  doc.text(String(item.price || ''), PDF_ITEM_COLUMNS.PRICE_RIGHT_X, cursor.y, { size, align: 'right' });
  doc.text(
    fitPdfText(item.deliveryStatus, size, false, PDF_ITEM_COLUMNS.STATUS_MAX_WIDTH),
    PDF_ITEM_COLUMNS.STATUS_X, cursor.y, { size }
  );
  cursor.y += PDF_LAYOUT.ROW_HEIGHT;
}

/**
 * Draw the right-aligned totals block (skips empty values), ending with a
 * bold "Order total" row under a total rule.
 */
function drawPdfTotals(doc, cursor, order) {
  const size = PDF_LAYOUT.BODY_SIZE;
  const labelRightX = 470;
  const valueRightX = PDF_LAYOUT.RIGHT_EDGE;
  cursor.y += 6;
  PDF_TOTALS_ROWS.forEach(([label, key]) => {
    if (!order[key]) return;
    cursor.ensureRoom(PDF_LAYOUT.ROW_HEIGHT);
    doc.text(label, labelRightX, cursor.y, { size, align: 'right' });
    doc.text(String(order[key]), valueRightX, cursor.y, { size, align: 'right' });
    cursor.y += PDF_LAYOUT.ROW_HEIGHT;
  });
  if (order.orderTotal) {
    cursor.ensureRoom(PDF_LAYOUT.ROW_HEIGHT);
    doc.line(360, cursor.y - 9, valueRightX, cursor.y - 9, { width: 1 });
    doc.text('Order total', labelRightX, cursor.y, { size: 10, bold: true, align: 'right' });
    doc.text(String(order.orderTotal), valueRightX, cursor.y, { size: 10, bold: true, align: 'right' });
    cursor.y += PDF_LAYOUT.ROW_HEIGHT;
  }
}

/** Draw the receipt meta lines (ship to / payment / tracking / …), skipping empties. */
function drawPdfMetaLines(doc, cursor, order) {
  const payment = formatPaymentMethodDetails(order);
  const metaLines = [
    order.address ? `Ship to: ${order.address}` : '',
    payment ? `Payment: ${payment}` : '',
    order.paymentSplit ? `Charged: ${order.paymentSplit}` : '',
    order.sellers ? `Sold by: ${order.sellers}` : '',
    order.trackingNumbers ? `Tracking: ${order.trackingNumbers}` : '',
    order.deliveredDate ? `Delivered: ${order.deliveredDate}` : '',
  ].filter(Boolean);
  if (metaLines.length === 0) return;

  const size = PDF_LAYOUT.BODY_SIZE;
  const maxWidth = PDF_LAYOUT.RIGHT_EDGE - PDF_LAYOUT.MARGIN_X;
  cursor.y += 6;
  metaLines.forEach((line) => {
    cursor.ensureRoom(PDF_LAYOUT.ROW_HEIGHT);
    doc.text(fitPdfText(line, size, false, maxWidth), PDF_LAYOUT.MARGIN_X, cursor.y, { size });
    cursor.y += PDF_LAYOUT.ROW_HEIGHT;
  });
}

/**
 * Render orders as a true PDF receipt. Each order starts on a new page and
 * may span several (long item lists repeat the table header after a break).
 * Mirrors the printable HTML receipt content (buildReceiptArticle).
 * @param {Array|Object} ordersData - Order data object(s)
 * @returns {Uint8Array} PDF file bytes
 */
function buildReceiptPdf(ordersData) {
  const ordersArray = Array.isArray(ordersData) ? ordersData : [ordersData];
  const doc = PdfLite.createDocument();
  const cursor = createPdfCursor(doc);

  ordersArray.forEach((order) => {
    cursor.newPage();
    drawPdfOrderHeader(doc, cursor, order);

    const drawHeader = () => drawPdfItemsHeader(doc, cursor);
    drawHeader();
    (order.items || []).forEach((item) => {
      cursor.ensureRoom(PDF_LAYOUT.ROW_HEIGHT, drawHeader);
      drawPdfItemRow(doc, cursor, item);
    });

    drawPdfTotals(doc, cursor, order);
    drawPdfMetaLines(doc, cursor, order);
  });

  return doc.build();
}

/**
 * Export orders as a true PDF receipt file.
 * @param {Array|Object} ordersData - Order data object(s)
 * @param {string} filename - Download filename
 */
function convertOrdersToReceiptPdf(ordersData, filename = 'Walmart_Orders_Receipts.pdf') {
  downloadBinaryFile(buildReceiptPdf(ordersData), filename, 'application/pdf');
}

/** Column geometry for the Quick Export summary PDF table. */
const PDF_SUMMARY_COLUMNS = {
  ORDER_X: 54,
  ORDER_MAX_WIDTH: 150,
  DATE_X: 214,
  DATE_MAX_WIDTH: 170,
  ITEMS_RIGHT_X: 440,
  TOTAL_RIGHT_X: 558,
};

/** Draw the bold summary-table header row with its underline. */
function drawPdfSummaryHeader(doc, cursor) {
  const size = PDF_LAYOUT.BODY_SIZE;
  doc.text('Order #', PDF_SUMMARY_COLUMNS.ORDER_X, cursor.y, { size, bold: true });
  doc.text('Date', PDF_SUMMARY_COLUMNS.DATE_X, cursor.y, { size, bold: true });
  doc.text('Items', PDF_SUMMARY_COLUMNS.ITEMS_RIGHT_X, cursor.y, { size, bold: true, align: 'right' });
  doc.text('Total', PDF_SUMMARY_COLUMNS.TOTAL_RIGHT_X, cursor.y, { size, bold: true, align: 'right' });
  doc.line(PDF_LAYOUT.MARGIN_X, cursor.y + 4, PDF_LAYOUT.RIGHT_EDGE, cursor.y + 4);
  cursor.y += PDF_LAYOUT.ROW_HEIGHT;
}

/**
 * Render Quick Export summary rows as a paginated PDF table
 * (Order # / Date / Items / Total, money right-aligned).
 * @param {Array} summaryRows - Pre-built summary row objects
 * @returns {Uint8Array} PDF file bytes
 */
function buildSummaryPdf(summaryRows) {
  const rowsArray = Array.isArray(summaryRows) ? summaryRows : [];
  const doc = PdfLite.createDocument();
  const cursor = createPdfCursor(doc);
  cursor.newPage();

  doc.text('Walmart Orders Summary', PdfLite.PAGE_WIDTH / 2, cursor.y, {
    size: 14,
    bold: true,
    align: 'center',
  });
  cursor.y += 28;

  const drawHeader = () => drawPdfSummaryHeader(doc, cursor);
  drawHeader();
  rowsArray.forEach((row) => {
    cursor.ensureRoom(PDF_LAYOUT.ROW_HEIGHT, drawHeader);
    const size = PDF_LAYOUT.BODY_SIZE;
    doc.text(
      fitPdfText(row.orderNumber, size, false, PDF_SUMMARY_COLUMNS.ORDER_MAX_WIDTH),
      PDF_SUMMARY_COLUMNS.ORDER_X, cursor.y, { size }
    );
    doc.text(
      fitPdfText(row.orderDate, size, false, PDF_SUMMARY_COLUMNS.DATE_MAX_WIDTH),
      PDF_SUMMARY_COLUMNS.DATE_X, cursor.y, { size }
    );
    const itemCount = row.itemCount === '' || row.itemCount === null || row.itemCount === undefined
      ? ''
      : String(row.itemCount);
    doc.text(itemCount, PDF_SUMMARY_COLUMNS.ITEMS_RIGHT_X, cursor.y, { size, align: 'right' });
    doc.text(String(row.orderTotal || ''), PDF_SUMMARY_COLUMNS.TOTAL_RIGHT_X, cursor.y, { size, align: 'right' });
    cursor.y += PDF_LAYOUT.ROW_HEIGHT;
  });

  return doc.build();
}

/**
 * Export Quick Export summary rows as a PDF file.
 * @param {Array} summaryRows - Pre-built summary row objects
 * @param {string} filename - Download filename
 */
function convertOrderSummariesToPdf(summaryRows, filename = 'Walmart_Orders_Summary.pdf') {
  downloadBinaryFile(buildSummaryPdf(summaryRows), filename, 'application/pdf');
}

/**
 * SVG Icon constants - Centralized icon definitions used throughout the extension
 */
const SVG_ICONS = {
  ERROR_CIRCLE: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
  
  SUCCESS_CHECKMARK: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>',
  
  TRASH: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>',

  // 16x16 (not 14x14) so it visually pairs with DOWNLOAD on the
  // Single file / Multiple files button pair (spec §5.2).
  PACKAGE: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>',
  
  INFO_CIRCLE: '<svg width="12" height="12" viewBox="0 0 50 50" fill="none" stroke="currentColor" stroke-width="2"><path d="M 25 2 C 12.309295 2 2 12.309295 2 25 C 2 37.690705 12.309295 48 25 48 C 37.690705 48 48 37.690705 48 25 C 48 12.309295 37.690705 2 25 2 z M 25 4 C 36.609824 4 46 13.390176 46 25 C 46 36.609824 36.609824 46 25 46 C 13.390176 46 4 36.609824 4 25 C 4 13.390176 13.390176 4 25 4 z M 25 11 A 3 3 0 0 0 22 14 A 3 3 0 0 0 25 17 A 3 3 0 0 0 28 14 A 3 3 0 0 0 25 11 z M 21 21 L 21 23 L 22 23 L 23 23 L 23 36 L 22 36 L 21 36 L 21 38 L 22 38 L 23 38 L 27 38 L 28 38 L 29 38 L 29 36 L 28 36 L 27 36 L 27 21 L 26 21 L 22 21 L 21 21 z"></path></svg>',
  
  DOWNLOAD: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
  
  ERROR_LARGE: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#e41e31" stroke-width="2" style="margin-bottom: 16px;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>',
  
  STAR: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>',
  
  X_CLOSE: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',

  CACHE: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3c4.97 0 9 3.582 9 8s-4.03 8-9 8-9-3.582-9-8 4.03-8 9-8m0-2C6.477 1 2 4.925 2 9.72c0 3.45 2.563 6.43 6 7.723V22h8v-4.558c3.437-1.294 6-4.273 6-7.723 0-4.795-4.477-8.72-10-8.72z"></path></svg>',

  // Settings gear (header icon button, spec §5.4).
  SETTINGS: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>',

  // Order row expand/collapse chevron (spec v7.1 §C) — rotated via CSS on
  // .order-row.expanded, not swapped for a different icon.
  CHEVRON_DOWN: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>',
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
 * Escape HTML to prevent injection in UI messages
 * @param {string} value - Value to escape
 * @returns {string} Escaped string
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Constants for CSS classes, selectors, and text strings
 */
const CONSTANTS = {
  // CSS Classes
  CSS_CLASSES: {
    BTN_PRIMARY: 'btn btn-primary',
    BTN_DANGER: 'btn btn-danger',
    BTN_CLEAR: 'btn btn-clear',
    CHECKBOX_CONTAINER: 'checkbox-container',
    ORDER_LABEL: 'order-label',
    INFO_ICON: 'info-icon',
    ORDER_TOOLTIP: 'order-tooltip',
    LOADING_SPINNER: 'loading-spinner',
  },

  // DOM selectors moved to providers/walmart-us.js (WalmartUsProvider.SELECTORS).

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
    SELECT_ORDERS: 'Orders',
  },

  // Chrome Messages
  MESSAGES: {
    START_COLLECTION: 'startCollection',
    STOP_COLLECTION: 'stopCollection',
    GET_PROGRESS: 'getProgress',
    // Clears chrome.storage.session's live collection progress + resets
    // background.js's in-memory CollectionState (spec §4.4) — the ONLY
    // thing left of the old "Clear Cache" concept. Sent by Settings'
    // "Delete all saved data" alongside OrderDb.clearAll(); renamed from
    // the retired 'clearCache' to describe what it actually does now that
    // there is no more chrome.storage invoice cache to clear.
    RESET_SESSION_STATE: 'resetSessionState',
    COLLECT_ORDER_NUMBERS: 'collectOrderNumbers',
    // Optional Fast Collect: one call collects the whole history via direct
    // in-page API replay (adapters that set supportsFastFetch). Used only when
    // the `fastFetch` setting is on; otherwise the classic per-page flow runs.
    COLLECT_ALL_FAST: 'collectAllFast',
    // Fired by the content script during Fast Collect after each page so the
    // panel shows live progress (page number + orders) instead of waiting for
    // the whole history in silence. Fire-and-forget; the final COLLECT_ALL_FAST
    // response still carries the complete result.
    FAST_COLLECT_PROGRESS: 'fastCollectProgress',
    CLICK_NEXT_BUTTON: 'clickNextButton',
    BLOCK_IMAGES: 'blockImagesForDownload',
    GET_ORDER_DATA: 'getOrderData',
    // Returns a non-reversible key for the Walmart account logged into THIS
    // page (SHA-256 of the CID cookie), so saved data can be scoped per account
    // — a different account's orders don't show after a logout/login. The raw
    // CID never leaves the page; only the hash is used, on-device.
    GET_ACCOUNT_KEY: 'getAccountKey',
    // Fast invoice: fetch one order's full invoice by HTML-fetching its detail
    // page and parsing __NEXT_DATA__ — no tab navigation. Handled by adapters
    // that set supportsFastInvoice; used only when the fast setting is on.
    GET_ORDER_DATA_FAST: 'getOrderDataFast',
  },

  // Storage Keys
  STORAGE_KEYS: {
    // spec §5.3 — Excel-only opt-in for the pre-6.18 single-sheet layout.
    LEGACY_EXCEL: 'legacyExcel',
    // spec §7 risk table — one-time dismissible tip shown where Quick
    // Export used to be, telling returning users where it went.

    // Multi-account: the account currently being VIEWED (a hashed account key,
    // or the ACCOUNTS.UNTAGGED sentinel). Persisted so the side panel and the
    // dashboard show the same account and stay in sync through storage events.
    CURRENT_ACCOUNT: 'currentAccountKey',
    // User-chosen display names per account, on-device only: { [key]: 'Work' }.
    // We never store the account's real name/email — only the user's own label.
    ACCOUNT_LABELS: 'accountLabels',
    // Stable "Account 1 / Account 2" ordinals per key, assigned first-seen and
    // never reshuffled: { [key]: 1 }. Separate from labels so a rename can't
    // disturb another account's number.
    ACCOUNT_ORDINALS: 'accountOrdinals',
  },

  // Multi-account support.
  ACCOUNTS: {
    // Selection sentinel for the "orders with no account tag yet" bucket
    // (legacy data collected before per-account tagging, or when the account
    // couldn't be read). A real account key is a 32-char hex hash, so this
    // underscore-wrapped value can never collide with one.
    UNTAGGED: '__untagged__',
  },

  // Cache Keys
  CACHE_KEYS: {
    // Legacy chrome.storage.local keys — retired (spec §4.1). Kept only so
    // migrateLegacyStorage can find and remove any leftovers on upgrade.
    ORDER_COLLECTION: 'walmart_order_cache',
    INVOICE: 'walmart_invoice_cache',
    // Live chrome.storage.session key backing in-progress collection
    // progress (spec §4.1/§4.3) — cleared automatically when the browser
    // closes; no manual TTL bookkeeping needed.
    COLLECTION_SESSION: 'walmart_collection_session',
  },

  // URL Parameters
  URLS: {
    WALMART_ORDERS: 'https://www.walmart.com/orders',
    WALMART_REVIEWS: 'https://chromewebstore.google.com/detail/walmart-invoice-exporter/bndkihecbbkoligeekekdgommmdllfpe/reviews',
    GITHUB_ISSUES: 'https://github.com/amruta-chaudhari/Walmart-Invoice-Exporter/issues/new',
  },

  // User-configurable timings (Settings → Advanced). Single source of
  // truth for key, label, default, and safe bounds — the Settings UI, the
  // per-box "Default" buttons, state hydration, and the reset path all
  // read this table so they can never disagree.
  TIMING_SETTINGS: [
    {
      key: 'collectPageDelayMs',
      label: 'Wait between order-history pages',
      hint: 'Raise this if collection skips pages on a slow connection.',
      defaultMs: 1000,
      minMs: 250,
      maxMs: 30000,
    },
    {
      key: 'orderTimeoutMs',
      label: 'Give up on an order page after',
      hint: 'Raise this if very old orders fail to download.',
      defaultMs: 10000,
      minMs: 3000,
      maxMs: 120000,
    },
    {
      key: 'orderSettleMs',
      label: 'Settle time before reading an order page',
      hint: 'Raise this if downloads come back with blank fields.',
      defaultMs: 1000,
      minMs: 0,
      maxMs: 15000,
    },
  ],

  // Inactivity-based data retention (Settings → Advanced). ON by default: if
  // the extension isn't used (panel opened / a run started) for `days`, ALL
  // saved data is wiped in one shot — so an abandoned install doesn't keep data
  // on the device. An active user's clock keeps resetting, so they never lose
  // anything. NOT per-order aging.
  DATA_RETENTION: {
    defaultDays: 30,
    minDays: 1,
    maxDays: 3650,
  },

  // Timing Constants (in milliseconds)
  TIMING: {
    IMAGE_BLOCK_DELAY: 500,
    PAGE_LOAD_WAIT: 800,
    DOWNLOAD_TIMEOUT: 10000,      // Reduced from 30s for faster failure detection
    COLLECTION_TIMEOUT: 10000,    // Reduced from 30s for faster failure detection
    ELEMENT_POLL_INTERVAL: 200,   // Polling interval for waitForElement
    RETRY_DELAY: 400,
    HINT_DISMISS_DELAY: 5000,
    SUCCESS_DISPLAY_DURATION: 10000,       // How long to show success messages
    ERROR_DISPLAY_DURATION: 30000,         // How long to show error messages
    EXPORT_FAIL_DISPLAY: 5000,             // How long to show export failure messages
  },

  // Order Number Regex
  ORDER_NUMBER_REGEX: /#\s*([\d-]+)/,

  // Export Modes
  EXPORT_MODES: {
    SINGLE: 'single',
    MULTIPLE: 'multiple',
  },

  // Order-data schema: v3 fixed item dedup (payload-first, price-insensitive)
  // — invoices stored by older versions may contain doubled items and $0.00
  // prices and are not trusted by exports or the dashboard.
  ORDER_SCHEMA_VERSION: 3,

  // Export file formats
  EXPORT_FORMATS: {
    XLSX: 'xlsx',
    CSV: 'csv',
    JSON: 'json',
    RECEIPT: 'receipt',
    PDF: 'pdf',
  },

  // CSV preset targets (accounting imports)
  CSV_PRESETS: {
    GENERIC: 'generic',
    QUICKBOOKS: 'quickbooks',
    XERO: 'xero',
  },
};

/**
 * Query params on the orders URL that are tracking/navigation noise,
 * not user-selected filters.
 */
const NON_FILTER_ORDER_PARAMS = [
  'page', 'povid', 'from', 'wmlspartner', 'adsredirect',
  'gclid', 'fbclid', 'msclkid', 'irgwc', 'veh', 'sourceid', 'clickid', 'cid', 'sid',
];

/** Prefixes of tracking params (utm_*, Walmart ath* attribution). */
const NON_FILTER_ORDER_PARAM_PREFIXES = ['utm_', 'ath'];

/**
 * Describe the Walmart filters active on an orders-page URL.
 * Purely observational — the extension never builds filter URLs itself;
 * it paginates whatever filtered view the user set on walmart.com.
 * @param {string} url - The orders page URL
 * @returns {string[]} Human-readable "key: value" filter descriptions
 */
function describeActiveFilters(url) {
  try {
    const params = new URL(url).searchParams;
    const parts = [];
    params.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (NON_FILTER_ORDER_PARAMS.includes(lowerKey)) return;
      if (NON_FILTER_ORDER_PARAM_PREFIXES.some((prefix) => lowerKey.startsWith(prefix))) return;
      const cleanValue = String(value).trim();
      parts.push(cleanValue ? `${key}: ${cleanValue}` : key);
    });
    return parts;
  } catch (error) {
    return [];
  }
}

/**
 * Whether a Quick Export summary came from the rich payload path.
 * Summaries stored before source-tagging existed are recognized by the
 * payload-only fields they carry (per-item data / subtotal).
 * @param {Object|null} summary - Quick Export summary object
 * @returns {boolean}
 */
function isPayloadQualitySummary(summary) {
  if (!summary) return false;
  if (summary.source === 'payload') return true;
  if (summary.source === 'dom') return false;
  return (Array.isArray(summary.items) && summary.items.length > 0) || Boolean(summary.subTotal);
}

/**
 * Normalize any stored order date (ISO '2026-06-14T…', human 'Jun 14, 2026',
 * or empty) to a sortable 'YYYY-MM-DD' string, else ''. Originally
 * dashboard-only; moved here (spec 2026-07-17 addendum) so the receipt-style
 * order list's month grouping and date-range filter (sidepanel.view.js) can
 * share it with sidepanel.dashboard.js.
 */
function normalizeDashboardDate(rawDate) {
  const text = String(rawDate || '');
  if (/^\d{4}-\d{2}/.test(text)) return text.slice(0, 10);
  if (!text) return '';
  const parsed = new Date(text);
  if (isNaN(parsed.getTime())) return '';
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
}

/**
 * Resolve a stored value for one CONSTANTS.TIMING_SETTINGS entry to a safe
 * number of milliseconds: non-numeric/absent → the default; numeric →
 * clamped into [minMs, maxMs]. Every consumer of a configurable timing
 * (download queue, background collection, Settings UI) goes through this,
 * so a corrupt stored value can never hang or hammer anything.
 * @param {{defaultMs: number, minMs: number, maxMs: number}} spec - a CONSTANTS.TIMING_SETTINGS entry
 * @param {*} rawValue - whatever chrome.storage returned
 * @returns {number} milliseconds
 */
function resolveTimingSetting(spec, rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return spec.defaultMs;
  return Math.min(spec.maxMs, Math.max(spec.minMs, Math.round(value)));
}

/**
 * Parse a date out of Walmart's own order title text, e.g.
 * "Jun 15, 2022 order", "June 15, 2022 purchase", "Sep. 3, 2023 order".
 * Walmart's purchase-history payload titles carry the full date (with
 * year) even for years-old orders whose detail page no longer exposes
 * one — so the title is the most durable date source we have, and it is
 * exactly what the user sees on walmart.com. Requires an explicit 4-digit
 * year: year-less strings like "Delivered on Jun 23" are ambiguous and
 * return ''.
 * @param {string} text - order title / status text
 * @returns {string} 'YYYY-MM-DD', or '' when no unambiguous date found
 */
function parseWalmartTitleDate(text) {
  const match = String(text || '').match(
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i
  );
  if (!match) return '';
  const MONTH_PREFIXES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthIndex = MONTH_PREFIXES.indexOf(match[1].toLowerCase());
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (monthIndex < 0 || day < 1 || day > 31) return '';
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Order list row model & date-range filtering (spec 2026-07-17 addendum,
 * "list & flow redesign v7.1"). Pure/testable — the DOM assembly that
 * consumes these lives in sidepanel.view.js's displayOrderNumbers.
 */

/**
 * Build one order row's display model from its OrderDb record (if any) and
 * the title a live collection session may have attached. Every field has a
 * defensive fallback so a bare/undated/summary-less order number still
 * renders a usable (if minimal) row.
 * @param {string} orderNumber - digits-only order number
 * @param {Object|null} record - an OrderDb record ({orderDate, title, summary, invoice}), or null/undefined
 * @param {string} [sessionTitle] - title from a live GET_PROGRESS overlay, when present
 * @returns {Object} row model consumed by sidepanel.view.js's row renderer
 */
function buildOrderRowModel(orderNumber, record, sessionTitle) {
  const summary = (record && record.summary) || null;
  const invoice = (record && record.invoice) || null;

  let rawDate = (summary && summary.orderDate) || (record && record.orderDate) || (invoice && invoice.orderDate) || '';
  let normalizedDate = normalizeDashboardDate(rawDate);
  if (!normalizedDate) {
    // The delivery date Walmart shows ("Delivered on …") — stored on list
    // summaries (ISO) and on downloaded invoices ('Jul 02, 2026', possibly
    // ';'-joined across shipments). A few days after the order date at
    // worst, and present on orders whose order date is long gone.
    const deliveredRaw = String(
      (summary && summary.deliveredDate) || (invoice && invoice.deliveredDate) || ''
    ).split(';')[0].trim();
    const delivered = normalizeDashboardDate(deliveredRaw);
    if (delivered) {
      normalizedDate = delivered;
      rawDate = rawDate || deliveredRaw;
    }
  }
  if (!normalizedDate) {
    // Old orders often have no date anywhere in the stored data (their
    // detail page stopped exposing one), but Walmart's own list title —
    // which we store — reads "Jun 15, 2022 order". Use it, so the list
    // shows what walmart.com shows instead of "NO DATE".
    const titleDate = parseWalmartTitleDate(
      sessionTitle || (record && record.title) || (summary && summary.title) || ''
    );
    if (titleDate) {
      normalizedDate = titleDate;
      rawDate = rawDate || titleDate;
    }
  }

  const status = summary && summary.status ? String(summary.status).split(';')[0].trim() : '';

  const itemCount =
    (summary && summary.itemCount !== '' && summary.itemCount !== undefined && summary.itemCount !== null
      ? summary.itemCount
      : null) ??
    (invoice && Array.isArray(invoice.items) ? invoice.items.length : '') ??
    '';

  const total = (summary && summary.orderTotal) || (invoice && invoice.orderTotal) || '';

  const hasInvoice = Boolean(invoice) && Number(invoice.schemaVersion || 0) >= CONSTANTS.ORDER_SCHEMA_VERSION;

  const summaryItems =
    summary && Array.isArray(summary.items)
      ? summary.items.map((item) => ({ name: item?.name || '', quantity: item?.quantity ?? '' }))
      : [];

  return {
    orderNumber,
    rawDate,
    normalizedDate,
    status,
    itemCount,
    total,
    hasInvoice,
    summaryItems,
    summary,
    invoice,
    title: sessionTitle || (record && record.title) || '',
  };
}

/** Month-group label for a row, e.g. "JULY 2026"; undated rows get "NO DATE". */
function monthGroupLabel(normalizedDate) {
  if (!normalizedDate) return 'NO DATE';
  const MONTHS = [
    'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
    'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
  ];
  const monthIndex = Number(normalizedDate.slice(5, 7)) - 1;
  const label = MONTHS[monthIndex];
  return label ? `${label} ${normalizedDate.slice(0, 4)}` : 'NO DATE';
}

/** Short human date for a row's primary line, e.g. "Jul 9". Empty when unknown. */
function formatRowDateShort(normalizedDate) {
  if (!normalizedDate) return '';
  const parsed = new Date(`${normalizedDate}T00:00:00`);
  if (isNaN(parsed.getTime())) return '';
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS_SHORT[parsed.getMonth()]} ${parsed.getDate()}`;
}

/** The "Showing" filter's selectable ranges (excludes "custom", added separately by the UI). */
const LIST_RANGE_OPTIONS = [
  { value: 'all', label: 'All time' },
  { value: 'last3', label: 'Last 3 months' },
  { value: 'last6', label: 'Last 6 months' },
  { value: 'thisYear', label: 'This year' },
  { value: 'lastYear', label: 'Last year' },
];

/**
 * Inclusive 'YYYY-MM-DD' bounds for a range value. `from`/`to` are `null`
 * when unbounded on that side (all-time, or an empty custom field).
 * @param {string} rangeValue - one of LIST_RANGE_OPTIONS' values, or 'custom'
 * @param {Date} [now] - injectable for deterministic tests
 * @param {string} [customFrom] - 'YYYY-MM-DD', only used when rangeValue === 'custom'
 * @param {string} [customTo] - 'YYYY-MM-DD', only used when rangeValue === 'custom'
 * @returns {{from: string|null, to: string|null}}
 */
function getRangeBounds(rangeValue, now = new Date(), customFrom = '', customTo = '') {
  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = isoOf(now);
  const year = now.getFullYear();

  switch (rangeValue) {
    case 'last3': {
      const from = new Date(now);
      from.setMonth(from.getMonth() - 3);
      return { from: isoOf(from), to: today };
    }
    case 'last6': {
      const from = new Date(now);
      from.setMonth(from.getMonth() - 6);
      return { from: isoOf(from), to: today };
    }
    case 'thisYear':
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    case 'lastYear':
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    case 'custom':
      return { from: customFrom || null, to: customTo || null };
    default:
      return { from: null, to: null };
  }
}

/** Whether a normalized 'YYYY-MM-DD' date falls within inclusive bounds. Undated never matches a bounded range. */
function isDateInRange(normalizedDate, bounds) {
  if (!normalizedDate) return false;
  if (bounds.from && normalizedDate < bounds.from) return false;
  if (bounds.to && normalizedDate > bounds.to) return false;
  return true;
}

/**
 * Filter row models (spec §D) down to the ones a "Showing" range should
 * display. 'all' (or falsy) is a pass-through that also surfaces undated
 * rows; any bounded range hides undated rows and reports how many were hidden.
 * @param {Object[]} rows - buildOrderRowModel() results
 * @param {string} rangeValue - LIST_RANGE_OPTIONS value, or 'custom'/'all'
 * @param {Object} [options]
 * @param {Date} [options.now]
 * @param {string} [options.customFrom]
 * @param {string} [options.customTo]
 * @returns {{visible: Object[], hiddenUndatedCount: number}}
 */
function filterOrderRowsByRange(rows, rangeValue, { now, customFrom, customTo } = {}) {
  if (!rangeValue || rangeValue === 'all') {
    return { visible: rows, hiddenUndatedCount: 0 };
  }
  const bounds = getRangeBounds(rangeValue, now, customFrom, customTo);
  const visible = rows.filter((row) => isDateInRange(row.normalizedDate, bounds));
  const hiddenUndatedCount = rows.filter((row) => !row.normalizedDate).length;
  return { visible, hiddenUndatedCount };
}

/** Filename suffix for the active "Showing" range (spec §D), e.g. '_Last_3_Months', '_2026', '_Custom'; '' for all-time. */
function getRangeLabelSuffix(rangeValue, now = new Date()) {
  switch (rangeValue) {
    case 'last3': return '_Last_3_Months';
    case 'last6': return '_Last_6_Months';
    case 'thisYear': return `_${now.getFullYear()}`;
    case 'lastYear': return `_${now.getFullYear() - 1}`;
    case 'custom': return '_Custom';
    default: return '';
  }
}

/**
 * Sidepanel UI helpers
 */
const CACHE_INDICATOR_STYLE = 'margin-left: 6px; color: var(--primary); display: inline-flex; align-items: center; gap: 2px; font-size: 10px;';
const CACHE_INDICATOR_SELECTOR = '[data-cache-indicator="true"]';

/**
 * Show/hide the Collect-orders / Stop-collection button pair. When idle and
 * no explicit label is given, the start button's label reflects whether the
 * panel has ever shown any orders (spec v7.1 §A: "Load my orders" first-run
 * vs. "Check for new orders" returning) — set by view.updateMacroState via
 * state.app.hasOrders.
 */
function setCollectionButtonsState({ running, startLabel } = {}) {
  const startButton = document.getElementById("startCollection");
  const stopButton = document.getElementById("stopCollection");
  if (!startButton || !stopButton) return;

  startButton.style.display = running ? "none" : "inline-flex";
  stopButton.style.display = running ? "inline-flex" : "none";

  if (!running) {
    const label = startButton.querySelector(".btn-text");
    if (label) {
      const hasOrders = Boolean(
        window.Sidepanel && window.Sidepanel.state && window.Sidepanel.state.app && window.Sidepanel.state.app.hasOrders
      );
      label.textContent = startLabel || (hasOrders ? "Check for new orders" : "Load my orders");
    }
  }
}

/**
 * The checked/indeterminate state a group header (e.g. a month "select all")
 * should show, given how many rows the group has and how many are selected.
 * Pure so it can be unit-tested without a DOM:
 *   none selected  → unchecked, not indeterminate
 *   some selected  → indeterminate (the header shows a dash, not a tick)
 *   all selected   → checked
 * An empty group is never checked.
 * @param {number} total - rows in the group
 * @param {number} checked - how many of them are selected
 * @returns {{checked: boolean, indeterminate: boolean}}
 */
function groupSelectionState(total, checked) {
  return {
    checked: total > 0 && checked === total,
    indeterminate: checked > 0 && checked < total,
  };
}

/* ------------------------------------------------------------------------- *
 * Multi-account helpers (pure, DOM-free — shared by the side panel and the
 * dashboard so both label and switch accounts identically). A "selection
 * value" is what the switcher and CURRENT_ACCOUNT storage hold: either a real
 * 32-hex account key, or the ACCOUNTS.UNTAGGED sentinel for the legacy bucket.
 * A getAccountSummaries() entry carries `accountKey` (a real key, or null for
 * untagged), which accountSelectionValue() maps into that selection space.
 * ------------------------------------------------------------------------- */

/** Map a record/summary account key (real, or null for untagged) to a switcher selection value. */
function accountSelectionValue(accountKey) {
  return accountKey || CONSTANTS.ACCOUNTS.UNTAGGED;
}

/**
 * Assign stable "Account N" ordinals to any accounts that don't have one yet,
 * without ever renumbering the ones that do (so a new account never bumps an
 * existing account's number). The untagged bucket gets no ordinal — it's shown
 * as "Earlier orders", not "Account N".
 * @param {string[]} selectionValues - account selection values, in the order new ones should be numbered
 * @param {Object<string,number>} [existingOrdinals]
 * @returns {Object<string,number>} the updated ordinal map
 */
function assignAccountOrdinals(selectionValues = [], existingOrdinals = {}) {
  const ordinals = { ...(existingOrdinals || {}) };
  let next = Object.values(ordinals).reduce((max, n) => Math.max(max, Number(n) || 0), 0) + 1;
  selectionValues.forEach((value) => {
    if (!value || value === CONSTANTS.ACCOUNTS.UNTAGGED) return;
    if (!ordinals[value]) ordinals[value] = next++;
  });
  return ordinals;
}

/**
 * The name to show for an account: the user's own label if they set one, else
 * "Account N" from its ordinal, else "Earlier orders" for the untagged bucket.
 * @param {string|null} selectionValue
 * @param {{labels?: Object, ordinals?: Object}} [maps]
 */
function accountDisplayName(selectionValue, { labels = {}, ordinals = {} } = {}) {
  if (!selectionValue) return 'All accounts';
  if (labels && labels[selectionValue]) return labels[selectionValue];
  if (selectionValue === CONSTANTS.ACCOUNTS.UNTAGGED) return 'Earlier orders';
  const ordinal = ordinals && ordinals[selectionValue];
  return ordinal ? `Account ${ordinal}` : 'Account';
}

/**
 * Which account the switcher should show: the stored selection if it still has
 * data, otherwise the most-recently-used account (summaries are MRU-first),
 * otherwise null (no data at all → "All accounts", no filter).
 * @param {Array<{accountKey: string|null}>} summaries - from getAccountSummaries()
 * @param {string|null} storedValue - CURRENT_ACCOUNT from storage
 * @returns {string|null}
 */
function resolveSelectedAccount(summaries = [], storedValue = null) {
  const available = (summaries || []).map((s) => accountSelectionValue(s.accountKey));
  if (storedValue && available.includes(storedValue)) return storedValue;
  return available.length ? available[0] : null;
}

/**
 * Turn account summaries + label/ordinal maps into ready-to-render switcher
 * options (used identically by the side panel and the dashboard), each with a
 * display name, a short "N orders" meta line, and whether it's the current
 * selection. Order is preserved (getAccountSummaries is MRU-first).
 * @param {Array<{accountKey: string|null, orderCount?: number, newestOrderDate?: string}>} summaries
 * @param {{labels?: Object, ordinals?: Object, selected?: string|null}} [opts]
 * @returns {Array<{value: string, name: string, orderCount: number, newestOrderDate: string, selected: boolean}>}
 */
function buildAccountOptions(summaries = [], { labels = {}, ordinals = {}, selected = null } = {}) {
  return (summaries || []).map((summary) => {
    const value = accountSelectionValue(summary.accountKey);
    return {
      value,
      name: accountDisplayName(value, { labels, ordinals }),
      orderCount: summary.orderCount || 0,
      newestOrderDate: summary.newestOrderDate || '',
      selected: value === selected,
    };
  });
}

/**
 * Refresh the list heading row's two pieces of live-updating text (spec
 * v7.1 §B): "Select all N shown" (left) and "Orders (T) · M selected" /
 * "M selected · of T total" when a date-range filter is hiding rows
 * (right). `container` is #orderNumbersContainer; its `data-total-orders`
 * attribute (set by sidepanel.view.js on render) carries the unfiltered
 * total so this stays the one source of truth for both counts.
 */
function updateCheckboxCount(container) {
  const checked = container.querySelectorAll('input[type="checkbox"]:not(#selectAll):not(.month-select-checkbox):checked').length;
  const shown = container.querySelectorAll('input[type="checkbox"]:not(#selectAll):not(.month-select-checkbox)').length;
  const total = Number(container.dataset.totalOrders || shown);

  const selectAllLabel = container.querySelector('label[for="selectAll"]');
  if (selectAllLabel) {
    selectAllLabel.textContent = `Select all ${shown} shown`;
  }

  const countLine = container.querySelector('#listCountLine');
  if (countLine) {
    countLine.textContent =
      shown === total ? `${CONSTANTS.TEXT.SELECT_ORDERS} (${total}) · ${checked} selected` : `${checked} selected · of ${total} total`;
  }
}

/**
 * A non-interactive "saved" chip shown next to an order whose full invoice
 * is already stored in IndexedDB (spec §4.4: "the per-order badge becomes
 * an informational '✓ saved' chip — no longer a delete control"). The only
 * way to remove saved data is now Settings' "Delete all saved data"
 * (sidepanel.settings.js), so this renders no click handler at all.
 * @param {string} orderNumber - unused beyond the caller's own bookkeeping;
 *   kept as a parameter for call-site symmetry with the rest of this file.
 * @returns {HTMLElement}
 */
function createCacheIndicator(_orderNumber) {
  const cacheIndicator = document.createElement("span");
  cacheIndicator.dataset.cacheIndicator = "true";
  cacheIndicator.style.cssText = CACHE_INDICATOR_STYLE;
  cacheIndicator.title = "Full invoice saved on this device";
  cacheIndicator.innerHTML = `${renderIcon('CACHE', 'var(--primary)')}<span>saved</span>`;
  cacheIndicator.style.display = "inline-flex";
  return cacheIndicator;
}

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
 * Wrap a Chrome callback-style API in a Promise
 * @param {Function} invoker - Function that accepts a callback
 * @returns {Promise<any>} Promise resolving the callback result
 */
function chromeCallbackPromise(invoker) {
  return new Promise((resolve, reject) => {
    try {
      invoker((result) => {
        if (chrome?.runtime?.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

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
 * Minimal Promise wrappers for Chrome APIs used across the extension
 */
const ChromeApi = {
  runtimeSendMessage(message) {
    if (!chrome?.runtime?.sendMessage) {
      return Promise.reject(new Error('chrome.runtime.sendMessage not available'));
    }
    return chromeCallbackPromise((cb) => chrome.runtime.sendMessage(message, cb));
  },

  tabsQuery(queryInfo) {
    if (!chrome?.tabs?.query) {
      return Promise.reject(new Error('chrome.tabs.query not available'));
    }
    return chromeCallbackPromise((cb) => chrome.tabs.query(queryInfo, cb));
  },

  tabsCreate(createProperties) {
    if (!chrome?.tabs?.create) {
      return Promise.reject(new Error('chrome.tabs.create not available'));
    }
    return chromeCallbackPromise((cb) => chrome.tabs.create(createProperties, cb));
  },

  tabsUpdate(tabId, updateProperties) {
    if (!chrome?.tabs?.update) {
      return Promise.reject(new Error('chrome.tabs.update not available'));
    }
    return chromeCallbackPromise((cb) => chrome.tabs.update(tabId, updateProperties, cb));
  },

  tabsGet(tabId) {
    if (!chrome?.tabs?.get) {
      return Promise.reject(new Error('chrome.tabs.get not available'));
    }
    return chromeCallbackPromise((cb) => chrome.tabs.get(tabId, cb));
  },

  tabsRemove(tabId) {
    if (!chrome?.tabs?.remove) {
      return Promise.reject(new Error('chrome.tabs.remove not available'));
    }
    return chromeCallbackPromise((cb) => chrome.tabs.remove(tabId, cb));
  },

  tabsSendMessage(tabId, message) {
    if (!chrome?.tabs?.sendMessage) {
      return Promise.reject(new Error('chrome.tabs.sendMessage not available'));
    }
    return chromeCallbackPromise((cb) => chrome.tabs.sendMessage(tabId, message, cb));
  },

  storageGet(keys) {
    if (!chrome?.storage?.local?.get) {
      return Promise.reject(new Error('chrome.storage.local.get not available'));
    }
    return chromeCallbackPromise((cb) => chrome.storage.local.get(keys, cb));
  },

  storageSet(items) {
    if (!chrome?.storage?.local?.set) {
      return Promise.reject(new Error('chrome.storage.local.set not available'));
    }
    return chromeCallbackPromise((cb) => chrome.storage.local.set(items, cb));
  },

  storageRemove(keys) {
    if (!chrome?.storage?.local?.remove) {
      return Promise.reject(new Error('chrome.storage.local.remove not available'));
    }
    return chromeCallbackPromise((cb) => chrome.storage.local.remove(keys, cb));
  },
};

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
 * Invoice storage helpers (storage unification, spec §4.1)
 *
 * Invoices used to be duplicated into a chrome.storage.local
 * "walmart_invoice_cache" blob with its own 24h TTL and a quota-recovery
 * path that could silently replace the whole cache with a single order.
 * That entire layer is retired: IndexedDB (OrderDb, see orderdb.js) is now
 * the single source of truth for downloaded invoices — see
 * OrderDataFetcher.fetchOrderData in sidepanel.download.js for the
 * IndexedDB-first fetch path that replaces getCachedInvoice/cacheInvoice.
 *
 * getCachedOrderNumbers is kept (as a DB-backed read) because the per-order
 * "✓ saved" badge (createCacheIndicator, above — now informational-only,
 * spec §4.4) still needs to know which orders have a stored invoice. Bulk
 * deletion lives in one place now: Settings' "Delete all saved data"
 * (sidepanel.settings.js), which calls OrderDb.clearAll() directly — the
 * old per-order/bulk chrome.storage invoice-cache deletion helpers
 * (deleteInvoiceCache, clearAllInvoiceCache) had nothing left to delete and
 * are removed. A one-time migration folds any surviving walmart_invoice_cache
 * data into OrderDb (see migrateLegacyStorage).
 */

/**
 * Which orders have a full invoice stored durably in IndexedDB. Powers the
 * per-order "✓ saved" badge — replaces the old chrome.storage cache scan.
 * @returns {Promise<string[]>} order numbers with a stored invoice
 */
async function getCachedOrderNumbers() {
  try {
    const records = await OrderDb.getAllOrders();
    return records.filter((record) => record && record.invoice).map((record) => record.orderNumber);
  } catch (error) {
    console.warn('Order DB unavailable for cached-order lookup:', error);
    return [];
  }
}

/**
 * One-time, idempotent migration off the retired chrome.storage.local
 * caches (spec §4.5). Call on every panel/background init — it is a cheap
 * no-op once both legacy keys are gone (a single chrome.storage.local.get
 * for two keys). Folds any surviving walmart_invoice_cache entries into
 * OrderDb (an upsert — safe even if that order is already stored, e.g. a
 * previous partial migration), then removes both walmart_invoice_cache and
 * walmart_order_cache. Never touches settings keys (exportMode/
 * exportFormat/csvPreset/includeThumbnails/incrementalCollect) — a later
 * phase consolidates those. Safe (a no-op) when both keys are already
 * absent.
 * @returns {Promise<void>}
 */
async function migrateLegacyStorage() {
  try {
    const legacyKeys = [CONSTANTS.CACHE_KEYS.INVOICE, CONSTANTS.CACHE_KEYS.ORDER_COLLECTION];
    const result = await ChromeApi.storageGet(legacyKeys);

    const legacyInvoiceCache = result[CONSTANTS.CACHE_KEYS.INVOICE];
    if (legacyInvoiceCache && typeof legacyInvoiceCache === 'object') {
      for (const [orderNumber, cached] of Object.entries(legacyInvoiceCache)) {
        // The legacy shape is always { data: invoiceObject, timestamp } —
        // reject anything else (e.g. a cleared/malformed { data: null }
        // entry) rather than guessing and storing garbage as an invoice.
        const invoiceData = cached && cached.data && typeof cached.data === 'object' ? cached.data : null;
        if (!orderNumber || !invoiceData) continue;
        try {
          await OrderDb.putInvoice(orderNumber, invoiceData);
        } catch (error) {
          console.warn(`Legacy storage migration: failed to move invoice #${orderNumber} to the order DB:`, error);
        }
      }
    }

    const keysToRemove = legacyKeys.filter((key) => Object.prototype.hasOwnProperty.call(result, key));
    if (keysToRemove.length > 0) {
      await ChromeApi.storageRemove(keysToRemove);
      console.log(`Legacy storage migration: removed ${keysToRemove.join(', ')}`);
    }
  } catch (error) {
    console.warn('Legacy storage migration failed (non-fatal):', error);
  }
}
