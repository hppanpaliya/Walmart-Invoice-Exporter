/**
 * WXT background entrypoint (phase 1 of the migration).
 *
 * The real service worker is still the legacy classic-script chain: WXT copies
 * public/background-main.js (the old background.js) verbatim into the output,
 * and this entry pulls it in with importScripts — which background-main.js
 * itself also uses for utils/providers/flags/orderdb, exactly as before. That
 * keeps runtime behavior byte-identical while the build moves to WXT.
 *
 * importScripts must run synchronously during the worker's initial evaluation,
 * which is exactly when defineBackground's main() fires. If a later WXT
 * version switches the background to a module worker (where importScripts
 * doesn't exist), the build check in CI will catch it loudly — the fix then is
 * `background: { type: undefined }` or graduating background-main.js into a
 * real module (phase 2 anyway).
 */
export default defineBackground(() => {
  importScripts('/background-main.js');
});
