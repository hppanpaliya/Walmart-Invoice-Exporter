# Walmart Invoice Exporter

A Chrome extension that allows users to download their Walmart order history in XLSX format. Now with enhanced performance and optimized batch downloading capabilities!

<img src="./screenshot.webp" alt="Screenshot of extension" height="200">

## Features

- **Batch Download**: Select and download multiple order invoices at once
- **Page Crawling**: Automatically collect order numbers from your order history
- **Smart Image Blocking**: Automatically blocks images during processing to improve speed
- **Customizable Limits**: Set how many pages of order history to crawl
- **Detailed Excel Format**: Each invoice includes:
  - Product details (name, quantity, price)
  - Delivery status
  - Product links
  - Order information (number, date)
  - Additional charges (delivery, tax, tip)
- **Secure & Efficient**: Runs only on Walmart's orders pages with minimal required permissions

## Technical Details

- Uses Chrome's Manifest V3
- Requires `ActiveTabs` permission
- Compatible with various Walmart order formats:
  - Regular orders (13 or 15 digits)
  - In-store purchases (20+ digits)
- Implements ExcelJS for XLSX generation
- Features smart image blocking for performance
- Handles bulk downloads with proper throttling

## Performance Features

- **Image Blocking**: Automatically prevents image loading to speed up page processing
- **Memory Optimization**: Cleans up resources after each order download
- **Background Processing**: Efficient handling of multiple downloads
- **Smart Retries**: Automatically attempts different URL formats for failed downloads

## Limitations

- Works only on Walmart's order pages
- Download speed may vary based on network conditions
- Large batch downloads may take several minutes to complete
- Requires stable and fast internet connection for bulk downloads

## Installation

### From Chrome Web Store

Install the Walmart Invoice Exporter directly from the [Chrome Web Store](https://chromewebstore.google.com/detail/walmart-invoice-exporter/bndkihecbbkoligeekekdgommmdllfpe).

### Manual Installation

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" in the top-right corner
4. Click "Load unpacked" and select the extension directory
5. Pin the extension to your toolbar for easy access

## What's New

### [Changelog](./CHANGELOG.md)

## Usage

### Single Order Download

1. Navigate to a specific Walmart order page
2. Click the extension icon
3. Click "Download Invoice"

### Batch Download

1. Go to your Walmart order history page (https://www.walmart.com/orders)
2. Click the extension icon
3. Set the number of pages to crawl (0 = unlimited)
4. Click "Start Collection"
5. Wait for the order numbers to load (may take a few seconds)
6. Select the orders you want to download
7. Click "Download Selected Orders"
8. Wait for the downloads to complete

## Troubleshooting

### Required Chrome Settings for Downloads

Before using the download feature, make sure to configure Chrome settings:

#### 1. Configure Download Settings:

- Open Chrome Settings or paste the following link in the address bar:

```
chrome://settings/downloads
```

- Click on "Downloads" in the left sidebar if not already selected
- Turn OFF "Ask where to save each file before downloading"
- Turn OFF "Show downloads when they're done"

#### 2. Enable Automatic Downloads:

```
chrome://settings/content/siteDetails?site=https%3A%2F%2Fwww.walmart.com#:~:text=Automatic%20downloads
```

- Open a new Chrome tab and paste the above link
- Find "Automatic downloads" option
- Set it to "Allow" (instead of Ask or Block)

#### Alternative Method: (If the above link doesn't work):

```
chrome://settings/content/automaticDownloads
```

- Open a new Chrome tab and paste the above link
- Under "**Allowed to automatically download multiple files**", click Add
- Enter `[*.]walmart.com` and click Add

> **Important**: All these settings are required for bulk downloads to work properly. Make sure to add walmart.com under "**Allowed to automatically download multiple files**" and NOT under "Not allowed to automatically download multiple files"

If you still encounter issues:

1. Read FAQs in the extension popup for common problems
2. Check that the extension has necessary permissions
3. Try refreshing the page before downloading
4. For batch downloads, try processing fewer orders at once

If you're still facing issues, please submit a detailed bug report.

## Performance Tips

For best results when batch downloading:

1. Close unnecessary browser tabs
2. Start with smaller batches (5-10 orders)
3. Ensure stable and fast internet connection
4. Allow the extension to complete its process without switching tabs or changing windows
5. Keep the popup window open during downloads

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Submit a Pull Request

## License

MIT License - feel free to use and modify as needed.

## Support

For issues or feature requests, please:

1. Check existing issues in the repository
2. Submit a new issue if needed
3. Include specific details about the problem

## Privacy

This extension:

- Only runs on Walmart order pages
- Doesn't collect any personal data
- Processes all information locally
- Doesn't send data to external servers
- Only blocks images for performance optimization

## Acknowledgments

Special thanks to all the users who provided feedback for making this extension more efficient and user-friendly.
