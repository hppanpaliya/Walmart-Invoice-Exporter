/**
 * Record the Chrome Web Store tour video from the REAL packaged extension
 * running in the e2e harness — synthetic, PII-free seeded data only (no real
 * orders, accounts, or names anywhere).
 *
 * Output: store-assets/scripts/video-raw/tour.webm (raw Playwright capture)
 * Encode + trim happens in generate-store-video.sh (ffmpeg).
 *
 * The tour is fully in-page: an injected fake cursor (tweened, click pulses),
 * bottom caption pills, and intro/outro cards — so the recording needs no
 * post-production editing.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { launch, seedOrderHistory } = require(path.join(__dirname, '..', '..', 'tests', 'e2e', 'helpers', 'harness'));

const OUT = path.join(__dirname, 'video-raw'); // gitignored scratch output
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const W = 1920;
const H = 1080;

/** Injected once into the dashboard page: cursor, captions, cards. */
const TOUR_RUNTIME = () => {
  const Z = 2147483000;
  const root = document.createElement('div');
  root.id = 'tourRoot';
  root.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${Z};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;`;
  document.body.appendChild(root);

  const style = document.createElement('style');
  style.textContent = `
    #tourCursor { position:fixed; width:26px; height:26px; margin:-13px 0 0 -13px;
      border-radius:50%; background:rgba(0,113,220,.28); border:2.5px solid #0071dc;
      box-shadow:0 2px 10px rgba(0,40,100,.35), inset 0 0 6px rgba(255,255,255,.5);
      left:0; top:0; will-change:transform; }
    .tour-pulse { position:fixed; width:26px; height:26px; margin:-13px 0 0 -13px;
      border-radius:50%; border:3px solid #0071dc; opacity:.9;
      animation:tourPulse .55s ease-out forwards; }
    @keyframes tourPulse { to { transform:scale(2.6); opacity:0; } }
    #tourCaption { position:fixed; left:50%; bottom:56px; transform:translateX(-50%) translateY(24px);
      background:rgba(11,28,48,.92); color:#fff; font-size:30px; font-weight:700;
      letter-spacing:-0.01em; padding:16px 34px; border-radius:999px; opacity:0;
      transition:opacity .45s ease, transform .45s ease; white-space:nowrap;
      box-shadow:0 12px 40px rgba(5,20,45,.45); }
    #tourCaption.on { opacity:1; transform:translateX(-50%) translateY(0); }
    #tourCaption b { color:#ffc220; font-weight:800; }
    #tourCard { position:fixed; inset:0; display:flex; flex-direction:column; align-items:center;
      justify-content:center; gap:26px; text-align:center; opacity:0; transition:opacity .6s ease;
      background:linear-gradient(135deg,#0053ab 0%,#0071dc 55%,#0a80f5 100%); }
    #tourCard.on { opacity:1; }
    #tourCard img { width:132px; height:132px; border-radius:28px;
      box-shadow:0 14px 44px rgba(0,25,60,.5); }
    #tourCard .t { color:#fff; font-size:64px; font-weight:800; letter-spacing:-0.02em; line-height:1.05; }
    #tourCard .s { color:#dcecff; font-size:30px; font-weight:600; max-width:900px; line-height:1.4; }
    #tourCard .s b { color:#ffc220; }
    #tourCard .chips { display:flex; gap:14px; margin-top:6px; }
    #tourCard .chip { font-size:22px; font-weight:700; border-radius:999px; padding:10px 24px;
      background:rgba(255,255,255,.16); color:#fff; border:1.5px solid rgba(255,255,255,.35); }
    #tourCard .chip.gold { background:#ffc220; color:#23304a; border-color:#ffc220; }
  `;
  document.head.appendChild(style);

  const cursor = document.createElement('div');
  cursor.id = 'tourCursor';
  cursor.style.transform = `translate(${innerWidth / 2}px, ${innerHeight + 60}px)`;
  root.appendChild(cursor);

  const caption = document.createElement('div');
  caption.id = 'tourCaption';
  root.appendChild(caption);

  let cx = innerWidth / 2;
  let cy = innerHeight + 60;

  window.__tour = {
    /** Tween the fake cursor to (x, y) over ms. */
    moveTo(x, y, ms = 600) {
      return new Promise((resolve) => {
        const x0 = cx, y0 = cy, t0 = performance.now();
        const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
        const step = (now) => {
          const t = Math.min(1, (now - t0) / ms);
          const k = ease(t);
          cx = x0 + (x - x0) * k;
          cy = y0 + (y - y0) * k;
          cursor.style.transform = `translate(${cx}px, ${cy}px)`;
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
    },
    pulse() {
      const p = document.createElement('div');
      p.className = 'tour-pulse';
      p.style.left = `${cx}px`;
      p.style.top = `${cy}px`;
      root.appendChild(p);
      setTimeout(() => p.remove(), 600);
    },
    caption(html) {
      if (!html) { caption.classList.remove('on'); return; }
      const swap = () => { caption.innerHTML = html; caption.classList.add('on'); };
      if (caption.classList.contains('on')) {
        caption.classList.remove('on');
        setTimeout(swap, 300);
      } else swap();
    },
    card({ iconUrl, title, sub, chips }) {
      let el = document.getElementById('tourCard');
      if (!el) {
        el = document.createElement('div');
        el.id = 'tourCard';
        root.appendChild(el);
      }
      el.innerHTML =
        (iconUrl ? `<img src="${iconUrl}">` : '') +
        `<div class="t">${title}</div>` +
        (sub ? `<div class="s">${sub}</div>` : '') +
        (chips && chips.length
          ? `<div class="chips">${chips.map((c, i) => `<span class="chip${i === 0 ? ' gold' : ''}">${c}</span>`).join('')}</div>`
          : '');
      requestAnimationFrame(() => el.classList.add('on'));
    },
    hideCard() {
      const el = document.getElementById('tourCard');
      if (el) el.classList.remove('on');
    },
    hideCursor(hide) { cursor.style.display = hide ? 'none' : ''; },
  };
};

(async () => {
  const { context, extensionId, panel, close } = await launch({
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT, size: { width: W, height: H } },
  });
  try {
    // Prefer the sanitized real-history fixture (sanitize-seed.js) when it
    // exists — richer, realistic, still PII-free. Falls back to synthetic.
    const fixturePath = path.join(__dirname, 'seed-data.json');
    const records = fs.existsSync(fixturePath)
      ? JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
      : null;
    console.log(records ? `seeding sanitized fixture (${records.length} orders)` : 'seeding synthetic data');
    await seedOrderHistory(panel, { months: 14, records });
    await panel.close(); // its video file is discarded below

    const dash = await context.newPage();
    await dash.goto(`chrome-extension://${extensionId}/dashboard.html`);
    await dash.waitForSelector('.cbar', { timeout: 10000 });
    const frame = dash.frames().find((f) => f.url().endsWith('sidepanel.html'));
    await frame.waitForSelector('.order-list .order-row', { timeout: 10000 });
    await dash.waitForTimeout(600);
    await dash.evaluate(TOUR_RUNTIME);

    const hold = (ms) => dash.waitForTimeout(ms);
    const cap = (html) => dash.evaluate((h) => window.__tour.caption(h), html);
    const scrollTo = async (y, ms = 900) => {
      await dash.evaluate((top) => window.scrollTo({ top, behavior: 'smooth' }), y);
      await hold(ms);
    };
    /** Tween cursor to a locator's center; returns the point. */
    const curTo = async (locator, ms = 650) => {
      const box = await locator.boundingBox();
      if (!box) throw new Error('no bounding box for tour target');
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await dash.evaluate(([px, py, pms]) => window.__tour.moveTo(px, py, pms), [x, y, ms]);
      await dash.mouse.move(x, y);
      return { x, y };
    };
    const click = async (locator, ms = 650) => {
      const { x, y } = await curTo(locator, ms);
      await dash.evaluate(() => window.__tour.pulse());
      await hold(120);
      await dash.mouse.click(x, y);
    };

    /* ---------- Scene 0: intro card (page loads behind it) ---------- */
    await dash.evaluate((icon) => window.__tour.card({
      iconUrl: icon,
      title: 'Walmart Invoice Exporter',
      sub: 'Your entire Walmart order history — <b>collected, exported, understood</b>.',
      chips: ['Excel', 'CSV', 'JSON', 'PDF', 'Receipts'],
    }), `chrome-extension://${extensionId}/images/icon128.png`);
    await hold(3200);
    await dash.evaluate(() => window.__tour.hideCard());
    await hold(700);

    /* ---------- Scene 1: overview hero ---------- */
    await cap('Every order — <b>on one dashboard</b>, stored only on your device');
    await hold(2600);
    await scrollTo(430, 1100);      // chart in full view
    await hold(1400);

    /* ---------- Scene 2: month drill-down ---------- */
    await cap('Click any month to see <b>exactly where it went</b>');
    await click(dash.locator('.cbar').first(), 800);
    await hold(1800);
    await scrollTo(0, 900);
    await hold(1500);
    await cap('');
    await click(dash.locator('#backChip'));
    await hold(900);

    /* ---------- Scene 3: items ---------- */
    await cap('Every item you have ever bought — <b>searchable</b>');
    await click(dash.locator('[data-nav="items"]'));
    await hold(2600);
    await scrollTo(320, 1000);
    await hold(1500);

    /* ---------- Scene 4: trends ---------- */
    await cap('Price watch &amp; <b>spending trends</b>');
    await click(dash.locator('[data-nav="trends"]'));
    await hold(2600);
    await scrollTo(360, 1000);
    await hold(1500);
    await scrollTo(0, 600);

    /* ---------- Scene 5: orders + inline invoice ---------- */
    await cap('Every order expands into <b>a full invoice</b>');
    await click(dash.locator('[data-nav="orders"]'));
    await hold(1600);
    const invoiceRow = dash.locator('tr.order-row:has(.saved-chip)').first();
    await invoiceRow.scrollIntoViewIfNeeded();
    await hold(500);
    await click(invoiceRow, 700);
    await dash.waitForSelector('.detail-wrap', { timeout: 10000 });
    await hold(600);
    await dash.locator('.detail-wrap').scrollIntoViewIfNeeded();
    await dash.evaluate(() => window.scrollBy({ top: -140, behavior: 'smooth' }));
    await hold(2600);

    /* ---------- Scene 6: export from the embedded panel ---------- */
    await cap('Select orders, pick a format — <b>export in two clicks</b>');
    await click(dash.locator('[data-nav="overview"]'));
    await hold(900);
    const boxes = frame.locator('.order-list input[type="checkbox"]');
    await click(boxes.nth(0), 700);
    await hold(350);
    await click(boxes.nth(1), 450);
    await hold(700);
    // Cycle the export format so the download buttons visibly re-label.
    await curTo(frame.locator('#exportFormat'), 500);
    for (const fmt of ['csv', 'pdf', 'xlsx']) {
      await frame.selectOption('#exportFormat', fmt).catch(() => {});
      await hold(650);
    }
    await curTo(frame.locator('#singleFileDownload'), 500);
    await hold(1200);

    /* ---------- Scene 7: dark mode ---------- */
    await cap('Automatic <b>dark mode</b>');
    await dash.evaluate(() => chrome.storage.local.set({ theme: 'dark' }));
    await hold(1800);
    await cap('Year in review — <b>your year at Walmart</b>');
    await click(dash.locator('[data-nav="review"]'));
    await hold(2600);
    await scrollTo(380, 1000);
    await hold(1400);
    await dash.evaluate(() => chrome.storage.local.set({ theme: 'system' }));
    await hold(800);

    /* ---------- Scene 8: privacy ---------- */
    await cap('No accounts. No servers. <b>Your data never leaves your device.</b>');
    await click(dash.locator('[data-nav="overview"]'));
    await hold(400);
    await scrollTo(0, 600);
    await click(frame.locator('#settingsButton'), 700);
    await hold(2800);

    /* ---------- Scene 9: outro card ---------- */
    await cap('');
    await dash.evaluate(() => window.__tour.hideCursor(true));
    await dash.evaluate((icon) => window.__tour.card({
      iconUrl: icon,
      title: 'Walmart Invoice Exporter',
      sub: 'Free · Open source · <b>Private by design</b>',
      chips: ['Get it on the Chrome Web Store'],
    }), `chrome-extension://${extensionId}/images/icon128.png`);
    await hold(3600);

    await dash.close(); // flush the recording
    const video = dash.video();
    const recorded = await video.path();
    fs.copyFileSync(recorded, path.join(OUT, 'tour.webm'));
    console.log('raw tour saved:', path.join(OUT, 'tour.webm'));
  } finally {
    await close();
  }

  // Drop Playwright's hash-named page videos, keep only tour.webm.
  for (const file of fs.readdirSync(OUT)) {
    if (file !== 'tour.webm') fs.rmSync(path.join(OUT, file));
  }
})();
