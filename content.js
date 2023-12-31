chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.method == "changeColor") {
    var productNames = document.querySelectorAll("div[data-testid='productName'] span");
    var productPrices = document.querySelectorAll(".f5.b.black.tr span[aria-hidden='false']");
    var unavailableProducts = Array.from(
      document
        .querySelector("span.w_yTSq.f5.b.dark-gray.w_0aYG.w_MwbK")
        .parentElement.nextElementSibling.querySelectorAll("div[data-testid='productName'] span")
    ).map((el) => el.innerText);

    var data = [];
    data.push(["Product Name", "Price", "Delivery Status"]); // Add header to data array

    for (var i = 0; i < productNames.length; i++) {
      var productName = productNames[i].innerText;
      var productPrice = productPrices[i].innerText;
      var deliveryStatus = unavailableProducts.includes(productName) ? "Delivered" : "Not Delivered";

      data.push([productName, productPrice, deliveryStatus]); // Add rows to data array
    }

    var orderNumber = document
      .querySelector(".f6.f-subheadline-m.mid-gray.dark-gray-m.lh-copy.v-mid.mt2.mt0-m.print-bill-bar-id")
      .innerText.split(" ")[1];

    var orderDate = document
      .querySelector(".w_kV33.w_LD4J.w_mvVb.f3.f-subheadline-m.di-m.dark-gray-m.print-bill-date.lh-copy")
      .innerText.split(" ")
      .slice(0, 3)
      .join(" ");

    var orderTotal = document.querySelector(".bill-order-total-payment h2:last-child").innerText;

    data.push([]);
    data.push([]);

    data.push(["Order Total", orderTotal]);
    data.push(["Order Number", orderNumber]);
    data.push(["Order Date", orderDate]);

    /* XLSX version */
    var ws = XLSX.utils.aoa_to_sheet(data);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    // fit text to cell
    ws["!cols"] = [{ width: 100 }, { width: 10 }, { width: 10 }];

    /* generate an XLSX file */
    XLSX.writeFile(wb, `${orderNumber.toString()}.xlsx`);

    sendResponse({ data: data });
  }
});
