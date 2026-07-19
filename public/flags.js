/**
 * flags.js — provider feature-flag helper.
 *
 * The single source of truth for "is provider X enabled?", read by background,
 * content, and (later) the side panel. Flags live in chrome.storage.local under
 * `settings.flags`, keyed by each adapter's `flag` string:
 *   { flags: { 'provider.walmart_us': true, 'provider.walmart_ca': false } }
 *
 * The registry drives defaults: when the user has never set a flag, the
 * adapter's `defaultEnabled` decides. WALMART_US.defaultEnabled === true, so a
 * fresh install behaves exactly as before — Walmart.com is on, everything else
 * (wave 2+) is off until the user opts in.
 *
 * Loaded after providers/registry.js in every context.
 */
const Flags = (() => {
  "use strict";

  const SETTINGS_KEY = "settings";

  /** Read the whole settings object from chrome.storage.local. */
  function readSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get([SETTINGS_KEY], (result) => {
        resolve((result && result[SETTINGS_KEY]) || {});
      });
    });
  }

  /** Persist the whole settings object to chrome.storage.local. */
  function writeSettings(settings) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [SETTINGS_KEY]: settings }, () => resolve());
    });
  }

  /** Effective enabled state for one adapter, given a stored flags map. */
  function resolveEnabled(adapter, flags) {
    if (!adapter) return false;
    if (Object.prototype.hasOwnProperty.call(flags, adapter.flag)) {
      return Boolean(flags[adapter.flag]);
    }
    return Boolean(adapter.defaultEnabled);
  }

  /**
   * @param {string} providerId
   * @returns {Promise<boolean>} whether the provider is enabled
   */
  async function isEnabled(providerId) {
    const adapter = ProviderRegistry.getById(providerId);
    if (!adapter) return false;
    const settings = await readSettings();
    return resolveEnabled(adapter, settings.flags || {});
  }

  /**
   * Persist a provider's flag. (Does NOT request/remove host permissions — the
   * opt-in permission transaction lives in the settings UI in wave 2.)
   * @param {string} providerId
   * @param {boolean} bool
   */
  async function setEnabled(providerId, bool) {
    const adapter = ProviderRegistry.getById(providerId);
    if (!adapter) return;
    const settings = await readSettings();
    settings.flags = settings.flags || {};
    settings.flags[adapter.flag] = Boolean(bool);
    await writeSettings(settings);
  }

  /** @returns {Promise<Object[]>} every currently-enabled adapter */
  async function getEnabledProviders() {
    const settings = await readSettings();
    const flags = settings.flags || {};
    return ProviderRegistry.list().filter((adapter) => resolveEnabled(adapter, flags));
  }

  return {
    isEnabled,
    setEnabled,
    getEnabledProviders,
  };
})();

if (typeof self !== "undefined") {
  self.Flags = Flags;
}
