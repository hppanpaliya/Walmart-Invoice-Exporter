/**
 * Background service worker for Walmart Invoice Exporter
 * Handles order collection, pagination, and durable storage
 */

// Load shared constants, the provider registry + adapters, the feature-flag
// helper, utilities, and the durable order database. Registry loads before the
// adapters so they can self-register; flags loads after the registry it reads.
importScripts(
  'utils.js',
  'providers/base.js',
  'providers/registry.js',
  'providers/walmart-us.js',
  'providers/walmart-ca.js',
  'flags.js',
  'orderdb.js'
);

// Default provider for a collection when the panel does not name one — keeps
// zero behavior change for the existing Walmart.com-only flow.
const DEFAULT_PROVIDER_ID = 'WALMART_US';

// One-time, idempotent cleanup of retired chrome.storage.local caches
// (spec §4.5) — cheap, so it just runs on every worker start rather than
// being gated behind onInstalled/onStartup (which an MV3 worker restart,
// unlike a true browser start, does not fire).
migrateLegacyStorage().catch((error) =>
  console.warn('Legacy storage migration failed:', error)
);

// Inactivity retention (on by default; see CONSTANTS.DATA_RETENTION): if the
// extension hasn't been used in the configured window, wipe all saved data on
// worker start. Does NOT count as "use" (markUsed happens on panel open /
// collection). If it wiped, drop any stale session progress too.
OrderDb.enforceInactivityRetention()
  .then((wiped) => {
    if (wiped) {
      console.log(`[retention] extension unused past the window — wiped ${wiped} saved order(s).`);
      chrome.storage.session.remove(CONSTANTS.CACHE_KEYS.COLLECTION_SESSION, () => {
        void chrome.runtime.lastError;
      });
    }
  })
  .catch((error) => console.warn('Inactivity retention sweep failed:', error));

// Encapsulate state to reduce global namespace pollution.
//
// CollectionState.isCollecting reflects only THIS worker instance — Chrome
// can evict an idle service worker (~30s) at any time, resetting every
// module global back to these defaults. Everything else is mirrored to
// chrome.storage.session (sessionKey) after every meaningful change, so a
// collection's progress survives an eviction/restart and a side-panel
// close/reopen (spec §4.1/P9) — but isCollecting itself is never read back
// from that snapshot (see handleGetProgress): only the live in-memory
// instance can truthfully claim to be actively driving a crawl, so a dead
// worker never leaves the panel stuck showing "collecting" forever.
const CollectionState = {
  provider: DEFAULT_PROVIDER_ID,
  allOrderNumbers: new Set(),
  allAdditionalFields: {},
  allOrderSummaries: {},
  currentPage: 1,
  isCollecting: false,
  tabId: null,
  maxRetries: 3,
  retryCount: 0,
  pageLimit: 0,
  pageLoadDelay: 1000,
  initialPageLoaded: false,
  // Consecutive pages that contributed zero orders while still claiming a
  // next page (legit for providers with multiple filtered views, where whole
  // filtered views can be empty). Capped so a misbehaving adapter can never
  // spin the loop forever.
  emptyPageStreak: 0,
  sessionKey: CONSTANTS.CACHE_KEYS.COLLECTION_SESSION,
  incremental: false,
  knownAtStart: null,
  // Optional Fast Collect: when true (and the active adapter supports it), the
  // whole history is pulled in one in-page API-replay call instead of the
  // click-through loop. Off by default → the classic flow is byte-for-byte
  // unchanged. Falls back to the classic loop automatically if the adapter
  // can't fast-collect (e.g. it can't learn the query signature).
  fastFetch: false,

  // The Walmart account (hashed) this collection is running under; the content
  // script reports it, and every record gets stamped with it.
  accountKey: null,

  // Mutual mode fallback (2026-07-19): each collection mode rescues the
  // other exactly once. fastAttempted = Fast Collect ran (or was the entry
  // mode); classicExhausted = the classic crawl burned all its retries. The
  // pair prevents ping-ponging between modes.
  fastAttempted: false,
  classicExhausted: false,

  // Reset state for new collection
  reset() {
    this.currentPage = 1;
    this.retryCount = 0;
    this.initialPageLoaded = false;
    this.emptyPageStreak = 0;
    this.accountKey = null;
    this.fastAttempted = false;
    this.classicExhausted = false;
  },

  // Clear all collected data
  clearAll() {
    this.allOrderNumbers.clear();
    this.allAdditionalFields = {};
    this.allOrderSummaries = {};
  }
};

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel && chrome.sidePanel.open) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
  else {
    console.warn("Side panel API not available.");
  }
});

/**
 * Load any collection progress mirrored to chrome.storage.session into
 * CollectionState. Unlike the old 24h chrome.storage.local cache, there is
 * no expiry math here — chrome.storage.session is cleared automatically
 * when the browser closes, and IndexedDB (OrderDb) is the durable
 * long-term store; this is scratch space just for "is a collection still
 * going / where did it leave off" (spec §4.1).
 * Deliberately does NOT touch CollectionState.isCollecting — see the big
 * comment above CollectionState for why.
 */
function loadSessionState() {
  return new Promise((resolve) => {
    chrome.storage.session.get([CollectionState.sessionKey], (result) => {
      const saved = result[CollectionState.sessionKey];
      if (saved) {
        CollectionState.provider = saved.provider || CollectionState.provider || DEFAULT_PROVIDER_ID;
        CollectionState.allOrderNumbers = new Set(saved.orderNumbers || []);
        CollectionState.allAdditionalFields = saved.additionalFields || {};
        CollectionState.allOrderSummaries = saved.orderSummaries || {};
        CollectionState.currentPage = saved.currentPage || 1;
        CollectionState.pageLimit = saved.pageLimit || 0;
        console.log(`Restored ${CollectionState.allOrderNumbers.size} orders from session state.`);
      }
      resolve();
    });
  });
}

/** Mirror live collection progress to chrome.storage.session (best-effort). */
function saveSessionState() {
  const dataToSave = {
    provider: CollectionState.provider,
    orderNumbers: Array.from(CollectionState.allOrderNumbers),
    additionalFields: CollectionState.allAdditionalFields,
    orderSummaries: CollectionState.allOrderSummaries,
    currentPage: CollectionState.currentPage,
    pageLimit: CollectionState.pageLimit,
    isCollecting: CollectionState.isCollecting,
  };

  chrome.storage.session.set({ [CollectionState.sessionKey]: dataToSave }, () => {
    if (chrome.runtime.lastError) {
      console.warn("Failed to save session collection state:", chrome.runtime.lastError.message);
    }
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handlers = {
    [CONSTANTS.MESSAGES.START_COLLECTION]: handleStartCollection,
    [CONSTANTS.MESSAGES.STOP_COLLECTION]: handleStopCollection,
    [CONSTANTS.MESSAGES.GET_PROGRESS]: handleGetProgress,
    [CONSTANTS.MESSAGES.RESET_SESSION_STATE]: handleResetSessionState,
    [CONSTANTS.MESSAGES.FAST_COLLECT_PROGRESS]: handleFastCollectProgress,
  };

  const handler = handlers[request.action];
  if (!handler) {
    return false;
  }

  return handler(request, sendResponse);
});

/** The adapter driving the current (or requested) collection. */
function activeAdapter() {
  return ProviderRegistry.getById(CollectionState.provider) || null;
}

/**
 * Learn (once) which Walmart account this collection is running under, and make
 * it the current account so both the side panel and the dashboard scope their
 * list to it (they watch CURRENT_ACCOUNT in storage). New orders are tagged
 * with this key as they're saved; we deliberately do NOT touch already-stored
 * records — the old "grandfather untagged into this account" step silently
 * moved one account's orders into another and is gone.
 */
function noteCollectionAccount(accountKey) {
  if (!accountKey || CollectionState.accountKey === accountKey) return;
  CollectionState.accountKey = accountKey;
  chrome.storage.local.set({ [CONSTANTS.STORAGE_KEYS.CURRENT_ACCOUNT]: accountKey });
}

/**
 * Whether a provider may be collected right now: it must be registered, its
 * feature flag on, and its host permission granted. WALMART_US is always
 * on/granted (static host permission + defaultEnabled), so the Walmart flow is
 * never blocked.
 * @returns {Promise<boolean>}
 */
async function canCollectProvider(providerId) {
  const adapter = ProviderRegistry.getById(providerId);
  if (!adapter) return false;
  const enabled = await Flags.isEnabled(providerId);
  if (!enabled) return false;
  const granted = await new Promise((resolve) =>
    chrome.permissions.contains({ origins: adapter.hostPermissions || [] }, (has) =>
      resolve(Boolean(has) && !chrome.runtime.lastError)
    )
  );
  return granted;
}

function handleStartCollection(request, sendResponse) {
  if (!CollectionState.isCollecting) {
    // Starting a collection counts as using the extension — reset the
    // inactivity-retention clock so active users never lose data.
    OrderDb.markUsed();
    const providerId = request.provider || DEFAULT_PROVIDER_ID;
    // Claim the collecting flag synchronously so a rapid double-Start can't
    // race two crawls; release it if the provider turns out to be disallowed.
    CollectionState.isCollecting = true;

    // Refuse providers that are unknown, flag-off, or not permission-granted.
    canCollectProvider(providerId).then((allowed) => {
      if (!allowed) {
        console.warn(`Refusing collection for provider ${providerId} (disabled or not permitted).`);
        CollectionState.isCollecting = false;
        return;
      }
      // Hydrate from session first — e.g. this worker was just (re)spawned
      // after an eviction and the panel is resuming a collection. The provider
      // is assigned AFTER hydration: loadSessionState restores saved.provider,
      // which for a snapshot left by a DIFFERENT provider's run (e.g. a
      // Walmart crawl earlier this session, now starting a different site) would
      // otherwise silently clobber the requested provider — the crawl would
      // then judge the new provider's tab URL with the wrong adapter, fail the
      // orders-list check every retry, and die having stored nothing (or
      // stored under the wrong OrderDb partition).
      loadSessionState().then(() => {
        if (CollectionState.provider !== providerId) {
          // Cross-provider snapshot: never leak another retailer's orders
          // (or its page cursor) into this crawl.
          console.log(`[collect] Session snapshot belongs to ${CollectionState.provider}; starting ${providerId} with a clean slate.`);
          CollectionState.clearAll();
        }
        CollectionState.provider = providerId;
        CollectionState.reset();
        // Page-to-page wait is user-configurable (Settings → Advanced); clamp
        // through the shared spec so a bad value can't stall or hammer the
        // orders page.
        const delaySpec = CONSTANTS.TIMING_SETTINGS.find((spec) => spec.key === "collectPageDelayMs");
        chrome.storage.local.get(["collectPageDelayMs"], (res) => {
          CollectionState.pageLoadDelay = resolveTimingSetting(delaySpec, res.collectPageDelayMs);
        });
        CollectionState.pageLimit = request.pageLimit || 0;
        CollectionState.incremental = Boolean(request.incremental);
        CollectionState.knownAtStart = null;
        // Pure request-replay Fast Collect is OPT-IN (default off). The
        // reliable default is the paginating crawl, which reads each page's
        // real order date from the page's OWN captured request — Walmart does
        // not challenge its own requests the way it can challenge a blindly
        // replayed one, so pagination is what works for everyone.
        CollectionState.fastFetch =
          Boolean(request.fastFetch) &&
          Boolean(ProviderRegistry.getById(providerId)?.supportsFastFetch);

        if (!CollectionState.incremental) {
          startCollection(request.url);
          return;
        }

        // Incremental mode stops when a whole page of already-stored orders is
        // seen — snapshot what the database knows before we begin.
        OrderDb.getKnownOrderNumbers(CollectionState.provider)
          .then((known) => {
            CollectionState.knownAtStart = known;
          })
          .catch((error) => {
            console.warn("Order DB unavailable; running a full collection:", error);
            CollectionState.incremental = false;
          })
          .then(() => startCollection(request.url));
      });
    });
  }
  sendResponse({ status: "started" });
  return false; // Synchronous response
}

function handleStopCollection(_request, sendResponse) {
  if (!CollectionState.isCollecting) {
    // Hydrate first so "Stop" right after a panel reopen (post-eviction)
    // reports actually-known progress instead of fresh-worker defaults.
    loadSessionState().then(() => {
      sendResponse({
        status: "idle",
        currentPage: CollectionState.currentPage,
        orderNumbers: Array.from(CollectionState.allOrderNumbers),
      });
    });
    return true; // Async response
  }

  CollectionState.isCollecting = false;
  if (CollectionState.tabId) {
    chrome.tabs.remove(CollectionState.tabId).catch(() => {
      // Tab may already be closed
    });
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
  }
  // Save progress before sending response
  saveSessionState();
  sendResponse({
    status: "stopped",
    currentPage: CollectionState.currentPage,
    orderNumbers: Array.from(CollectionState.allOrderNumbers),
  });

  return false; // Synchronous response
}

function handleGetProgress(_request, sendResponse) {
  const respond = () => {
    const payload = {
      currentPage: CollectionState.currentPage,
      pageLimit: CollectionState.pageLimit,
      orderNumbers: Array.from(CollectionState.allOrderNumbers),
      additionalFields: CollectionState.allAdditionalFields,
      orderSummaries: CollectionState.allOrderSummaries,
      isCollecting: CollectionState.isCollecting,
    };
    // PANEL CONTRACT: `provider` names the OrderDb partition this progress
    // belongs to (the live or most recent collection's provider id). It is
    // OMITTED for the default WALMART_US so the historic response shape —
    // which the Walmart-only panel and tests rely on — is unchanged; the
    // panel should treat a missing `provider` as WALMART_US and read
    // OrderDb.getAllOrders(provider) accordingly.
    if (CollectionState.provider && CollectionState.provider !== DEFAULT_PROVIDER_ID) {
      payload.provider = CollectionState.provider;
    }
    sendResponse(payload);
  };

  // While collecting, the in-memory state is authoritative — reloading the
  // session snapshot here would race the per-page merge (losing pages).
  if (CollectionState.isCollecting) {
    respond();
    return true;
  }

  // Not collecting from THIS worker instance's point of view — it may have
  // just been (re)spawned after Chrome evicted the previous, possibly
  // mid-collection, instance. Hydrate order data from session so a panel
  // reopen still shows progress; isCollecting always reflects the CURRENT
  // instance (see the CollectionState comment), never a stale session
  // snapshot, so a dead crawl never reports itself as still running.
  loadSessionState().then(respond);
  return true; // Indicate async response
}

/**
 * Live progress from a Fast Collect run: the content script sends one of these
 * per page as it fetches, so the panel's GET_PROGRESS polling shows the page
 * number and the growing order list in real time instead of nothing until the
 * whole history is done. Merges exactly like the classic per-page path, and
 * persists each page to OrderDb so the list shows dates as it fills.
 */
function handleFastCollectProgress(request, sendResponse) {
  // Ignore stray progress that doesn't belong to the run this worker is driving.
  if (CollectionState.isCollecting) {
    if (request.page) CollectionState.currentPage = request.page;

    (request.orderNumbers || []).forEach((num) => CollectionState.allOrderNumbers.add(num));

    if (request.additionalFields) {
      CollectionState.allAdditionalFields = {
        ...CollectionState.allAdditionalFields,
        ...request.additionalFields,
      };
    }
    if (request.orderSummaries) {
      Object.entries(request.orderSummaries).forEach(([orderNumber, summary]) => {
        const existing = CollectionState.allOrderSummaries[orderNumber];
        if (existing && isPayloadQualitySummary(existing) && !isPayloadQualitySummary(summary)) {
          return;
        }
        CollectionState.allOrderSummaries[orderNumber] = summary;
      });
    }

    if (request.accountKey) noteCollectionAccount(request.accountKey);

    // Persist this page so the panel's DB-backed render shows dated rows as the
    // collection fills, not just bare order numbers.
    OrderDb.putSummaries(
      request.orderSummaries || {},
      request.additionalFields || {},
      CollectionState.provider,
      CollectionState.accountKey
    ).catch((error) => console.warn("Failed to persist Fast Collect page to order DB:", error));

    saveSessionState();
  }
  sendResponse({ status: "ok" });
  return false;
}

/**
 * Wipe chrome.storage.session's live collection progress and reset the
 * in-memory CollectionState (spec §4.4). Sent by Settings' "Delete all
 * saved data" alongside OrderDb.clearAll() so a delete-all truly leaves
 * nothing behind — no stray in-progress collection reappearing on the next
 * GET_PROGRESS poll.
 */
function handleResetSessionState(_request, sendResponse) {
  chrome.storage.session.remove(CollectionState.sessionKey, () => {
    console.log("Session collection state cleared");
    CollectionState.clearAll();
    sendResponse({ status: "session_state_reset" });
  });
  return true; // Indicate async response
}

/**
 * The orders LIST page (an order-detail URL like /orders/123 is NOT it).
 * Delegates to the active provider adapter so the crawl is host-agnostic.
 */
function isOrdersListUrl(url) {
  const adapter = activeAdapter();
  return adapter ? adapter.isOrdersListUrl(url) : false;
}

// Collection always runs in its OWN background tab — never in a tab the
// user is looking at (owner decision: reverted the 6.20 in-tab collection).
function startCollection(url) {
  const adapter = activeAdapter();
  let targetUrl = url || (adapter && adapter.ordersListUrl) || url;
  // Defensive: a stale/foreign URL (e.g. a Walmart tab URL passed while a
  // non-Walmart provider is selected) must not be crawled with this adapter —
  // fall back to the adapter's own orders list. Walmart URLs (including
  // filter-scoped ones) resolve to WALMART_US and pass through untouched.
  if (adapter && targetUrl) {
    const owner = ProviderRegistry.getByUrl(targetUrl);
    if (!owner || owner.id !== adapter.id) {
      console.warn(`[collect] URL ${targetUrl} does not belong to provider ${adapter.id}; using ${adapter.ordersListUrl} instead.`);
      targetUrl = adapter.ordersListUrl || targetUrl;
    }
  }
  console.log(`[collect] Starting ${adapter ? adapter.id : "unknown-provider"} collection in a background tab from URL:`, targetUrl);
  chrome.tabs.create({ url: targetUrl, active: false }, (tab) => {
    if (chrome.runtime.lastError) {
      console.error("Failed to create tab:", chrome.runtime.lastError);
      CollectionState.isCollecting = false;
      return;
    }
    CollectionState.tabId = tab.id;
    chrome.tabs.onUpdated.addListener(onTabUpdated);
  });
}

function onTabUpdated(updatedTabId, changeInfo, tab) {
  if (CollectionState.tabId && updatedTabId === CollectionState.tabId && changeInfo.status === "complete") {
    if (CollectionState.initialPageLoaded) {
      return;
    }
    CollectionState.initialPageLoaded = true;
    if (CollectionState.fastFetch) {
      console.log("Tab updated; running Fast Collect (single-call API replay).");
      setTimeout(() => collectAllFast(), CollectionState.pageLoadDelay);
      return;
    }
    console.log("Tab updated, collecting order numbers for page:", CollectionState.currentPage);
    setTimeout(() => collectOrderNumbers(), CollectionState.pageLoadDelay);
  }
}

// How long Fast Collect may run in one call. Generous: a large history pages
// through the API at a human pace inside a single content-script call. On
// timeout (or any failure) it falls back to the classic click-through loop, so
// a very large account still completes — just the slow way.
const FAST_COLLECT_MS = 150000;

/**
 * Fast Collect driver: one message collects the WHOLE history via the adapter's
 * in-page API replay. Anything that goes wrong (timeout, error, or the adapter
 * asking to fall back) drops cleanly into the classic per-page loop, so this
 * path can only speed things up, never lose a collection.
 */
function collectAllFast() {
  if (!CollectionState.isCollecting) {
    finishCollection();
    return;
  }
  CollectionState.fastAttempted = true;

  const runClassicInstead = (why) => {
    // When the classic crawl already exhausted itself and Fast Collect was
    // its rescue, there is no third option — finish with what we have.
    if (CollectionState.classicExhausted) {
      console.warn(`[collect] Fast Collect rescue also unavailable (${why}); finishing.`);
      finishCollection();
      return;
    }
    console.warn(`[collect] Fast Collect unavailable (${why}); using the classic loop.`);
    CollectionState.fastFetch = false;
    CollectionState.reset();
    // Classic must not bounce back into fast within the same run.
    CollectionState.fastAttempted = true;
    CollectionState.initialPageLoaded = true;
    collectOrderNumbers();
  };

  chrome.tabs.get(CollectionState.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab || !isOrdersListUrl(tab.url)) {
      runClassicInstead("tab not on orders list");
      return;
    }

    sendTabMessageWithTimeout(
      CollectionState.tabId,
      {
        action: CONSTANTS.MESSAGES.COLLECT_ALL_FAST,
        pageLimit: CollectionState.pageLimit,
        // Incremental ("only new orders"): hand the fast pager what the DB
        // already knows so it can stop at the first all-known page — the
        // classic crawl's rule, previously ignored by fast mode.
        incremental: CollectionState.incremental,
        knownOrderNumbers: Array.from(CollectionState.knownAtStart || []),
      },
      FAST_COLLECT_MS,
      (response) => {
        if (chrome.runtime.lastError || !response) {
          runClassicInstead("no response");
          return;
        }
        if (response.fallbackToClassic) {
          runClassicInstead("adapter requested fallback");
          return;
        }
        if (!Array.isArray(response.orderNumbers) || response.orderNumbers.length === 0) {
          runClassicInstead("no orders returned");
          return;
        }

        if (response.accountKey) noteCollectionAccount(response.accountKey);
        response.orderNumbers.forEach((num) => CollectionState.allOrderNumbers.add(num));
        if (response.additionalFields) {
          CollectionState.allAdditionalFields = {
            ...CollectionState.allAdditionalFields,
            ...response.additionalFields,
          };
        }
        if (response.orderSummaries) {
          Object.entries(response.orderSummaries).forEach(([orderNumber, summary]) => {
            const existing = CollectionState.allOrderSummaries[orderNumber];
            if (existing && isPayloadQualitySummary(existing) && !isPayloadQualitySummary(summary)) {
              return;
            }
            CollectionState.allOrderSummaries[orderNumber] = summary;
          });
        }
        CollectionState.currentPage = response.pages || CollectionState.currentPage;

        // Persist to IndexedDB and only THEN finish. finishCollection flips
        // isCollecting off, which is the panel's cue to re-render the list from
        // OrderDb — if we finished before this write committed, the panel would
        // read a DB that doesn't have the orders yet and paint an empty/dateless
        // list until it was reopened. Awaiting the write makes the full, dated
        // list appear the instant collection ends.
        OrderDb.putSummaries(
          response.orderSummaries || {},
          response.additionalFields || {},
          CollectionState.provider,
          CollectionState.accountKey
        )
          .catch((error) => console.warn("Failed to persist Fast Collect result to order DB:", error))
          .finally(() => {
            saveSessionState();
            console.log(
              `[collect] Fast Collect stored ${response.orderNumbers.length} orders across ${response.pages || "?"} page(s).`
            );
            finishCollection();
          });
      }
    );
  });
}

// Upper bounds on how long the loop waits for a content-script response.
// Generous on purpose: fetch-based adapters legitimately spend seconds paging
// their own APIs inside one COLLECT_ORDER_NUMBERS call, and Walmart never
// comes close to these — so for WALMART_US the watchdog is a no-op. What it
// prevents is an adapter promise that never settles (a hung in-page fetch/
// bridge) freezing the crawl forever in a background tab (bounded, then the
// normal retry/finish path takes over).
const RESPONSE_TIMEOUTS = {
  COLLECT_MS: 90000,
  CLICK_NEXT_MS: 45000,
};

// How many consecutive zero-order pages (that still claim hasNextPage) the
// loop will advance through before finishing. Some multi-view providers legitimately produce a
// few (empty year/digital/business views); anything beyond this smells like a
// broken pager.
const MAX_EMPTY_PAGE_STREAK = 15;

/**
 * chrome.tabs.sendMessage with a bounded wait. If no response (and no error)
 * arrives within timeoutMs, the callback fires once with undefined so the
 * caller's normal failure/retry path runs instead of hanging forever.
 */
function sendTabMessageWithTimeout(tabId, message, timeoutMs, callback) {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    console.warn(`[collect] No response to ${message.action} after ${timeoutMs}ms; treating as a failed page.`);
    callback(undefined);
  }, timeoutMs);
  chrome.tabs.sendMessage(tabId, message, (response) => {
    if (settled) {
      // Late response after the watchdog fired — read lastError so Chrome
      // does not log an unchecked-error warning, then drop it.
      void chrome.runtime.lastError;
      return;
    }
    settled = true;
    clearTimeout(timer);
    callback(response);
  });
}

function collectOrderNumbers() {
  if (!CollectionState.isCollecting) {
    console.log("Collection stopped by user");
    finishCollection();
    return;
  }

  // Check if we've reached the page limit
  if (CollectionState.pageLimit > 0 && CollectionState.currentPage > CollectionState.pageLimit) {
    console.log(`Reached page limit (${CollectionState.pageLimit}). Finishing collection.`);
    finishCollection();
    return;
  }

  // The user can navigate a reused tab away mid-collection — verify we are
  // still on the orders list before asking it for a page.
  chrome.tabs.get(CollectionState.tabId, (tab) => {
    if (chrome.runtime.lastError || !tab || !isOrdersListUrl(tab.url)) {
      console.warn(
        `[collect] Tab is no longer on the ${CollectionState.provider} orders list (url: ${tab && tab.url}); retrying. ` +
          "If this repeats, the site may have redirected to a sign-in page."
      );
      retryCollection();
      return;
    }

  // Always collect order numbers to ensure cache is up to date with any changes
  sendTabMessageWithTimeout(
    CollectionState.tabId,
    {
      action: CONSTANTS.MESSAGES.COLLECT_ORDER_NUMBERS,
      currentPage: CollectionState.currentPage,
    },
    RESPONSE_TIMEOUTS.COLLECT_MS,
    (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error collecting order numbers:", chrome.runtime.lastError);
      retryCollection();
      return;
    }

    if (response && response.collectionError) {
      console.warn("Content script reported a collection error; retrying.");
      retryCollection();
      return;
    }

    // A page counts as valid when it has orders, is a declared end of the
    // list, or is an EMPTY page that still declares a next page — the latter
    // is normal for multi-view providers (e.g. an empty filtered view
    // with no orders) and must advance the crawl, not burn retries.
    if (response && response.orderNumbers && (response.orderNumbers.length > 0 || response.endOfOrders || response.hasNextPage)) {
      console.log(`[collect] ${CollectionState.provider}: ${response.orderNumbers.length} order(s) on page ${CollectionState.currentPage}, hasNextPage=${Boolean(response.hasNextPage)}`);

      if (response.orderNumbers.length === 0) {
        CollectionState.emptyPageStreak++;
        if (CollectionState.emptyPageStreak > MAX_EMPTY_PAGE_STREAK) {
          console.warn(`[collect] ${CollectionState.emptyPageStreak} consecutive empty pages — finishing to avoid a runaway crawl.`);
          finishCollection();
          return;
        }
      } else {
        CollectionState.emptyPageStreak = 0;
      }

      if (response.accountKey) noteCollectionAccount(response.accountKey);

      // Add order numbers to the set
      response.orderNumbers.forEach((num) => CollectionState.allOrderNumbers.add(num));

      // Add additional fields to the map
      if (response.additionalFields) {
        CollectionState.allAdditionalFields = { ...CollectionState.allAdditionalFields, ...response.additionalFields };
      }

      // Merge per-page order summaries — never let a degraded DOM-scraped
      // summary replace payload-quality data for the same order.
      if (response.orderSummaries) {
        Object.entries(response.orderSummaries).forEach(([orderNumber, summary]) => {
          const existing = CollectionState.allOrderSummaries[orderNumber];
          if (existing && isPayloadQualitySummary(existing) && !isPayloadQualitySummary(summary)) {
            return;
          }
          CollectionState.allOrderSummaries[orderNumber] = summary;
        });
      }

      // Persist this page into the durable order database (best-effort).
      OrderDb.putSummaries(
        response.orderSummaries || {},
        response.additionalFields || {},
        CollectionState.provider,
        CollectionState.accountKey
      ).catch((error) => console.warn("Failed to persist page to order DB:", error));

      // Mirror live progress to chrome.storage.session after each page.
      saveSessionState();

      // Incremental sync: a page consisting entirely of already-stored orders
      // means everything older is stored too — stop here.
      const pageFullyKnown =
        CollectionState.incremental &&
        CollectionState.knownAtStart &&
        response.orderNumbers.length > 0 &&
        response.orderNumbers.every((num) => CollectionState.knownAtStart.has(num));
      if (pageFullyKnown) {
        console.log("Incremental sync: page contains only known orders. Hydrating from the DB and finishing.");
        hydrateCollectionFromDb().finally(() => finishCollection());
        return;
      }

      if (response.hasNextPage && (CollectionState.pageLimit === 0 || CollectionState.currentPage < CollectionState.pageLimit)) {
        goToNextPage();
      } else {
        console.log("No more pages to collect or reached limit. Finishing collection.");
        finishCollection();
      }
    } else {
      console.log("No order numbers received. Retrying.");
      retryCollection();
    }
    }
  );
  });
}

function goToNextPage() {
  if (!CollectionState.isCollecting) {
    finishCollection();
    return;
  }

  console.log("Attempting to go to next page:", CollectionState.currentPage + 1);
  // currentPage rides along so cursor-paged adapters can
  // validate the advance against the page the loop is actually on; Walmart's
  // clickNextPage ignores it.
  sendTabMessageWithTimeout(
    CollectionState.tabId,
    { action: CONSTANTS.MESSAGES.CLICK_NEXT_BUTTON, currentPage: CollectionState.currentPage },
    RESPONSE_TIMEOUTS.CLICK_NEXT_MS,
    (response) => {
    if (chrome.runtime.lastError) {
      console.error("Error clicking next button:", chrome.runtime.lastError);
      retryCollection();
    } else if (response && response.success) {
      CollectionState.currentPage++;
      CollectionState.retryCount = 0;
      console.log("Successfully clicked next button. Collecting page:", CollectionState.currentPage);
      setTimeout(() => collectOrderNumbers(), CollectionState.pageLoadDelay);
    } else {
      console.log("Failed to click next button. Retrying.");
      retryCollection();
    }
  });
}

function retryCollection() {
  if (!CollectionState.isCollecting) {
    finishCollection();
    return;
  }

  if (CollectionState.retryCount < CollectionState.maxRetries) {
    CollectionState.retryCount++;
    console.log(`Retrying collection. Attempt ${CollectionState.retryCount} of ${CollectionState.maxRetries}`);
    setTimeout(() => collectOrderNumbers(), CollectionState.pageLoadDelay);
    return;
  }

  // Classic crawl is out of retries. Before giving up, try the OTHER mode
  // once: Fast Collect can succeed where the DOM crawl fails (e.g. filtered
  // views with no server-rendered payload) — the mirror of Fast Collect's own
  // fallbackToClassic. fastAttempted guards against ping-ponging.
  const adapter = typeof ProviderRegistry !== "undefined" ? ProviderRegistry.getById(CollectionState.provider) : null;
  if (adapter && adapter.supportsFastFetch && !CollectionState.fastAttempted) {
    console.warn("[collect] Classic crawl exhausted its retries — attempting Fast Collect as a rescue.");
    CollectionState.classicExhausted = true;
    CollectionState.fastFetch = true;
    collectAllFast();
    return;
  }

  console.log("Max retries reached. Finishing collection.");
  finishCollection();
}

/**
 * Merge every order stored in the durable DB into the live collection so an
 * incremental early-stop still leaves the full history selectable in the
 * panel (session state only covers this browser session's live progress).
 */
async function hydrateCollectionFromDb() {
  try {
    const records = await OrderDb.getAllOrders(CollectionState.provider);
    records.forEach((record) => {
      if (!record?.orderNumber) return;
      CollectionState.allOrderNumbers.add(record.orderNumber);
      if (record.title && !CollectionState.allAdditionalFields[record.orderNumber]) {
        CollectionState.allAdditionalFields[record.orderNumber] = record.title;
      }
      const existing = CollectionState.allOrderSummaries[record.orderNumber];
      if (record.summary && (!existing || (!isPayloadQualitySummary(existing) && isPayloadQualitySummary(record.summary)))) {
        CollectionState.allOrderSummaries[record.orderNumber] = record.summary;
      }
    });
    console.log(`Hydrated collection from DB: ${CollectionState.allOrderNumbers.size} orders total.`);
  } catch (error) {
    console.warn("Could not hydrate collection from the order DB:", error);
  }
}

function finishCollection() {
  CollectionState.isCollecting = false;
  // Save progress before closing
  saveSessionState();
  if (CollectionState.tabId) {
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    chrome.tabs.remove(CollectionState.tabId).catch(() => {
      // Tab may already be closed, ignore error
    });
    CollectionState.tabId = null;
  }
  console.log(`[collect] ${CollectionState.provider} collection finished. Total pages: ${CollectionState.currentPage}, Total order numbers: ${CollectionState.allOrderNumbers.size}`);
}
