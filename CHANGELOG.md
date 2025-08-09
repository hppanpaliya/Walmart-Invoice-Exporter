# Changelog

## [3.2] - August 9, 2025

- **Feature:** Added Export mode selector (Multiple files or Single combined file)
  - New option in the popup to choose between downloading one XLSX per order or a single XLSX containing all selected orders
  - Combined export is processed sequentially in one background tab for reliability
  - Uses ExcelJS in the popup to generate a single workbook with all items
- **Enhancement:** Content script now supports structured data retrieval (no download) to power combined export
- **Note:** Existing multiple-file download flow remains unchanged

## [3.1] - March 25, 2025

- **Enhancement:** Added order description tooltip functionality
  - Hover over order numbers to see order delivery date or if it's canceled or returned order
  - Displays order delivery date from order history without downloading the order invoice
  - Makes identifying and selecting specific orders much easier

## [3.0] - March 25, 2025

- **Feature:** Implemented session storage caching system
  - Automatically stores previously collected order numbers
  - Dramatically improves loading time for repeat usage
  - Shows cache timestamp and source information
  - Includes option to clear cache when fresh data is needed
  - Cache automatically expires after 24 hours
- **Enhancement:** Improved memory management during order collection
- **Enhancement:** Updated FAQ with information about the caching system

## [2.5] - January 5, 2025

- **Enhancement:** Improved performance by blocking image loading in background tabs
  - Faster page loading during order collection and invoice download
  - Reduced network usage

## [2.4] - January 5, 2025

- **Enhancement:** Feature: Added comprehensive FAQ page with troubleshooting guides
  - Step-by-step instructions for single and batch downloads
  - Chrome settings configuration guide for bulk downloads
  - Common issues and solutions
  - Guide for merging multiple Excel files

## [2.3] - December 19, 2024

- **Fixed:** Resolved an issue with failed invoice downloads for new in-store orders.

## [2.2] - December 5, 2024

- **Enhancement:** Walmart orders page link clickable in popup.

## [2.1] - December 1, 2024

- **Enhancement:** Improved UI.

## [2.0] - November 26, 2024

- **Feature:** Added support for downloading multiple invoices at once.
- **Feature:** Introduced new order history crawler.
- **Update:** Improved invoice downloading system.
- **Enhancement:** Enhanced user interface with progress tracking.

## [1.4.1] - August 30, 2024

- **Update:** Improved order number extraction to handle various formats, including in-store purchases.

## [1.4] - August 29, 2024

- **Enhancement:** Improved invoice parsing using print-bill classes for better order delivery status accuracy.
- **Feature:** Added tip, tax, and delivery charges to the exported invoice.
- **Update:** Separated product name and links into different columns in the Excel file.

## [1.3] - August 27, 2024

- **Fixed:** Resolved an issue where xlsx invoice files were not downloading.
- **Update:** Changed the extension name to Walmart Invoice Exporter.
