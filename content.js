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
    // Array to store all order items
    let orderItems = [];

    // Select all elements representing the print items list
    let printItemsList = document.querySelectorAll(".dn.print-items-list");

    // Loop through each item in the print items list
    printItemsList.forEach((item) => {
      let productName = item.querySelector(".w_U9_0.w_sD6D.w_QcqU")?.innerText;
      let deliveryStatus = item.querySelector(".print-bill-type .w_U9_0.w_sD6D.w_QcqU")?.innerText || "Delivered";
      let quantity = item.querySelector(".print-bill-qty .w_U9_0.w_sD6D.w_QcqU")?.innerText;
      let price = item.querySelector(".print-bill-price .w_U9_0.w_sD6D.w_QcqU")?.innerText;

      // Find the corresponding visible item to get the product link
      let productLink = "N/A";
      let visibleItems = document.querySelectorAll('[data-testid="itemtile-stack"] [data-testid="productName"] span');
      for (let visibleItem of visibleItems) {
        if (visibleItem?.innerText.trim() === productName.trim()) {
          let linkElement = visibleItem.closest('[data-testid="itemtile-stack"]').querySelector('a[link-identifier="itemClick"]');
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
        ".f-subheadline-m.dark-gray-m.print-bill-bar-id",
        "[data-testid='orderInfoCard'] .dark-gray",
        ".print-bill-heading .dark-gray",
        ".print-bill-bar-id",
      ];

      for (let selector of selectors) {
        const element = document.querySelector(selector);
        if (element) {
          const text = element.textContent;
          const match = text.match(/#\s*([\d-]+)/);
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
    let orderDate = document.querySelector(".print-bill-date")?.innerText;
    orderDate = orderDate.replace("order", "").trim();
    let orderTotal = document.querySelector(".bill-order-total-payment h2:last-child")?.innerText;
    let deliveryCharges = document.querySelector(".print-fees")?.innerText || "$0.00";
    let tax = document.querySelector(".print-bill-payment-section .pv3 .w_U9_0.w_U0S3.w_QcqU:last-child")?.innerText || "$0.00";
    let tip =
      document.querySelector(".print-bill-payment-section .flex.justify-between.pb2.pt3 .w_U9_0.w_U0S3.w_QcqU:last-child")?.innerText || "$0.00";

    // Check if the order number was found
    if (orderNumber) {
      console.log("Order number:", orderNumber);
    } else {
      console.log("Could not find order number");
    }

    // Collect all order details
    let orderDetails = {
      orderNumber,
      orderDate,
      orderTotal,
      deliveryCharges,
      tax,
      tip,
      items: orderItems,
    };

    // Convert the order details to an XLSX file using the convertToXlsx function
    convertToXlsx(orderDetails, ExcelJS);

    // Send the response back to the caller with the order details
    sendResponse({ data: orderDetails });
  }
  return true;
});

async function handleCollectOrderNumbers() {
  try {
    await waitForElement("h1.w_kV33.w_LD4J.w_mvVb");

    const { orderNumbers, additionalFields } = extractOrderNumbers();
    const hasNextPage = await checkForNextPage();

    console.log(`Extracted ${orderNumbers.length} order numbers. Has next page: ${hasNextPage}`);
    return { orderNumbers, additionalFields, hasNextPage };
  } catch (error) {
    console.error("Error during collection:", error);
    return { orderNumbers: [], additionalFields: {}, hasNextPage: false };
  }
}

async function handleClickNextButton() {
  try {
    // Wait for the Purchase history heading first
    await waitForElement("h1.w_kV33.w_LD4J.w_mvVb");

    // Then wait for the next button to be present and clickable
    const nextButton = await waitForElement('button[data-automation-id="next-pages-button"]:not([disabled])');

    nextButton.click();
    return { success: true };
  } catch (error) {
    console.error("Error clicking next button:", error);
    return { success: false };
  }
}

function extractOrderNumbers() {
  const orderElements = document.querySelectorAll(
    "#maincontent > main > section > div.flex.relative-m > div.w-100.di-m.flex-auto > div > section > div > div > div > div.w_udHt.w_CEpt.bg-near-white-primary.pv3.mv0 > span.w_kV33.w_Sl3f.w_mvVb.w_E5rV > h2 > span"
  );
  console.log(`Found ${orderElements.length} order elements`);
  const orderNumbers = [];
  const additionalFields = {}; // Map order number to additional field

  orderElements.forEach((element) => {
    const match = element.textContent.trim().match(/#\s*([\d-]+)/);
    if (match && match[1]) {
      const orderNumber = match[1];
      orderNumbers.push(orderNumber);

      // Try to find the additional field for this order
      let container = element.closest("div.w_udHt.w_CEpt");
      if (container) {
        const parentContainer = container.parentElement.parentElement;
        const additionalFieldElement = parentContainer.querySelector("h3.w_kV33.w_Sl3f.w_mvVb.f3");
        if (additionalFieldElement) {
          additionalFields[orderNumber] = additionalFieldElement.textContent.trim();
        }
      }
    }
  });

  return { orderNumbers, additionalFields };
}

async function checkForNextPage() {
  try {
    // Wait for the Purchase history heading first
    await waitForElement("h1.w_kV33.w_LD4J.w_mvVb");

    // Then check for the next button
    const nextButton = document.querySelector('button[data-automation-id="next-pages-button"]:not([disabled])');
    return !!nextButton;
  } catch (error) {
    console.error("Error checking for next page:", error);
    return false;
  }
}

// Function to convert order details to an XLSX file
async function convertToXlsx(orderDetails, ExcelJS) {
  // Create a new Excel workbook and worksheet
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Order Invoice");

  // Define font styles for headers and product details
  let headerFontStyle = { size: 12, bold: true, name: "Times New Roman" };
  let productFontStyle = { size: 12, name: "Times New Roman" };

  // Set worksheet columns with headers, keys, and styles
  worksheet.columns = [
    { header: "Product Name", key: "productName", width: 60 },
    { header: "Quantity", key: "quantity", width: 20, style: { numFmt: "#,##0", alignment: { horizontal: "center" } } },
    { header: "Price", key: "price", width: 20, style: { numFmt: "$#,##0.00", alignment: { horizontal: "center" } } },
    { header: "Delivery Status", key: "deliveryStatus", width: 30, style: { alignment: { horizontal: "center" } } },
    { header: "Product Link", key: "productLink", width: 60, style: { font: { color: { argb: "FF0000FF" }, underline: true } } },
  ];

  // Add each order item as a row in the worksheet
  orderDetails.items.forEach((item) => {
    worksheet.addRow({
      productName: item.productName,
      productLink: { text: item.productName.length > 60 ? item.productName.substring(0, 60) + "..." : item.productName, hyperlink: item.productLink },
      quantity: Number(item.quantity.replace(/[^0-9.-]+/g, "")),
      price: Number(item.price.replace(/[^0-9.-]+/g, "")),
      deliveryStatus: item.deliveryStatus,
    }).font = productFontStyle;
  });

  // Apply product font style to all cells
  worksheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.font = productFontStyle;
    });
    const cell = row.getCell("productLink");
    cell.font = { color: { argb: "FF0000FF" }, underline: true };
  });

  // Apply header font style to the first row (header row)
  worksheet.getRow(1).eachCell((cell) => {
    cell.font = headerFontStyle;
  });

  // Add an empty row between product details and order details for clarity
  worksheet.addRow([]);

  // Add order details to the worksheet
  worksheet.addRow(["Order Number", orderDetails.orderNumber]).font = { ...productFontStyle, bold: true };
  worksheet.addRow(["Order Date", orderDetails.orderDate]).font = { ...productFontStyle, bold: true };
  let deliveryCharges = worksheet.addRow(["Delivery Charges", Number(orderDetails.deliveryCharges.replace(/[^0-9.-]+/g, ""))]);
  let tax = worksheet.addRow(["Tax", Number(orderDetails.tax.replace(/[^0-9.-]+/g, ""))]);
  let tip = worksheet.addRow(["Tip", Number(orderDetails.tip.replace(/[^0-9.-]+/g, ""))]);
  let total = worksheet.addRow(["Order Total", Number(orderDetails.orderTotal.replace(/[^0-9.-]+/g, ""))]);

  const styleCells = [deliveryCharges, tax, tip, total];
  styleCells.forEach((row) => {
    row.getCell(2).numFmt = "$#,##0.00  ";
    row.getCell(2).font = { ...productFontStyle, bold: true };
    row.getCell(1).font = { ...productFontStyle, bold: true };
    row.getCell(2).alignment = { horizontal: "center" };
  });

  // Generate the Excel file and trigger download in the browser
  const buffer = await workbook.xlsx.writeBuffer();
  let blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  let url = window.URL.createObjectURL(blob);
  let anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `Order_${orderDetails.orderNumber}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.URL.revokeObjectURL(url);
}
