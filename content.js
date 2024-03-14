chrome.runtime.onMessage.addListener(async function (request, sender, sendResponse) {
  if (request.method === "downloadXLSX") {
    let productNames = document.querySelectorAll("div[data-testid='productName'] span"); // Select all product names
    let productQuantities = document.querySelectorAll(".pt1.f7.f6-m.bill-item-quantity"); // Select all product quantities
    let productPrices = document.querySelectorAll(".f5.b.black.tr span[aria-hidden='false']"); // Select all product prices

    let unavailableProductsEl = document.querySelectorAll("img.o-30"); // Select all unavailable products element (products with an opacity of 30%)
    let unavailableProductNames = []; // Array to store the names of unavailable products
    unavailableProductsEl.forEach((img) => {
      let productNameEl = img.closest("div.flex-m").querySelector("div[data-testid='productName'] span"); // Select the product name of the unavailable product
      if (productNameEl) unavailableProductNames.push(productNameEl.innerText);
    });

    // f7 f5-m gray print-item-title has the a tag for the product link

    let productLinkEl = document.querySelectorAll(".f7.f5-m.gray.print-item-title a"); // Select all product links
    let productLinks = []; // Array to store the product links
    productLinkEl.forEach((link) => {
      productLinks.push(link.href);
    });

    // Select the order number
    let orderNumber = document
      .querySelector(".f6.f-subheadline-m.mid-gray.dark-gray-m.lh-copy.v-mid.mt2.mt0-m.print-bill-bar-id")
      .innerText.split(" ")[1];
    // Select the order date
    let orderDate = document
      .querySelector(".w_kV33.w_LD4J.w_mvVb.f3.f-subheadline-m.di-m.dark-gray-m.print-bill-date.lh-copy")
      .innerText.split(" ")
      .slice(0, 3)
      .join(" ");
    // Select the order total
    let orderTotal = document.querySelector(".bill-order-total-payment h2:last-child").innerText;

    let data = [];

    // Loop through the product names and add the product name, quantity, price, and delivery status to the data array
    productNames.forEach((item, index) => {
      let productName = item.innerText;
      let productPrice = productPrices[index] ? productPrices[index].innerText : "N/A";
      let deliveryStatus = unavailableProductNames.includes(productName) ? "Not Delivered" : "Delivered";
      let productQuantity = productQuantities[index] ? productQuantities[index].innerText.split(" ")[1] : "N/A";
      data.push([productName, productQuantity, productPrice, deliveryStatus]);
    });

    // Store order details in an object to pass to the convertToXlsx function
    let orderDetails = {
      orderNumber: orderNumber,
      orderDate: orderDate,
      orderTotal: orderTotal,
    };

    // Call the convertToXlsx function and pass the data and orderNumber as arguments
    convertToXlsx(data, orderDetails, ExcelJS, productLinks);

    sendResponse({ data: data });
  }
});

async function convertToXlsx(data, orderDetails, ExcelJS, productLinks) {
  // Create a new Excel workbook and worksheet using the ExcelJS library
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Order Invoice");

  let headerFontStyle = { size: 12, bold: true, name: "Times New Roman" }; // Set header row font style
  let productFontStyle = { size: 12, name: "Times New Roman" }; // Set product row font style

  // Set header row and column width
  worksheet.columns = [
    { header: "Product Name", key: "productName", width: 60 },
    { header: "Quantity", key: "quantity", width: 20, style: { numFmt: "#,##0", alignment: { horizontal: "left" } } },
    { header: "Price", key: "price", width: 20, style: { numFmt: "$#,##0.00", alignment: { horizontal: "left" } } },
    { header: "Delivery Status", key: "deliveryStatus", width: 20 },
  ];

  // Add data rows to the worksheet
  data.forEach((row) => {
    row[1] = Number(row[1].replace(/[^0-9.-]+/g, "")); // Remove non-numeric characters from the quantity
    row[2] = Number(row[2].replace(/[^0-9.-]+/g, "")); // Remove non-numeric characters from the price
    worksheet.addRow(row).font = { size: 12 };
  });

  // add hyperlinks to the product names
  productLinks.forEach((link, index) => {
    worksheet.getCell(index + 2, 1).value = {
      text: data[index][0],
      hyperlink: link,
    };
    worksheet.getCell(index + 2, 1).font = { size: 12 };
  });

  // Set font style for all cells
  worksheet.eachRow(function (row, rowNumber) {
    row.eachCell(function (cell, colNumber) {
      cell.font = productFontStyle;
    });
  });

  // Set header row style
  worksheet.getRow(1).eachCell(function (cell, colNumber) {
    cell.font = headerFontStyle;
  });

  worksheet.addRow([]); // Add an empty row between the product details and order details for better readability

  // Add order details to the worksheet
  let total = worksheet.addRow(["Order Total", Number(orderDetails.orderTotal.replace(/[^0-9.-]+/g, ""))]);
  worksheet.addRow(["Order Number", orderDetails.orderNumber]).font = { ...productFontStyle, bold: true };
  worksheet.addRow(["Order Date", orderDetails.orderDate]).font = { ...productFontStyle, bold: true };

  // Set font style for order total row and change order total to currency format using the numFmt property
  total.eachCell(function (cell, colNumber) {
    cell.font = { ...productFontStyle, bold: true };
    cell.numFmt = "$#,##0.00";
  });

  // Generate Excel file and trigger download in the browser
  workbook.xlsx.writeBuffer().then(function (buffer) {
    let blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    let url = window.URL.createObjectURL(blob);
    let anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `Order_${orderDetails.orderNumber}.xlsx`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    window.URL.revokeObjectURL(url);
  });
}
