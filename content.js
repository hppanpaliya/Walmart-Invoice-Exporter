/**
 * Content script for Walmart Invoice Exporter
 *
 * Provider-agnostic content host: blocks images on order pages and routes
 * background messages to the provider adapter that owns this hostname (see
 * providers/registry.js). All site-specific extraction now lives in the
 * adapter (providers/walmart-us.js).
 */
const ImageBlocker = (() => {
  let observer = null;
  let errorHandlerBound = false;
  const originalSetAttribute = HTMLImageElement.prototype.setAttribute;
  const CSP_META_SELECTOR = 'meta[data-wie-img-csp="true"]';

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
        rules.forEach((rule) => {
          if (rule.style && rule.style.backgroundImage) {
            rule.style.backgroundImage = "none";
          }
        });
      } catch (e) {
        // Handle cross-origin stylesheet errors silently
      }
    });
  }

  function ensureCspMeta() {
    if (document.querySelector(CSP_META_SELECTOR)) {
      return;
    }
    const meta = document.createElement("meta");
    meta.setAttribute("http-equiv", "Content-Security-Policy");
    meta.setAttribute("content", "img-src 'none'");
    meta.setAttribute("data-wie-img-csp", "true");
    document.head.appendChild(meta);
  }

  function blockImageLoading() {
    // Override Image constructor to prevent new image loading
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
    ensureCspMeta();

    // Prevent loading through srcset
    HTMLImageElement.prototype.setAttribute = new Proxy(originalSetAttribute, {
      apply(target, thisArg, argumentsList) {
        const [attr] = argumentsList;
        if (attr === "src" || attr === "srcset") {
          return;
        }
        return Reflect.apply(target, thisArg, argumentsList);
      },
    });

    // Disconnect existing observer if any to prevent memory leaks
    if (observer) {
      observer.disconnect();
    }

    // Intercept image loading with optimized MutationObserver
    // Only monitor childList changes to reduce CPU overhead
    observer = new MutationObserver((mutations) => {
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

    // Disable attribute and characterData monitoring to reduce observer firing frequency
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });
  }

  function aggressive() {
    // Handle failed image loads by hiding them
    if (!errorHandlerBound) {
      document.addEventListener('error', (e) => {
        if (e.target.tagName === 'IMG' || e.target.tagName === 'PICTURE') {
          e.target.style.display = 'none';
        }
      }, true);
      errorHandlerBound = true;
    }

    removeAllImages();
    blockImageLoading();

    // Additional cleanup passes
    setTimeout(removeAllImages, CONSTANTS.TIMING.IMAGE_BLOCK_DELAY);
    setTimeout(removeAllImages, CONSTANTS.TIMING.IMAGE_BLOCK_DELAY * 2);
  }

  function cleanup() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  return {
    aggressive,
    cleanup,
  };
})();

// Cleanup observer when page unloads to prevent memory leaks
window.addEventListener('beforeunload', () => {
  ImageBlocker.cleanup();
});

// ---------------------------------------------------------------------------
// Generic content-script host.
//
// The Walmart-specific extraction engine (the __NEXT_DATA__ parser, the in-page
// fetch/XHR bridge, the DOM fallback, and the CSS selectors) now lives in the
// active provider adapter (providers/walmart-us.js). This file keeps only the
// provider-agnostic pieces: image blocking (above) and routing background
// messages to whichever adapter owns this page — gated on that provider's
// feature flag. On walmart.com/orders the owner is always WALMART_US (a static
// content script whose flag defaults to on), so behavior is unchanged.
// ---------------------------------------------------------------------------

const CONTENT_MESSAGE_ACTIONS = new Set([
  CONSTANTS.MESSAGES.COLLECT_ORDER_NUMBERS,
  CONSTANTS.MESSAGES.COLLECT_ALL_FAST,
  CONSTANTS.MESSAGES.CLICK_NEXT_BUTTON,
  CONSTANTS.MESSAGES.BLOCK_IMAGES,
  CONSTANTS.MESSAGES.GET_ORDER_DATA,
]);

// The adapter that owns this hostname (or null if none is registered for it).
const activeProvider =
  typeof ProviderRegistry !== "undefined"
    ? ProviderRegistry.getByHostname(location.hostname)
    : null;

let providerContext = null;
let providerReadyPromise = null;

/** Build the ProviderContentCtx passed to the adapter's content methods. */
function buildContentContext(provider) {
  return {
    provider,
    document,
    window,
    location,
    currentPage: 1,
  };
}

/**
 * Activate the owning adapter once, gated on its feature flag. Resolves to the
 * adapter when it is active, or null when no adapter owns this host or its flag
 * is off. WALMART_US defaults to enabled, so activation always succeeds on the
 * Walmart.com orders pages this script is statically injected into.
 */
function ensureProviderActive() {
  if (providerReadyPromise) {
    return providerReadyPromise;
  }
  providerReadyPromise = (async () => {
    if (!activeProvider) {
      return null;
    }
    const enabled =
      typeof Flags !== "undefined"
        ? await Flags.isEnabled(activeProvider.id)
        : Boolean(activeProvider.defaultEnabled);
    if (!enabled) {
      return null;
    }
    providerContext = buildContentContext(activeProvider);
    if (typeof activeProvider.initContent === "function") {
      activeProvider.initContent(providerContext);
    }
    console.log(`[WIE] Content host active for provider ${activeProvider.id} on ${location.hostname}`);
    return activeProvider;
  })();
  return providerReadyPromise;
}

// Install the in-page bridge as early as the pre-refactor content.js did.
ensureProviderActive();

const withImageBlocking = (handler) => async (request) => {
  ImageBlocker.aggressive();
  return handler(request);
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action = request.action || request.method;
  if (!CONTENT_MESSAGE_ACTIONS.has(action)) {
    return false;
  }

  ensureProviderActive()
    .then((provider) => {
      if (!provider) {
        // No active adapter for this page (unknown host or flag off).
        // collectionError tells the background loop this is a hard failure
        // for its bounded retry path, not a "page not ready yet" state.
        sendResponse({ success: false, collectionError: true, error: "provider inactive" });
        return;
      }

      const ctx = providerContext;
      const handlers = {
        [CONSTANTS.MESSAGES.COLLECT_ORDER_NUMBERS]: withImageBlocking((req) =>
          provider.collectOrderNumbers({ ...ctx, currentPage: Number(req.currentPage || 1) })
        ),
        // Fast Collect: whole-history collection in one call. Only adapters
        // that implement collectAllFast handle it; anything else signals a
        // classic-loop fallback so the background never hangs on this message.
        [CONSTANTS.MESSAGES.COLLECT_ALL_FAST]: withImageBlocking((req) => {
          if (typeof provider.collectAllFast !== "function") {
            return Promise.resolve({ fallbackToClassic: true });
          }
          return provider.collectAllFast({ ...ctx, pageLimit: Number(req.pageLimit || 0) });
        }),
        // currentPage rides along from the background loop for cursor-paged
        // adapters (Sam's Club) that validate the advance against the page the
        // loop is on; Walmart's clickNextPage ignores ctx entirely.
        [CONSTANTS.MESSAGES.CLICK_NEXT_BUTTON]: withImageBlocking((req) =>
          provider.clickNextPage({ ...ctx, currentPage: Number(req.currentPage || ctx.currentPage || 1) })
        ),
        [CONSTANTS.MESSAGES.BLOCK_IMAGES]: withImageBlocking(async () => ({ success: true })),
        [CONSTANTS.MESSAGES.GET_ORDER_DATA]: withImageBlocking(async () => {
          // scrapeOrder() merges the __NEXT_DATA__ payload and DOM fallback
          // paths, so validating its output covers both extraction strategies.
          // await handles the adapters that return a Promise (fetch-based
          // Target/Uber/Instacart/Sam's and Amazon's in-page detail fetch);
          // Walmart's sync return is unaffected.
          const data = (await provider.scrapeOrder(ctx)) || null;
          if (!data) {
            console.warn(`[WIE] ${provider.id}: scrapeOrder returned no data for ${location.href}`);
            return { data: null, error: "scrapeOrder returned no data" };
          }
          if (Array.isArray(data.extractionWarnings) && data.extractionWarnings.length > 0) {
            console.warn(
              `Walmart Invoice Exporter: extraction warnings for order #${data.orderNumber || "unknown"}:`,
              data.extractionWarnings
            );
          }
          return { data };
        }),
      };

      return handlers[action](request).then(sendResponse);
    })
    .catch((error) => {
      console.error(`Error handling message ${action}:`, error);
      sendResponse({ success: false, error: error.message });
    });

  return true;
});
