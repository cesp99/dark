// End-to-end suite for the Firefox build (system Firefox driven over WebDriver BiDi).
//   node tests/e2e/firefox.mjs            -> tests dist/firefox
//   node tests/e2e/firefox.mjs --legacy   -> tests the pre-revamp Firefox extension (main branch)
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {
  ROOT, ARTIFACTS, startServer, extractLegacy, decodePng, avgColor, luminance,
  isReddish, isDark, isLight, Suite, assert, sleep,
} from './lib.mjs';

const LEGACY = process.argv.includes('--legacy');
const HEADED = process.argv.includes('--headed');
const extDir = LEGACY ? extractLegacy().firefox : path.join(process.env.DIST_DIR || path.join(ROOT, 'dist'), 'firefox');
assert(fs.existsSync(path.join(extDir, 'manifest.json')), `No manifest in ${extDir} — run npm run build`);
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
const geckoId = manifest.browser_specific_settings.gecko.id;
const popupPath = (manifest.action || manifest.browser_action).default_popup;
const UUID = '0d6c3d4e-5a1b-4c2d-9e8f-123456789abc';

const { server, port } = await startServer();
const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: process.env.FIREFOX_PATH || '/usr/bin/firefox',
  headless: !HEADED,
  defaultViewport: { width: 1000, height: 760 },
  args: ['--remote-allow-system-access'],
  extraPrefsFirefox: {
    'extensions.webextensions.uuids': JSON.stringify({ [geckoId]: UUID }),
    'network.proxy.type': 1,
    'network.proxy.http': '127.0.0.1',
    'network.proxy.http_port': port,
    'network.proxy.no_proxies_on': '',
    'network.proxy.allow_hijacking_localhost': true,
    'dom.security.https_only_mode': false,
    'layout.css.prefers-color-scheme.content-override': 1, // light
    'ui.systemUsesDarkTheme': 0,
    'extensions.manifestV3.enabled': true,
  },
});
await browser.installExtension(extDir);
await sleep(800);

const base = `moz-extension://${UUID}`;

// BiDi navigations into moz-extension:// swap the browsing context's process, which makes
// puppeteer report a detached frame even though the page loads fine. Tolerate that and poll.
async function gotoExt(page, url) {
  page.goto(url).catch(() => {});
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    try {
      const ok = await page.evaluate(u => location.href === u && document.readyState === 'complete', url);
      if (ok) return page;
    } catch { /* context still swapping */ }
  }
  throw new Error(`could not open ${url}`);
}
const suite = new Suite(LEGACY ? 'firefox-legacy' : 'firefox-revamp');
console.log(`\n${suite.name}  (${manifest.name} v${manifest.version}, MV${manifest.manifest_version})\n`);
fs.mkdirSync(ARTIFACTS, { recursive: true });

// An extension page used as a privileged handle for storage/tabs access.
const ext = await browser.newPage();
await gotoExt(ext, `${base}/${popupPath}`);
await sleep(300);
const storage = () => ext.evaluate(() => browser.storage.local.get(null));
const setStorage = o => ext.evaluate(x => browser.storage.local.set(x), o);
const tabIdFor = p => ext.evaluate(async q => (await browser.tabs.query({ url: q }))[0]?.id, p);

async function open(url, settle = 500) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await sleep(settle);
  return page;
}
async function shot(page, name) {
  await page.bringToFront().catch(() => {});
  const buf = Buffer.from(await page.screenshot());
  fs.writeFileSync(path.join(ARTIFACTS, `${suite.name}-${name}.png`), buf);
  return decodePng(buf);
}
async function regionColor(page, png, sel) {
  const b = await page.$eval(sel, el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  return avgColor(png, Math.round(b.x + b.width * 0.25), Math.round(b.y + b.height * 0.25), Math.round(b.width * 0.5), Math.round(b.height * 0.5));
}
const pageTone = (png) => avgColor(png, png.width - 120, png.height - 120, 80, 80);

async function openPopup(pattern) {
  const tabId = pattern ? await tabIdFor(pattern) : undefined;
  const popup = await browser.newPage();
  const errors = [];
  popup.on('pageerror', e => errors.push(e.message));
  popup.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await gotoExt(popup, `${base}/${popupPath}${tabId ? `?tabId=${tabId}` : ''}`);
  await sleep(300);
  // Uncaught errors that happened during load are surfaced through a page-side buffer as well.
  errors.push(...await popup.evaluate(() => window.__errors || []).catch(() => []));
  return { popup, errors };
}

let light;
await suite.test('light page is darkened', async () => {
  light = await open('http://light.test/light.html');
  const c = pageTone(await shot(light, 'light'));
  assert(isDark(c), `bg rgb(${c})`);
  return `bg rgb(${c})`;
});
await suite.test('<img> keeps its original colours', async () => {
  const c = await regionColor(light, await shot(light, 'img'), '#photo');
  assert(isReddish(c), `rgb(${c})`);
});
await suite.test('CSS background-image keeps its original colours', async () => {
  const c = await regionColor(light, await shot(light, 'bg'), '#hero');
  assert(isReddish(c), `rgb(${c})`);
});
await suite.test('coloured UI keeps its hue (blue stays blue)', async () => {
  const c = await regionColor(light, await shot(light, 'blue'), '#blue-panel');
  assert(c[2] > c[0] + 30, `rgb(${c})`);
});
await suite.test('no flash of light content (dark active while parsing)', async () => {
  const early = await light.evaluate(() => window.__earlyDark);
  assert(early === true, `__earlyDark=${early}`);
});
await suite.test('short page: canvas below content is dark', async () => {
  const p = await open('http://short.test/short.html');
  const png = await shot(p, 'short');
  const c = avgColor(png, 20, png.height - 60, png.width - 40, 40);
  await p.close();
  assert(isDark(c), `rgb(${c})`);
});
await suite.test('default list: github.com is left alone', async () => {
  const p = await open('http://www.github.com/light.html');
  const c = pageTone(await shot(p, 'github'));
  await p.close();
  assert(isLight(c), `rgb(${c})`);
});
await suite.test('wildcard *.google.com does NOT match notgoogle.com', async () => {
  const p = await open('http://notgoogle.com/light.html');
  const c = pageTone(await shot(p, 'notgoogle'));
  await p.close();
  assert(isDark(c), `rgb(${c})`);
});
await suite.test('natively dark site stays dark', async () => {
  const p = await open('http://dark.test/dark-native.html', 800);
  const c = pageTone(await shot(p, 'native-dark'));
  await p.close();
  assert(isDark(c), `rgb(${c})`);
});
await suite.test('popup opens without errors', async () => {
  const { popup, errors } = await openPopup('http://light.test/*');
  await shot(popup, 'popup');
  await popup.close();
  assert(errors.length === 0, errors.join(' | '));
});
await suite.test('popup: add a site to the list', async () => {
  const { popup } = await openPopup('http://light.test/*');
  const input = LEGACY ? '#siteInput' : '#site-input';
  const add = LEGACY ? '#addSiteBtn' : '#site-add';
  await popup.evaluate(LEGACY ? () => document.querySelector('.tab[data-tab="sites"]').click()
    : () => document.querySelector('[data-tab="sites"]')?.click());
  await popup.type(input, 'ff-added.com');
  await popup.click(add);
  await sleep(300);
  const s = await storage();
  await popup.close();
  assert((s.blacklist_sites || []).includes('ff-added.com'), JSON.stringify(s.blacklist_sites));
});

if (!LEGACY) {
  await suite.test('site toggle applies live (no reload)', async () => {
    const { popup } = await openPopup('http://light.test/*');
    await popup.evaluate(() => document.getElementById('site-toggle').click());
    await sleep(600);
    const off = pageTone(await shot(light, 'toggle-off'));
    await popup.evaluate(() => document.getElementById('site-toggle').click());
    await sleep(600);
    const on = pageTone(await shot(light, 'toggle-on'));
    await popup.close();
    assert(isLight(off) && isDark(on), `off rgb(${off}) on rgb(${on})`);
  });
  await suite.test('master switch disables and re-enables', async () => {
    await setStorage({ enabled: false }); await sleep(500);
    const off = pageTone(await shot(light, 'master-off'));
    await setStorage({ enabled: true }); await sleep(500);
    const on = pageTone(await shot(light, 'master-on'));
    assert(isLight(off) && isDark(on), `off rgb(${off}) on rgb(${on})`);
  });
  await suite.test('keyboard command handler toggles the site (runtime message)', async () => {
    const tabId = await tabIdFor('http://light.test/*');
    await ext.evaluate(id => browser.runtime.sendMessage({ type: 'toggle-site', tabId: id }), tabId);
    await sleep(600);
    const off = pageTone(await shot(light, 'cmd-off'));
    await ext.evaluate(id => browser.runtime.sendMessage({ type: 'toggle-site', tabId: id }), tabId);
    await sleep(600);
    const on = pageTone(await shot(light, 'cmd-on'));
    assert(isLight(off) && isDark(on), `off rgb(${off}) on rgb(${on})`);
  });
}

const failed = suite.summary();
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
