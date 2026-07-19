/**
 * Record the Chrome Web Store tour video from the REAL packaged extension
 * running in the e2e harness — synthetic, PII-free seeded data only (no real
 * orders, accounts, or names anywhere).
 *
 * Capture: 1920×1080 via a raw CDP screencast (JPEG quality 100 per frame,
 * real frame timestamps) written to video-raw/frames + concat.txt.
 * Playwright's recordVideo is NOT used: it hard-codes a ~1 Mbps VP8 encode,
 * which is visibly soft no matter how the mp4 is encoded afterwards. Also
 * note: screencast frames always come at CSS-viewport size — a larger
 * deviceScaleFactor/recordVideo size does not raise capture resolution
 * (verified: it just letterboxes). The 4K master is built encode-side
 * (lanczos) by generate-store-video.sh.
 *
 * DIRECTION (ad cut, ~80s) — structure: HOOK → REVEAL → MAKE IT YOURS →
 * PAYOFFS (in dark) → OBJECTIONS → CTA. No intro card: the store page
 * already shows the name and icon, so the first frame is the product doing
 * its core verb, live. The settings visit comes EARLY and flips dark mode,
 * so most of the runtime plays in dark.
 *
 *   1. Cold open   — "Check for new orders" clicked on camera; real progress,
 *                    two new orders join the list. Hook: "one click".
 *   2. Reveal      — the dashboard turns that click into answers (stats, chart).
 *   3. Yours       — Settings walk: Collection, Export defaults (cycle the
 *                    default format through every mode, land back on Excel),
 *                    then Appearance → Dark. Everything after runs dark.
 *   4. Drill       — click a month, whole page rescopes.
 *   5. Montage     — Items (personal inflation), Trends (habits) — fast beats.
 *   6. Receipts    — Orders view, a row expands into a full invoice.
 *   7. Take it     — select orders, "tax season in two clicks".
 *   8. Trust       — privacy beat on the "Delete all saved data" button.
 *   9. Kicker      — Year in review.
 *  10. CTA card    — "Add to Chrome — it's free".
 *
 * The tour is fully in-page (injected cursor, caption pills, outro card), so
 * the recording needs no post-production editing.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { launch, seedOrderHistory } = require(path.join(__dirname, '..', '..', 'tests', 'e2e', 'helpers', 'harness'));

const OUT = path.join(__dirname, 'video-raw'); // gitignored scratch output
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const W = 1920;   // CSS layout size — the UI is designed/readable at this width
const H = 1080;

/**
 * High-quality recorder: raw CDP screencast → JPEG q100 frames + a concat
 * list with real per-frame durations (screencast only emits on paint, so
 * static holds simply extend the previous frame — correct VFR timing).
 */
async function startCapture(page, dir) {
  const framesDir = path.join(dir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });
  const session = await page.context().newCDPSession(page);
  const frames = []; // { file, ts }
  session.on('Page.screencastFrame', (event) => {
    const file = path.join(framesDir, `f${String(frames.length).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(event.data, 'base64'));
    frames.push({ file, ts: event.metadata.timestamp });
    session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  await session.send('Page.startScreencast', {
    format: 'jpeg', quality: 100, maxWidth: W, maxHeight: H, everyNthFrame: 1,
  });
  return async function stop() {
    await session.send('Page.stopScreencast').catch(() => {});
    if (frames.length < 2) throw new Error(`screencast captured only ${frames.length} frame(s)`);
    const lines = ["ffconcat version 1.0"];
    for (let i = 0; i < frames.length; i += 1) {
      const next = frames[i + 1];
      const duration = next ? Math.max(0.001, next.ts - frames[i].ts) : 0.04;
      lines.push(`file '${path.relative(dir, frames[i].file)}'`);
      lines.push(`duration ${duration.toFixed(4)}`);
    }
    fs.writeFileSync(path.join(dir, 'concat.txt'), lines.join('\n') + '\n');
    const span = frames[frames.length - 1].ts - frames[0].ts;
    console.log(`captured ${frames.length} frames over ${span.toFixed(1)}s`);
  };
}

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
    #tourCard .chip { font-size:24px; font-weight:800; border-radius:999px; padding:14px 34px;
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
    await panel.close();

    const dash = await context.newPage();
    await dash.goto(`chrome-extension://${extensionId}/dashboard.html`);
    await dash.waitForSelector('.cbar', { timeout: 10000 });
    const frame = dash.frames().find((f) => f.url().endsWith('sidepanel.html'));
    await frame.waitForSelector('.order-list .order-row', { timeout: 10000 });
    await dash.waitForTimeout(600);
    await dash.evaluate(TOUR_RUNTIME);
    const stopCapture = await startCapture(dash, OUT); // roll camera on scene 1, not page load

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
    // Smooth-scroll a settings section title into view inside the panel iframe.
    const frameScrollToSection = async (title, ms = 1200) => {
      await frame.evaluate((wanted) => {
        const el = [...document.querySelectorAll('.settings-section-title')]
          .find((node) => node.textContent.trim().toLowerCase().startsWith(wanted.toLowerCase()));
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, title);
      await hold(ms);
    };

    /* ---- 1. Cold open: the core verb, live. No title card. ---- */
    await cap('Your entire Walmart history — <b>one click</b>');
    await hold(500);
    await click(frame.locator('#startCollection'), 900);
    // Real collection against the harness's mock walmart.com: progress line
    // ticks, then two new orders join the list without the "saved" chip.
    await frame.waitForFunction(
      () => /completed/i.test((document.querySelector('#progress') || {}).textContent || ''),
      { timeout: 15000 }
    ).catch(() => {});
    await hold(2400);

    /* ---- 2. Reveal: the click becomes answers. ---- */
    await cap('…turned into <b>answers</b>');
    await hold(2200);
    await scrollTo(430, 1100);      // chart in full view
    await hold(1600);

    /* ---- 3. Yours (early): settings walk, format cycle, dark flip. ---- */
    await cap('Make it yours — <b>every default is a setting</b>');
    await click(frame.locator('#settingsButton'), 700);
    await hold(1500);
    await frameScrollToSection('Collection', 1600);
    await frameScrollToSection('Export', 1200);
    // Cycle the default export format through every mode — the point is the
    // breadth — and land back on Excel.
    await cap('Excel, CSV, JSON, receipts, PDF — <b>your call</b>');
    await curTo(frame.locator('#settingsExportFormat'), 500);
    for (const fmt of ['csv', 'json', 'receipt', 'pdf', 'xlsx']) {
      await frame.selectOption('#settingsExportFormat', fmt).catch(() => {});
      await hold(700);
    }
    await hold(400);
    await frameScrollToSection('Appearance', 1100);
    await cap('Light, dark, or follow your system — <b>one tap</b>');
    await click(frame.locator('#themeControl [data-theme-choice="dark"]'), 700);
    await hold(2200);
    // Leave settings so the order list is on stage for the scenes ahead.
    await click(frame.locator('#settingsBackButton'), 500);
    await hold(700);

    /* ---- 4. Drill (dark): click a month, everything rescopes. ---- */
    await cap('Click any month — see <b>exactly where it went</b>');
    await scrollTo(430, 900);
    await click(dash.locator('.cbar').first(), 800);
    await hold(1900);
    await scrollTo(0, 900);
    await hold(1400);
    await cap('');
    await click(dash.locator('#backChip'));
    await hold(800);

    /* ---- 5. Montage (dark): fast payoff beats. ---- */
    await cap('Every price hike, <b>caught</b>');
    await click(dash.locator('[data-nav="items"]'));
    await hold(2900);

    await cap('Your habits, <b>charted</b>');
    await click(dash.locator('[data-nav="trends"]'));
    await hold(1600);
    await scrollTo(360, 1000);
    await hold(1200);
    await scrollTo(0, 600);

    /* ---- 6. Receipts (dark): a row becomes a full invoice. ---- */
    await cap('Every order, down to <b>the last cent</b>');
    await click(dash.locator('[data-nav="orders"]'));
    await hold(1500);
    const invoiceRow = dash.locator('tr.order-row:has(.saved-chip)').first();
    await invoiceRow.scrollIntoViewIfNeeded();
    await hold(500);
    await click(invoiceRow, 700);
    await dash.waitForSelector('.detail-wrap', { timeout: 10000 });
    await hold(600);
    await dash.locator('.detail-wrap').scrollIntoViewIfNeeded();
    await dash.evaluate(() => window.scrollBy({ top: -140, behavior: 'smooth' }));
    await hold(2500);

    /* ---- 7. Take it with you (dark): two clicks. ---- */
    await cap('Tax season? <b>Two clicks.</b>');
    await click(dash.locator('[data-nav="overview"]'));
    await hold(800);
    const boxes = frame.locator('.order-list input[type="checkbox"]');
    await click(boxes.nth(0), 700);
    await hold(300);
    await click(boxes.nth(1), 450);
    await hold(700);
    await curTo(frame.locator('#singleFileDownload'), 500);
    await hold(1500);

    /* ---- 8. Trust (dark): the objection killer, right before the ask. ---- */
    await cap('No accounts. No servers. <b>Nothing leaves your device.</b>');
    await click(frame.locator('#settingsButton'), 700);
    await hold(900);
    await frameScrollToSection('Data on this device', 1300);
    await curTo(frame.locator('#deleteAllDataButton'), 700); // point, never click
    await hold(2500);

    /* ---- 9. Kicker (dark): year in review. ---- */
    await cap('Your year at Walmart — <b>yours to keep</b>');
    await click(dash.locator('[data-nav="review"]'));
    await hold(2300);
    await scrollTo(380, 1000);
    await hold(1300);

    /* ---- 10. CTA card. ---- */
    await cap('');
    await dash.evaluate(() => window.__tour.hideCursor(true));
    await dash.evaluate((icon) => window.__tour.card({
      iconUrl: icon,
      title: 'Walmart Invoice Exporter',
      sub: 'Free · Open source · <b>Private by design</b>',
      chips: ['Add to Chrome — it’s free'],
    }), `chrome-extension://${extensionId}/images/icon128.png`);
    // Reset the theme behind the opaque outro card (no visible flash).
    await dash.evaluate(() => chrome.storage.local.set({ theme: 'system' }));
    await hold(3800);

    await stopCapture();
    console.log('raw frames + concat saved in', OUT);
  } finally {
    await close();
  }
})();
