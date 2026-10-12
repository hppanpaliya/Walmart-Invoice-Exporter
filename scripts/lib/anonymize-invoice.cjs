'use strict';
const { chromium } = require('playwright');
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const FIXTURE_ORDER_ID = '200010000000042';

// Runs only in a blank, isolated browser. Source HTML is parsed as an inert
// document; scripts, handlers, styles, resources, and unknown text never copy.
function sanitizeDocument({ html, id }) {
  const source = new DOMParser().parseFromString(html, 'text/html');
  const output = document.implementation.createHTMLDocument('Anonymized invoice fixture');
  const classes = new Set(('dn flex justify-between items-center mb3 tr mt3 pb2 pb3 pt3 strike ld_Ec ' +
    'print-bill-group print-items-list print-item-title bill-item-quantity print-bill-type print-bill-qty print-bill-price ' +
    'print-bill-date print-bill-bar-id print-bill-payment-section bill-order-payment-info bill-order-payment-spacing ' +
    'bill-order-payment-subtotal bill-order-total-payment print-fees-item w_U9_0 w_sD6D w_QcqU').split(' '));
  const testids = new Set(['itemtile-stack', 'productName', 'line-price', 'orderInfoCard']);
  const tags = new Set(['DIV', 'SECTION', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'SPAN', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'A', 'UL', 'LI', 'TABLE', 'TBODY', 'TR', 'TD', 'STRONG', 'SMALL', 'B', 'S', 'DEL']);
  const cardIds = new Map();
  let product = 0;
  const safeText = value => {
    const text = value.replace(/\s+/g, ' ').trim();
    if (/^-?\$\d[\d,]*(?:\.\d{1,2})?$/.test(text)) return text;
    if (/^(?:Savings|Subtotal|Tax|Taxes|Bag fee|Driver tip|Tip|Total|Order total|Temporary adjusted total|Delivery from store|Free delivery from store|Express delivery|Walmart Cash|Visa|Mastercard|American Express|Discover|Gift card)$/i.test(text)) return text;
    if (/^Items \(\d{1,4}\)$/.test(text)) return text;
    if (/^(?:\d{1,4}\s+)?(?:unavailable|canceled|cancelled)(?:\s+items?)?$/i.test(text)) return text;
    if (/^\d{1,4}\s+(?:unavailable|canceled|cancelled|items? (?:delivered|shopped|weight adjusted))$/i.test(text)) return text;
    if (/^Delivered on\b/i.test(text)) return 'Delivered on Jan 15';
    return '';
  };
  function copy(node) {
    if (node.nodeType === Node.TEXT_NODE) return output.createTextNode(safeText(node.nodeValue));
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    if (node.tagName === 'IMG') {
      const brand = safeText(node.getAttribute('alt') || node.getAttribute('data-wie-image-alt') || '');
      if (!brand) return null;
      const label = output.createElement('span');
      label.hidden = true;
      label.setAttribute('data-wie-image-alt', brand);
      return label;
    }
    if (!tags.has(node.tagName)) return null;
    const result = output.createElement(node.tagName.toLowerCase());
    const keptClasses = [...node.classList].filter(value => classes.has(value));
    if (keptClasses.length) result.className = keptClasses.join(' ');
    const testid = node.getAttribute('data-testid');
    if (testids.has(testid)) result.setAttribute('data-testid', testid);
    if (node.hasAttribute('data-wie-image-alt')) {
      const brand = safeText(node.getAttribute('data-wie-image-alt'));
      if (brand) result.setAttribute('data-wie-image-alt', brand);
      result.hidden = true;
    }
    if (node.matches('[aria-labelledby^="card-description-"]')) {
      const originalId = node.getAttribute('aria-labelledby');
      if (!cardIds.has(originalId)) cardIds.set(originalId, cardIds.size);
      result.setAttribute('aria-labelledby', `card-description-${cardIds.get(originalId)}`);
      result.textContent = /walmart cash/i.test(node.textContent) ? 'Walmart Cash' : 'Ending in 0000';
      return result;
    }
    if (node.matches('.bill-item-quantity, .print-bill-qty')) {
      const quantity = node.textContent.match(/\d+(?:\.\d+)?/)?.[0];
      result.textContent = quantity ? `Qty ${quantity}` : '';
      return result;
    }
    if (testid === 'productName' || node.matches('.dn.print-items-list > .flex.justify-between > div:first-child')) {
      result.textContent = `Captured product ${++product}`;
      return result;
    }
    if (node.matches('a[link-identifier="itemClick"]')) {
      result.setAttribute('link-identifier', 'itemClick');
      result.setAttribute('href', `/ip/${1000 + product}`);
    }
    for (const child of node.childNodes) {
      const sanitized = copy(child);
      if (sanitized) result.appendChild(sanitized);
    }
    return result;
  }
  for (const [className, value] of [['print-bill-date', 'Jan 15, 2026 order'], ['print-bill-bar-id', `Order# ${id}`]]) {
    const element = output.createElement('div');
    element.className = className;
    element.textContent = value;
    output.body.appendChild(element);
  }
  const groups = source.querySelectorAll('.print-bill-group');
  for (const original of groups) {
    if (original.parentElement?.closest('.print-bill-group')) continue;
    output.body.appendChild(copy(original));
  }
  // Some legacy receipts have no print-bill-group wrapper.
  for (const original of source.querySelectorAll('.dn.print-items-list')) {
    if (!original.closest('.print-bill-group')) output.body.appendChild(copy(original));
  }
  const payment = output.createElement('div');
  payment.className = 'print-bill-payment-section';
  for (const original of source.querySelectorAll('.bill-order-payment-info, .bill-order-payment-spacing, .bill-order-total-payment, .bill-order-payment-subtotal, .print-fees-item')) {
    if (original.parentElement?.closest('.bill-order-payment-info, .bill-order-payment-spacing')) continue;
    payment.appendChild(copy(original));
  }
  output.body.appendChild(payment);
  if (!output.querySelector('[data-testid="itemtile-stack"], .dn.print-items-list')) throw new Error('Capture contains no supported invoice item layout');
  return '<!doctype html>\n' + output.documentElement.outerHTML + '\n';
}

async function anonymizeInvoice(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_CAPTURE_BYTES) throw new Error('Capture must be HTML no larger than 8 MiB');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    return await page.evaluate(sanitizeDocument, { html, id: FIXTURE_ORDER_ID });
  } finally { await browser.close(); }
}

module.exports = { anonymizeInvoice, MAX_CAPTURE_BYTES, FIXTURE_ORDER_ID };
