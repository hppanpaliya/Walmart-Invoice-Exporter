(() => {
  /**
   * Side-panel provider-selection contract.
   *
   * The active provider is first-class global state that drives the ENTIRE
   * panel — order list, dashboard, collection target, and export are all scoped
   * to it. Switching the selector re-renders everything for the chosen provider
   * (or the combined "All providers" view) and is completely independent of
   * whatever browser tab is currently focused: a provider's already-saved data
   * shows instantly from OrderDb, and collection opens that provider's own site
   * in a background tab.
   *
   * Default is WALMART_US, so with nothing opted in the panel behaves exactly as
   * the Walmart.com-only tool always has.
   *
   * This module is the single source of truth every panel piece reads. It is
   * intentionally dependency-light (ProviderRegistry + Flags + chrome.storage)
   * and holds no rendering logic.
   */
  const Sidepanel = window.Sidepanel || (window.Sidepanel = {});

  const PROVIDER_ALL = "__ALL__";
  const STORAGE_KEY = "active_provider";
  const DEFAULT_PROVIDER = "WALMART_US";

  function registry() {
    return typeof ProviderRegistry !== "undefined" ? ProviderRegistry : null;
  }

  const WALMART_FALLBACK = { id: DEFAULT_PROVIDER, label: "Walmart.com", currency: "USD", locale: "en-US" };

  /**
   * Every adapter that is currently usable: WALMART_US always, plus any other
   * provider whose feature flag the user has enabled. Never empty.
   * @returns {Promise<Array<{id,label,currency,locale}>>}
   */
  async function enabledAdapters() {
    const reg = registry();
    if (!reg || typeof reg.list !== "function") return [WALMART_FALLBACK];

    const adapters = reg.list() || [];
    const out = [];
    for (const adapter of adapters) {
      let on = Boolean(adapter.defaultEnabled);
      if (!on && typeof Flags !== "undefined" && Flags.isEnabled) {
        try {
          on = await Flags.isEnabled(adapter.id);
        } catch (error) {
          on = false;
        }
      }
      if (on) {
        out.push({
          id: adapter.id,
          label: adapter.label || adapter.id,
          currency: adapter.currency || "USD",
          locale: adapter.locale || "en-US",
        });
      }
    }
    return out.length ? out : [WALMART_FALLBACK];
  }

  /**
   * Options for the header dropdown: every enabled provider, and — only when
   * more than one is enabled — an "All providers" combined entry.
   * @returns {Promise<Array<{id,label,currency}>>}
   */
  async function selectable() {
    const providers = await enabledAdapters();
    const options = providers.slice();
    if (providers.length > 1) {
      options.push({ id: PROVIDER_ALL, label: "All sites", currency: null });
    }
    return options;
  }

  /**
   * The persisted active selection, validated against what is currently
   * enabled (a provider the user later disabled falls back to WALMART_US; the
   * combined view falls back to WALMART_US when only one provider remains).
   * @returns {Promise<string>} a provider id or PROVIDER_ALL
   */
  async function getActive() {
    const stored = await new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORAGE_KEY, (result) => resolve(result && result[STORAGE_KEY]));
      } catch (error) {
        resolve(null);
      }
    });
    const providers = await enabledAdapters();
    const ids = providers.map((provider) => provider.id);
    if (stored === PROVIDER_ALL && providers.length > 1) return PROVIDER_ALL;
    if (stored && ids.includes(stored)) return stored;
    return DEFAULT_PROVIDER;
  }

  /** Persist the active selection. */
  async function setActive(id) {
    await new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: id }, resolve);
      } catch (error) {
        resolve();
      }
    });
  }

  /**
   * Concrete provider ids to query for a selection: the single provider, or —
   * for PROVIDER_ALL — every enabled provider id.
   * @returns {Promise<string[]>}
   */
  async function scopeIds(active) {
    if (active !== PROVIDER_ALL) return [active];
    const providers = await enabledAdapters();
    return providers.map((provider) => provider.id);
  }

  /** Display currency for a selection; null for the combined view (mixed). */
  function currencyFor(id) {
    if (id === PROVIDER_ALL) return null;
    const reg = registry();
    const adapter = reg && reg.getById ? reg.getById(id) : null;
    return (adapter && adapter.currency) || "USD";
  }

  /** Human label for a provider id (or the combined view). */
  function labelFor(id) {
    if (id === PROVIDER_ALL) return "All sites";
    const reg = registry();
    const adapter = reg && reg.getById ? reg.getById(id) : null;
    return (adapter && adapter.label) || id;
  }

  /** The adapter's own orders-list URL, used as the collection target. */
  function ordersListUrlFor(id) {
    if (id === PROVIDER_ALL) return null;
    const reg = registry();
    const adapter = reg && reg.getById ? reg.getById(id) : null;
    return (adapter && adapter.ordersListUrl) || null;
  }

  Sidepanel.providers = {
    PROVIDER_ALL,
    DEFAULT_PROVIDER,
    enabledAdapters,
    selectable,
    getActive,
    setActive,
    scopeIds,
    currencyFor,
    labelFor,
    ordersListUrlFor,
  };
})();
