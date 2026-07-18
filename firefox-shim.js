/**
 * firefox-shim.js — Firefox-only compatibility shim.
 *
 * WHY THIS EXISTS (do not ship in the Chrome/Edge builds):
 * 1. In Chrome, background.js runs as an MV3 service worker and its first
 *    line calls importScripts('utils.js'). Firefox MV3 does not support
 *    background service workers — it runs `background.scripts` as an event
 *    page, where importScripts() does not exist. The Firefox manifest loads
 *    ["firefox-shim.js", "utils.js", "background.js"] in order, so utils.js
 *    is already present; we only need importScripts to be a harmless no-op.
 * 2. Firefox has no chrome.sidePanel API; the equivalent is
 *    browser.sidebarAction. background.js's action.onClicked handler calls
 *    chrome.sidePanel.open({ windowId }) behind a typeof guard, so we bridge
 *    that call to browser.sidebarAction.open(). sidebarAction.open() may only
 *    be called from a user-action handler — action.onClicked qualifies.
 *
 * This file must be listed FIRST in background.scripts.
 */
(function () {
  "use strict";

  if (typeof globalThis.importScripts === "undefined") {
    globalThis.importScripts = function () { /* no-op: scripts preloaded via manifest */ };
  }

  var sidebar = typeof browser !== "undefined" && browser.sidebarAction;
  if (typeof chrome !== "undefined" && !chrome.sidePanel && sidebar && typeof sidebar.open === "function") {
    chrome.sidePanel = {
      open: function (_options, callback) {
        try {
          var p = sidebar.open();
          if (p && typeof p.then === "function") {
            p.then(function () { if (typeof callback === "function") callback(); },
                   function (e) { console.warn("sidebarAction.open failed:", e); });
          }
        } catch (e) {
          console.warn("sidebarAction.open threw (needs a user gesture):", e);
        }
      }
    };
  }
})();
