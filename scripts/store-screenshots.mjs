// Generates the Chrome Web Store / AMO screenshots (1280x800, 24-bit PNG) on medium.com.
//   npm run build && node scripts/store-screenshots.mjs [--headless]
// Output: store/screenshots/*.png
// Runs headed by default (needs a display): medium.com is more likely to challenge headless browsers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'dist/chrome');
const OUT = path.join(ROOT, 'store/screenshots');
const SITE = 'https://medium.com/';
const HOST = 'medium.com';
const W = 1280, H = 800;
const POPUP = { width: 352, height: 600, right: 56, top: 10 };

if (!fs.existsSync(path.join(EXT, 'manifest.json'))) throw new Error('Run `npm run build` first');
fs.mkdirSync(OUT, { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dark-store-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: process.argv.includes('--headless'),
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  locale: 'en-US',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const wait = ms => new Promise(r => setTimeout(r, ms));
await wait(800);
const set = o => sw.evaluate(x => chrome.storage.local.set(x), o);
const get = k => sw.evaluate(x => chrome.storage.local.get(x), k);

const site = await ctx.newPage();
await site.goto(SITE, { waitUntil: 'load', timeout: 60000 });
await wait(3000);
const tabId = await sw.evaluate(async h => (await chrome.tabs.query({ url: `*://*.${h}/*` }))[0]?.id
  ?? (await chrome.tabs.query({ url: `*://${h}/*` }))[0]?.id, HOST);
if (tabId == null) throw new Error('medium.com tab not found');

const popup = await ctx.newPage();
await popup.setViewportSize({ width: POPUP.width, height: POPUP.height });

async function capturePage() {
  await site.bringToFront();
  await wait(900);
  return site.screenshot();
}

async function capturePopup(prepare) {
  await popup.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`);
  await popup.bringToFront();
  await wait(700);
  if (prepare) await prepare(popup);
  await popup.evaluate(() => document.activeElement?.blur());
  await popup.mouse.move(0, POPUP.height - 1);
  await wait(400);
  return popup.screenshot();
}

/** Places the popup over the page like Chrome's action popup and writes a 24-bit PNG. */
async function compose(name, pageBuf, popupBuf) {
  const c = await ctx.newPage();
  await c.setViewportSize({ width: W, height: H });
  const src = b => `data:image/png;base64,${b.toString('base64')}`;
  await c.setContent(`<!doctype html><style>
    html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#000}
    .page{position:absolute;inset:0;width:${W}px;height:${H}px}
    .popup{position:absolute;top:${POPUP.top}px;right:${POPUP.right}px;width:${POPUP.width}px;height:${POPUP.height}px;
      border-radius:10px;overflow:hidden;
      box-shadow:0 0 0 1px rgba(255,255,255,.07),0 18px 50px rgba(0,0,0,.45),0 4px 14px rgba(0,0,0,.3)}
    .popup img{display:block}
  </style><img class="page" src="${src(pageBuf)}"><div class="popup"><img src="${src(popupBuf)}"></div>`);
  await wait(200);
  const png = PNG.sync.read(await c.screenshot());
  fs.writeFileSync(path.join(OUT, name), PNG.sync.write(png, { colorType: 2 }));
  await c.close();
  console.log(`wrote store/screenshots/${name}`);
}

const original = await get(null);
try {
  // 1. Dark mode on medium.com
  await set({ enabled: true, listMode: 'blacklist', brightness: 100, contrast: 100, sepia: 0,
    blacklist_sites: (original.blacklist_sites || []).filter(s => s !== HOST) });
  await compose('1-dark-on-medium.png', await capturePage(), await capturePopup());

  // 2. Same site switched off (kept light), like the original listing's first screenshot
  await set({ blacklist_sites: [...(await get('blacklist_sites')).blacklist_sites, HOST] });
  await compose('2-site-kept-light.png', await capturePage(), await capturePopup());

  // 3. Warmer, dimmer reading: brightness / sepia adjusted live
  await set({ blacklist_sites: (await get('blacklist_sites')).blacklist_sites.filter(s => s !== HOST),
    brightness: 90, contrast: 105, sepia: 35 });
  await compose('3-adjust-brightness-sepia.png', await capturePage(), await capturePopup());

  // 4. Site lists tab
  await set({ brightness: 100, contrast: 100, sepia: 0 });
  await compose('4-site-lists.png', await capturePage(), await capturePopup(async p => {
    await p.locator('[data-tab="sites"]').first().click();
    await wait(300);
  }));
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
