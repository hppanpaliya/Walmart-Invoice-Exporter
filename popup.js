document.addEventListener("DOMContentLoaded", function () {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs[0];
    var url = tab.url;

    if (!url.startsWith("https://www.walmart.com/orders/") || url === "https://www.walmart.com/orders/") {
      document.body.innerHTML =
        '<p>You must be on a page that starts with "https://www.walmart.com/orders/{Order-Number}" to use this extension.</p>';
    } else {
      document.getElementById("downloadInvoice").addEventListener("click", function () {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          chrome.tabs.sendMessage(tabs[0].id, { method: "changeColor" }, function (response) {
            console.log(response.data);
          });
        });
      });
    }
  });
});
