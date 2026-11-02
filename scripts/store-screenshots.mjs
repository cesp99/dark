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

/**
 * Composes a store screenshot like the v1 listing: Chrome's toolbar edge as a thin strip at the top
 * and the action popup hanging from it at the top right. With `split`, the left half shows `beforeBuf`
 * (dark mode off) and the right half `pageBuf` (on), separated by a comparison handle.
 */
async function compose(name, pageBuf, popupBuf, { split = null } = {}) {
  const c = await ctx.newPage();
  await c.setViewportSize({ width: W, height: H });
  const src = b => `data:image/png;base64,${b.toString('base64')}`;
  const half = W / 2;
  const splitHtml = split ? `
    <img class="page before" src="${src(split)}">
    <div class="divider"></div>
    <div class="handle"><svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="#1b1b1f" stroke-width="2.2"
      stroke-linecap="round" stroke-linejoin="round"><path d="M8 6 3 11l5 5M14 6l5 5-5 5"/></svg></div>` : '';
  await c.setContent(`<!doctype html><style>
    html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#000}
    .page{position:absolute;inset:0;width:${W}px;height:${H}px}
    .before{clip-path:inset(0 ${W - half}px 0 0)}
    .divider{position:absolute;top:0;bottom:0;left:${half - 1}px;width:2px;background:rgba(255,255,255,.92);
      box-shadow:0 0 0 1px rgba(0,0,0,.18)}
    .handle{position:absolute;left:${half - 23}px;top:${H / 2 - 23}px;width:46px;height:46px;border-radius:50%;
      background:#f4f1ea;display:grid;place-items:center;box-shadow:0 6px 18px rgba(0,0,0,.35),0 0 0 1px rgba(0,0,0,.12)}
    .toolbar{position:absolute;left:0;right:0;top:0;height:8px;background:#1f1f22}
    .toolbar::after{content:"";position:absolute;left:200px;right:36px;top:-12px;height:18px;border-radius:9px;background:#2c2c30}
    .popup{position:absolute;top:4px;right:${POPUP.right}px;width:${POPUP.width}px;height:${POPUP.height}px;
      border-radius:8px;overflow:hidden;
      box-shadow:0 0 0 1px rgba(255,255,255,.08),0 16px 44px rgba(0,0,0,.45),0 3px 10px rgba(0,0,0,.3)}
    .popup img{display:block}
  </style><img class="page" src="${src(pageBuf)}">${splitHtml}
  <div class="toolbar"></div><div class="popup"><img src="${src(popupBuf)}"></div>`);
  await wait(200);
  const png = PNG.sync.read(await c.screenshot());
  fs.writeFileSync(path.join(OUT, name), PNG.sync.write(png, { colorType: 2 }));
  await c.close();
  console.log(`wrote store/screenshots/${name}`);
}

for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.rmSync(path.join(OUT, f));

const original = await get(null);
const without = list => (list || []).filter(s => s !== HOST);
try {
  // Dark mode on medium.com
  await set({ enabled: true, listMode: 'blacklist', brightness: 100, contrast: 100, sepia: 0,
    blacklist_sites: without(original.blacklist_sites) });
  const darkPage = await capturePage();
  const popupOn = await capturePopup();

  // Same site switched off (kept light)
  await set({ blacklist_sites: [...(await get('blacklist_sites')).blacklist_sites, HOST] });
  const lightPage = await capturePage();
  const popupOff = await capturePopup();

  // 1. Before / after: left half off, right half on, popup over the dark half
  await compose('1-before-after.png', darkPage, popupOn, { split: lightPage });
  // 2 + 3. The v1 listing pair: dark mode on, and the site kept light
  await compose('2-dark-on-medium.png', darkPage, popupOn);
  await compose('3-site-kept-light.png', lightPage, popupOff);

  // 4. Warmer, dimmer reading: brightness / sepia adjusted live
  await set({ blacklist_sites: without((await get('blacklist_sites')).blacklist_sites),
    brightness: 90, contrast: 105, sepia: 35 });
  await compose('4-adjust-brightness-sepia.png', await capturePage(), await capturePopup());

  // 5. Site lists tab
  await set({ brightness: 100, contrast: 100, sepia: 0 });
  await compose('5-site-lists.png', await capturePage(), await capturePopup(async p => {
    await p.locator('[data-tab="sites"]').first().click();
    await wait(300);
  }));
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
