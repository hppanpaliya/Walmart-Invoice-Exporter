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
        text: item.productName && item.productName.length > 60 
          ? item.productName.substring(0, 60) + "..." 
          : item.productName,
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
        text: item.productName && item.productName.length > 60 
          ? item.productName.substring(0, 60) + "..." 
          : item.productName,
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
