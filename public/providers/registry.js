/**
 * providers/registry.js — the provider adapter registry.
 *
 * The single place that lists provider adapters and resolves the active one by
 * id or by hostname. Loaded in every context (service worker via importScripts,
 * content script + side panel via globals) BEFORE any adapter file, so adapters
 * can self-register by calling ProviderRegistry.register(adapter) at load.
 *
 * Only Walmart.com (WALMART_US) is registered today; wave-2 providers register
 * themselves the same way from their own providers/<id>.js file.
 */
const ProviderRegistry = (() => {
  "use strict";

  const byId = new Map();

  /** Extract the host portion of a host-permission match pattern. */
  function patternHost(pattern) {
    const match = /^[a-z*]+:\/\/([^/]+)/i.exec(String(pattern || ""));
    return match ? match[1].toLowerCase() : "";
  }

  /** Whether a hostname matches a host-permission pattern host (supports *. ). */
  function hostMatches(hostname, pattern) {
    const host = String(hostname || "").toLowerCase();
    const target = patternHost(pattern);
    if (!host || !target) return false;
    if (target === "*") return true;
    if (target.startsWith("*.")) {
      const bare = target.slice(2);
      return host === bare || host.endsWith("." + bare);
    }
    return host === target;
  }

  /**
   * Register (or replace) an adapter. Adapters are keyed by their stable id.
   * @param {Object} adapter - a ProviderAdapter (see providers/base.js)
   * @returns {Object} the adapter
   */
  function register(adapter) {
    if (adapter && adapter.id) {
      byId.set(adapter.id, adapter);
    }
    return adapter;
  }

  /** @returns {Object|null} the adapter with this id */
  function getById(id) {
    return byId.get(id) || null;
  }

  /** @returns {Object[]} every registered adapter */
  function list() {
    return Array.from(byId.values());
  }

  /** @returns {Object|null} the adapter that owns this hostname */
  function getByHostname(hostname) {
    return (
      list().find((adapter) =>
        (adapter.hostPermissions || []).some((pattern) => hostMatches(hostname, pattern))
      ) || null
    );
  }

  /** @returns {Object|null} the adapter that owns this URL's hostname */
  function getByUrl(url) {
    try {
      return getByHostname(new URL(url).hostname);
    } catch (error) {
      return null;
    }
  }

  return {
    register,
    getById,
    list,
    getByHostname,
    getByUrl,
  };
})();

// Make available to the service worker global scope for importScripts contexts.
if (typeof self !== "undefined") {
  self.ProviderRegistry = ProviderRegistry;
}
