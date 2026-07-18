/**
 * Compose Chrome Web Store assets (exact-size PNGs) from the raw UI captures.
 * Renders each layout as a local HTML file and screenshots it at 1:1.
 * Output: <repo>/store-assets/{screenshots,tiles}/
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const RAW = path.join(__dirname, 'store-raw');
const REPO = path.join(__dirname, '..', '..');
const OUT_SHOTS = path.join(REPO, 'store-assets', 'screenshots');
const OUT_TILES = path.join(REPO, 'store-assets', 'tiles');
const WORK = path.join(__dirname, 'compose-work');
for (const dir of [OUT_SHOTS, OUT_TILES, WORK]) fs.mkdirSync(dir, { recursive: true });

const img = (name) => `file://${path.join(RAW, name)}`;
const icon = (name) => `file://${path.join(REPO, 'images', name)}`;

const BASE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .canvas { position: relative; width: 100%; height: 100%; overflow: hidden; }
  .bg-light { background: linear-gradient(135deg, #eaf2fc 0%, #f7fafd 45%, #e3f0ff 100%); }
  .bg-blue  { background: linear-gradient(135deg, #0053ab 0%, #0071dc 55%, #0a80f5 100%); }
  .bg-dark  { background: linear-gradient(135deg, #0b1420 0%, #101b2a 60%, #0d2036 100%); }
  .headline { font-weight: 800; letter-spacing: -0.02em; color: #0b1c30; }
  .sub { color: #47586d; font-weight: 500; }
  .bg-dark .headline, .bg-blue .headline { color: #ffffff; }
  .bg-dark .sub { color: #9fb1c6; }
  .bg-blue .sub { color: #cfe4ff; }
  .shot-card {
    border-radius: 14px; overflow: hidden;
    box-shadow: 0 24px 70px rgba(9, 30, 60, 0.28), 0 4px 16px rgba(9, 30, 60, 0.18);
    background: #fff; font-size: 0;
  }
  .shot-card img { display: block; }
  .chips { display: flex; gap: 10px; flex-wrap: wrap; }
  .chip {
    font-weight: 700; border-radius: 999px; background: #0071dc; color: #fff;
    box-shadow: 0 2px 8px rgba(0, 60, 130, 0.25);
  }
  .chip.alt { background: #ffc220; color: #23304a; }
  .accent { color: #0071dc; }
  .bg-dark .accent { color: #6db3ff; }
`;

/* ---- 1280x800 store screenshots ---- */

// 1. Hero: headline on top, dashboard filling the rest, cropped at the bottom.
const heroHtml = (bgClass, headline, sub, image) => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  .top { padding: 44px 72px 30px; display: flex; align-items: flex-end; justify-content: space-between; gap: 40px; }
  .headline { font-size: 42px; line-height: 1.08; max-width: 760px; }
  .sub { font-size: 19px; line-height: 1.4; max-width: 380px; text-align: right; }
  .stage { position: absolute; left: 72px; right: 72px; top: 178px; }
  .shot-card img { width: 100%; }
</style></head><body><div class="canvas ${bgClass}">
  <div class="top"><div class="headline">${headline}</div><div class="sub">${sub}</div></div>
  <div class="stage"><div class="shot-card"><img src="${image}"></div></div>
</div></body></html>`;

// 2. Split: text block left, tall panel capture right.
const splitHtml = (bgClass, headline, subHtml, image) => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  .wrap { display: flex; height: 100%; align-items: center; gap: 64px; padding: 0 84px; }
  .text { flex: 1; }
  .headline { font-size: 46px; line-height: 1.1; margin-bottom: 26px; }
  .sub { font-size: 20px; line-height: 1.55; margin-bottom: 30px; }
  .chip { font-size: 17px; padding: 9px 18px; }
  ul.plain { list-style: none; }
  ul.plain li { font-size: 20px; font-weight: 600; color: #22354d; padding: 9px 0 9px 38px; position: relative; }
  ul.plain li::before { content: "✓"; position: absolute; left: 0; top: 7px; width: 26px; height: 26px;
    border-radius: 50%; background: #0071dc; color: #fff; font-size: 15px; font-weight: 800;
    display: flex; align-items: center; justify-content: center; }
  .stage { flex: 0 0 auto; }
  .shot-card img { height: 700px; }
</style></head><body><div class="canvas ${bgClass}">
  <div class="wrap">
    <div class="text"><div class="headline">${headline}</div>${subHtml}</div>
    <div class="stage"><div class="shot-card"><img src="${image}"></div></div>
  </div>
</div></body></html>`;

/* ---- promo tiles ---- */

const smallTileHtml = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  .wrap { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
  .row { display: flex; align-items: center; gap: 16px; }
  .row img { width: 72px; height: 72px; border-radius: 16px; box-shadow: 0 6px 18px rgba(0,30,70,.35); }
  .name { color: #fff; font-size: 27px; font-weight: 800; letter-spacing: -0.01em; line-height: 1.15; max-width: 240px; }
  .tag { color: #ffc220; font-size: 17px; font-weight: 700; letter-spacing: 0.01em; }
</style></head><body><div class="canvas bg-blue">
  <div class="wrap">
    <div class="row"><img src="${icon('icon128.png')}"><div class="name">Walmart Invoice Exporter</div></div>
    <div class="tag">Orders → Excel, CSV &amp; PDF</div>
  </div>
</div></body></html>`;

const marqueeHtml = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  .wrap { display: flex; height: 100%; align-items: center; gap: 56px; padding: 0 0 0 84px; }
  .text { flex: 0 0 480px; }
  .brand { display: flex; align-items: center; gap: 18px; margin-bottom: 24px; }
  .brand img { width: 84px; height: 84px; border-radius: 18px; box-shadow: 0 8px 22px rgba(0,30,70,.4); }
  .name { color: #fff; font-size: 34px; font-weight: 800; letter-spacing: -0.01em; line-height: 1.1; }
  .tag { color: #eaf4ff; font-size: 21px; font-weight: 600; line-height: 1.45; margin-bottom: 24px; }
  .tag b { color: #ffc220; }
  .chip { font-size: 15px; padding: 7px 15px; }
  .chip.alt { background: #ffc220; }
  .stage { flex: 1; align-self: flex-end; }
  .shot-card { border-radius: 12px 0 0 0; box-shadow: 0 18px 60px rgba(0, 20, 50, 0.5); }
  .shot-card img { width: 780px; }
</style></head><body><div class="canvas bg-blue">
  <div class="wrap">
    <div class="text">
      <div class="brand"><img src="${icon('icon128.png')}"><div class="name">Walmart Invoice Exporter</div></div>
      <div class="tag">Every Walmart order — collected, exported, and <b>understood</b>.</div>
      <div class="chips"><span class="chip alt">XLSX</span><span class="chip">CSV</span><span class="chip">JSON</span><span class="chip">PDF</span><span class="chip">Receipts</span></div>
    </div>
    <div class="stage"><div class="shot-card"><img src="${img('dash-light.png')}"></div></div>
  </div>
</div></body></html>`;

const SPECS = [
  {
    out: path.join(OUT_SHOTS, '01-hero-dashboard-1280x800.png'), w: 1280, h: 800,
    html: heroHtml('bg-light',
      'Your entire Walmart order history,<br>exported <span class="accent">and understood</span>',
      'One click collects every order. Export to Excel — or explore the built-in spending dashboard.',
      img('dash-light.png')),
  },
  {
    out: path.join(OUT_SHOTS, '02-export-formats-1280x800.png'), w: 1280, h: 800,
    html: splitHtml('bg-light',
      'Five formats.<br><span class="accent">Two clicks.</span>',
      `<div class="sub">One combined workbook or one file per order — with product photos if you want them.</div>
       <div class="chips"><span class="chip alt">Excel</span><span class="chip">CSV</span><span class="chip">JSON</span><span class="chip">PDF</span><span class="chip">Receipts</span></div>`,
      img('panel-list.png')),
  },
  {
    out: path.join(OUT_SHOTS, '03-month-drilldown-1280x800.png'), w: 1280, h: 800,
    html: heroHtml('bg-light',
      'Click any month to see<br><span class="accent">exactly where it went</span>',
      'Totals, price watch, and most-bought all rescope together — then export just that month.',
      img('dash-month.png')),
  },
  {
    out: path.join(OUT_SHOTS, '04-dark-mode-1280x800.png'), w: 1280, h: 800,
    html: heroHtml('bg-dark',
      'Easy on the eyes',
      'Automatic dark mode across the dashboard and the panel — or pick your own.',
      img('dash-dark.png')),
  },
  {
    out: path.join(OUT_SHOTS, '05-privacy-1280x800.png'), w: 1280, h: 800,
    html: splitHtml('bg-light',
      'Your data never<br><span class="accent">leaves your device</span>',
      `<ul class="plain">
         <li>No accounts, no servers, no tracking</li>
         <li>Orders stored locally in your browser</li>
         <li>One honest “Delete all saved data” button</li>
         <li>Open source on GitHub</li>
       </ul>`,
      img('panel-settings.png')),
  },
  { out: path.join(OUT_TILES, 'small-tile-440x280.png'), w: 440, h: 280, html: smallTileHtml },
  { out: path.join(OUT_TILES, 'marquee-1400x560.png'), w: 1400, h: 560, html: marqueeHtml },
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const spec of SPECS) {
    const file = path.join(WORK, path.basename(spec.out, '.png') + '.html');
    fs.writeFileSync(file, spec.html);
    await page.setViewportSize({ width: spec.w, height: spec.h });
    await page.goto(`file://${file}`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: spec.out });
    console.log('wrote', path.relative(REPO, spec.out));
  }
  await browser.close();
})();
