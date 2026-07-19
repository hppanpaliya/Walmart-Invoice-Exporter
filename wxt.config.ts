import { readFileSync } from 'node:fs';
import { defineConfig } from 'wxt';

/**
 * WXT build config — phase 1 of the migration (strangler port).
 *
 * Every runtime file lives in public/ and ships VERBATIM (classic scripts,
 * same load order as the old handwritten manifest), so runtime behavior is
 * byte-identical to v7.3. WXT's job at this stage is only to generate the
 * manifest, run the dev/build/zip pipeline, and host the incremental
 * migration: files graduate from public/ into real Vite-bundled modules
 * phase by phase (see the background entrypoint).
 *
 * The one renamed file: background.js → public/background-main.js, because
 * WXT emits its own background.js entry (entrypoints/background.js), which
 * just importScripts()s the legacy worker.
 *
 * Firefox (build with `-b firefox --mv3`): reproduces the old
 * scripts/build-firefox.sh transforms — no service workers there, so the
 * worker chain runs as an event page via background.scripts (firefox-shim.js
 * first: importScripts no-op + sidePanel→sidebarAction bridge), side_panel
 * becomes sidebar_action, and AMO gets its gecko id. The script list is
 * DERIVED from background-main.js's own importScripts(...) call, so new
 * background dependencies flow in automatically — same single-source-of-truth
 * property the old build had.
 */

/** The classic-script chain background-main.js pulls in via importScripts. */
function backgroundImports(): string[] {
  const source = readFileSync('public/background-main.js', 'utf8');
  const call = source.match(/importScripts\(([^)]*)\)/);
  if (!call) throw new Error('public/background-main.js: importScripts(...) call not found');
  return call[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

export default defineConfig({
  // Build into the visible dist/ folder (not the hidden .output/ default) so
  // "Load unpacked" in Chrome can reach it: pick dist/chrome-mv3. macOS's file
  // picker hides dot-folders, which made the default undiscoverable.
  outDir: 'dist',

  manifest: ({ browser }) => ({
    name: 'Walmart Invoice Exporter',
    version: '7.3',
    description:
      'Export your Walmart order history to Excel, CSV, or PDF — and see where the money went on a built-in spending dashboard.',
    default_locale: 'en',

    host_permissions: ['https://www.walmart.com/*'],
    optional_host_permissions: ['https://www.walmart.ca/*'],

    action: {
      default_icon: {
        '16': 'images/icon16.png',
        '48': 'images/icon48.png',
        '128': 'images/icon128.png',
        '256': 'images/icon256.png',
        '512': 'images/icon512.png',
      },
    },
    icons: {
      '16': 'images/icon16.png',
      '48': 'images/icon48.png',
      '128': 'images/icon128.png',
    },

    options_ui: {
      page: 'dashboard.html?view=settings',
      open_in_tab: true,
    },

    // Classic (non-bundled) content scripts, same files + order as before.
    // These reference public/ files directly; when a file graduates into a
    // Vite module, its group moves to an entrypoints/*.content.ts instead.
    content_scripts: [
      {
        matches: ['https://www.walmart.com/orders*', 'https://www.walmart.ca/orders*'],
        js: ['walmart-mainworld.js'],
        run_at: 'document_start',
        // @ts-expect-error — "world" is valid MV3 (Chrome 111+); missing from wxt's types
        world: 'MAIN',
      },
      {
        matches: ['https://www.walmart.com/orders*'],
        js: [
          'utils.js',
          'providers/base.js',
          'providers/registry.js',
          'providers/walmart-us.js',
          'flags.js',
          'content.js',
        ],
      },
      {
        matches: ['https://www.walmart.ca/orders*'],
        js: [
          'utils.js',
          'providers/base.js',
          'providers/registry.js',
          'providers/walmart-ca.js',
          'flags.js',
          'content.js',
        ],
      },
    ],

    // ---- Per-browser fields ------------------------------------------------
    // (Firefox's background.scripts chain is applied in the manifestGenerated
    // hook below — WXT's own background entrypoint would override it here.)
    ...(browser === 'firefox'
      ? {
          permissions: ['activeTab', 'storage'],
          sidebar_action: {
            default_panel: 'sidepanel.html',
            default_title: 'Walmart Invoice Exporter',
            default_icon: 'images/icon48.png',
          },
          browser_specific_settings: {
            gecko: {
              id: 'walmart-invoice-exporter@hppanpaliya.github.io',
              strict_min_version: '128.0',
            },
          },
        }
      : {
          permissions: ['activeTab', 'storage', 'sidePanel'],
          minimum_chrome_version: '116',
          side_panel: {
            default_path: 'sidepanel.html',
          },
        }),
  }),

  hooks: {
    // Firefox has no service workers (and its event pages have no
    // importScripts), so WXT's generated single-file background can't host the
    // legacy chain. Post-generation, swap it for the classic script list —
    // shim first (importScripts no-op + sidePanel→sidebarAction bridge), then
    // exactly what background-main.js imports, then the worker itself.
    'build:manifestGenerated': (wxt, manifest) => {
      if (wxt.config.browser === 'firefox') {
        manifest.background = {
          scripts: ['firefox-shim.js', ...backgroundImports(), 'background-main.js'],
        } as unknown as typeof manifest.background;
      }
    },
  },
});
