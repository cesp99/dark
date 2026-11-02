// End-to-end suite for the Chromium build. Usage:
//   node tests/e2e/chrome.mjs            -> tests dist/chrome (run `npm run build` first)
//   node tests/e2e/chrome.mjs --legacy   -> tests the pre-revamp extension from the main branch
//   node tests/e2e/chrome.mjs --headed   -> show the browser
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  ROOT, ARTIFACTS, startServer, extractLegacy, decodePng, avgColor, luminance,
  isReddish, isDark, isLight, Suite, assert, sleep, waitFor,
} from './lib.mjs';

const LEGACY = process.argv.includes('--legacy');
const HEADED = process.argv.includes('--headed');
const extDir = LEGACY ? extractLegacy().chrome : path.join(process.env.DIST_DIR || path.join(ROOT, 'dist'), 'chrome');
assert(fs.existsSync(path.join(extDir, 'manifest.json')), `No manifest in ${extDir} — run npm run build`);
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
const popupPath = manifest.action.default_popup;

const { server, port } = await startServer();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dark-chrome-profile-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: !HEADED,
  viewport: { width: 1000, height: 760 },
  deviceScaleFactor: 1,
  colorScheme: 'light',
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    `--host-resolver-rules=MAP * 127.0.0.1:${port}`,
  ],
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
await sleep(500); // let onInstalled finish seeding defaults

const suite = new Suite(LEGACY ? 'chrome-legacy' : 'chrome-revamp');
console.log(`\n${suite.name}  (extension ${extId}, ${manifest.name} v${manifest.version})\n`);
fs.mkdirSync(ARTIFACTS, { recursive: true });

const storage = () => sw.evaluate(() => chrome.storage.local.get(null));
const setStorage = obj => sw.evaluate(o => chrome.storage.local.set(o), obj);

async function open(url, { settle = 400 } = {}) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await sleep(settle);
  return page;
}

async function shot(page, name) {
  const buf = await page.screenshot();
  fs.writeFileSync(path.join(ARTIFACTS, `${suite.name}-${name}.png`), buf);
  return decodePng(buf);
}

async function regionColor(page, png, selector) {
  const b = await page.locator(selector).boundingBox();
  assert(b, `${selector} not found`);
  return avgColor(png, Math.round(b.x + b.width * 0.25), Math.round(b.y + b.height * 0.25),
    Math.round(b.width * 0.5), Math.round(b.height * 0.5));
}

/** Background colour of the page body region (no text). */
async function pageTone(page, png) {
  const vp = page.viewportSize();
  return avgColor(png, vp.width - 120, vp.height - 120, 80, 80);
}

async function tabIdFor(urlPattern) {
  return sw.evaluate(async p => (await chrome.tabs.query({ url: p }))[0]?.id, urlPattern);
}

async function openPopup(targetPattern) {
  const tabId = targetPattern ? await tabIdFor(targetPattern) : undefined;
  const popup = await context.newPage();
  const errors = [];
  popup.on('pageerror', e => errors.push(e.message));
  popup.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await popup.setViewportSize({ width: 400, height: 640 });
  await popup.goto(`chrome-extension://${extId}/${popupPath}${tabId ? `?tabId=${tabId}` : ''}`);
  await sleep(400);
  return { popup, errors };
}

// ---------------------------------------------------------------- engine
// Note: github.com / google.com are HSTS-preloaded, so Chromium refuses plain http to them;
// the list tests use the other default entries (aploi.de, *.eyed.to) instead.
let light;
await suite.test('light page is darkened', async () => {
  light = await open('http://light.test/light.html');
  const png = await shot(light, 'light');
  const c = await pageTone(light, png);
  assert(isDark(c), `page background is rgb(${c}) lum=${luminance(c).toFixed(2)}`);
  return `bg rgb(${c})`;
});

await suite.test('text block becomes light-on-dark', async () => {
  const png = await shot(light, 'light-text');
  const c = await regionColor(light, png, '#text-block');
  assert(luminance(c) < 0.35, `text block region rgb(${c})`);
});

await suite.test('<img> keeps its original colours', async () => {
  const png = await shot(light, 'light-img');
  const c = await regionColor(light, png, '#photo');
  assert(isReddish(c), `image rendered as rgb(${c}), expected red`);
  return `rgb(${c})`;
});

await suite.test('CSS background-image keeps its original colours', async () => {
  const png = await shot(light, 'light-bg');
  const c = await regionColor(light, png, '#hero');
  assert(isReddish(c), `background image rendered as rgb(${c}), expected red`);
  return `rgb(${c})`;
});

await suite.test('coloured UI keeps its hue (blue stays blue)', async () => {
  const png = await shot(light, 'light-blue');
  const c = await regionColor(light, png, '#blue-panel');
  assert(c[2] > c[0] + 30, `blue panel rendered as rgb(${c})`);
  return `rgb(${c})`;
});

await suite.test('no flash of light content (dark active while parsing)', async () => {
  const early = await light.evaluate(() => window.__earlyDark);
  assert(early === true, `__earlyDark=${early}`);
});

await suite.test('short page: canvas below content is dark', async () => {
  const p = await open('http://short.test/short.html');
  const png = await shot(p, 'short');
  const vp = p.viewportSize();
  const c = avgColor(png, 20, vp.height - 60, vp.width - 40, 40);
  await p.close();
  assert(isDark(c), `bottom area rgb(${c})`);
});

await suite.test('default list: aploi.de is left alone', async () => {
  const p = await open('http://www.aploi.de/light.html');
  const c = await pageTone(p, await shot(p, 'aploi'));
  await p.close();
  assert(isLight(c), `aploi.de rendered rgb(${c})`);
});

await suite.test('wildcard *.eyed.to matches mail.eyed.to', async () => {
  const p = await open('http://mail.eyed.to/light.html');
  const c = await pageTone(p, await shot(p, 'mail-eyed'));
  await p.close();
  assert(isLight(c), `mail.eyed.to rendered rgb(${c})`);
});

await suite.test('wildcard *.eyed.to matches bare eyed.to', async () => {
  const p = await open('http://eyed.to/light.html');
  const c = await pageTone(p, await shot(p, 'eyed'));
  await p.close();
  assert(isLight(c), `eyed.to rendered rgb(${c})`);
});

await suite.test('wildcard *.eyed.to does NOT match noteyed.to', async () => {
  const p = await open('http://noteyed.to/light.html');
  const c = await pageTone(p, await shot(p, 'noteyed'));
  await p.close();
  assert(isDark(c), `noteyed.to rendered rgb(${c})`);
});

await suite.test('natively dark site stays dark', async () => {
  const p = await open('http://dark.test/dark-native.html', { settle: 700 });
  const c = await pageTone(p, await shot(p, 'native-dark'));
  await p.close();
  assert(isDark(c), `native dark page rendered rgb(${c})`);
});

await suite.test('color-scheme: dark site stays dark', async () => {
  const p = await open('http://scheme.test/dark-scheme.html', { settle: 700 });
  const c = await pageTone(p, await shot(p, 'scheme-dark'));
  await p.close();
  assert(isDark(c), `color-scheme dark page rendered rgb(${c})`);
});

await suite.test('performance: style/layout cost on a 4000-row page', async () => {
  const p = await context.newPage();
  const cdp = await context.newCDPSession(p);
  await cdp.send('Performance.enable');
  await p.goto('http://heavy.test/heavy.html', { waitUntil: 'load' });
  await sleep(800);
  await p.mouse.wheel(0, 4000); await sleep(300); await p.mouse.wheel(0, -4000); await sleep(300);
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map(x => [x.name, x.value]));
  const style = Math.round(m.RecalcStyleDuration * 1000), layout = Math.round(m.LayoutDuration * 1000);
  const script = Math.round(m.ScriptDuration * 1000);
  fs.writeFileSync(path.join(ARTIFACTS, `${suite.name}-perf.json`), JSON.stringify({ style, layout, script, raw: m }, null, 2));
  await p.close();
  assert(style < 200, `RecalcStyle ${style}ms`);
  return `recalcStyle=${style}ms layout=${layout}ms script=${script}ms`;
});

// ---------------------------------------------------------------- popup
const P = LEGACY
  ? { input: '#siteInput', add: '#addSiteBtn' }
  : { input: '#site-input', add: '#site-add' };

await suite.test('popup opens without errors', async () => {
  const { popup, errors } = await openPopup('http://light.test/*');
  await shot(popup, 'popup');
  await popup.close();
  assert(errors.length === 0, `popup errors: ${errors.join(' | ')}`);
});

await suite.test('popup: add a site to the list', async () => {
  const { popup, errors } = await openPopup('http://light.test/*');
  if (!LEGACY) await popup.locator('[data-tab="sites"], #tab-sites').first().click().catch(() => {});
  else await popup.locator('.tab[data-tab="sites"]').click();
  await popup.fill(P.input, 'added-example.com');
  await popup.click(P.add);
  await sleep(300);
  const s = await storage();
  const list = s.blacklist_sites || [];
  await popup.close();
  assert(list.includes('added-example.com'), `blacklist_sites=${JSON.stringify(list)} errors=${errors.join(' | ')}`);
});

if (!LEGACY) {
  await suite.test('popup: invalid pattern shows an inline error (no alert)', async () => {
    const { popup } = await openPopup('http://light.test/*');
    let dialog = false;
    popup.on('dialog', d => { dialog = true; d.dismiss(); });
    await popup.locator('[data-tab="sites"], #tab-sites').first().click().catch(() => {});
    await popup.fill('#site-input', 'not a domain!!');
    await popup.click('#site-add');
    await sleep(200);
    const visible = await popup.locator('#site-error').isVisible();
    const text = (await popup.locator('#site-error').textContent())?.trim();
    await popup.close();
    assert(!dialog, 'used alert()');
    assert(visible && text, 'no inline error shown');
  });

  await suite.test('popup: pasting a full URL adds its hostname', async () => {
    const { popup } = await openPopup('http://light.test/*');
    await popup.locator('[data-tab="sites"], #tab-sites').first().click().catch(() => {});
    await popup.fill('#site-input', 'https://www.Pasted-Example.org/some/path?q=1');
    await popup.click('#site-add');
    await sleep(300);
    const s = await storage();
    await popup.close();
    assert(s.blacklist_sites.includes('pasted-example.org'), JSON.stringify(s.blacklist_sites));
  });

  await suite.test('popup: remove a site from the list', async () => {
    const { popup } = await openPopup('http://light.test/*');
    await popup.locator('[data-tab="sites"], #tab-sites').first().click().catch(() => {});
    await popup.locator('#site-list [data-site="pasted-example.org"] button[data-remove]').click();
    await sleep(300);
    const s = await storage();
    await popup.close();
    assert(!s.blacklist_sites.includes('pasted-example.org'), JSON.stringify(s.blacklist_sites));
  });

  await suite.test('popup shows current host and status', async () => {
    const { popup } = await openPopup('http://light.test/*');
    const host = (await popup.locator('#current-host').textContent()).trim();
    const status = (await popup.locator('#site-status').textContent()).trim();
    const checked = await popup.locator('#site-toggle').isChecked();
    await popup.close();
    assert(host === 'light.test', `host="${host}"`);
    assert(checked, 'site toggle should be on for a darkened site');
    return `status="${status}"`;
  });

  await suite.test('site toggle applies live to all tabs of that site (no reload)', async () => {
    const second = await open('http://light.test/light.html?second');
    const { popup } = await openPopup('http://light.test/light.html');
    await popup.locator('#site-toggle').click({ force: true });
    await sleep(500);
    const c1 = await pageTone(light, await shot(light, 'toggle-off-1'));
    const c2 = await pageTone(second, await shot(second, 'toggle-off-2'));
    const s = await storage();
    assert(isLight(c1) && isLight(c2), `after toggle off: tab1 rgb(${c1}) tab2 rgb(${c2})`);
    assert(s.blacklist_sites.includes('light.test'), 'light.test not added to blacklist');
    await popup.locator('#site-toggle').click({ force: true });
    await sleep(500);
    const c3 = await pageTone(light, await shot(light, 'toggle-on'));
    await popup.close(); await second.close();
    assert(isDark(c3), `after toggle on: rgb(${c3})`);
  });

  await suite.test('master switch disables and re-enables everywhere', async () => {
    const { popup } = await openPopup('http://light.test/light.html');
    await popup.locator('#master-toggle').click({ force: true });
    await sleep(500);
    const off = await pageTone(light, await shot(light, 'master-off'));
    await popup.locator('#master-toggle').click({ force: true });
    await sleep(500);
    const on = await pageTone(light, await shot(light, 'master-on'));
    await popup.close();
    assert(isLight(off), `master off: rgb(${off})`);
    assert(isDark(on), `master on: rgb(${on})`);
  });

  await suite.test('brightness slider changes rendering live', async () => {
    const { popup } = await openPopup('http://light.test/light.html');
    const before = await pageTone(light, await shot(light, 'bright-before'));
    await popup.locator('#brightness').fill('60');
    await popup.locator('#brightness').dispatchEvent('change');
    await sleep(500);
    const after = await pageTone(light, await shot(light, 'bright-after'));
    const s = await storage();
    await popup.locator('#brightness').fill('100');
    await popup.locator('#brightness').dispatchEvent('change');
    await sleep(300);
    await popup.close();
    assert(Number(s.brightness) === 60, `stored brightness=${s.brightness}`);
    assert(luminance(after) < luminance(before) || (before.join() !== after.join()), `before rgb(${before}) after rgb(${after})`);
    return `rgb(${before}) -> rgb(${after})`;
  });

  await suite.test('whitelist mode darkens only listed sites', async () => {
    await setStorage({ listMode: 'whitelist', whitelist_sites: ['listed.test'] });
    await sleep(400);
    const a = await open('http://listed.test/light.html');
    const b = await open('http://unlisted.test/light.html');
    const ca = await pageTone(a, await shot(a, 'wl-listed'));
    const cb = await pageTone(b, await shot(b, 'wl-unlisted'));
    await a.close(); await b.close();
    await setStorage({ listMode: 'blacklist' });
    await sleep(300);
    assert(isDark(ca), `listed rgb(${ca})`);
    assert(isLight(cb), `unlisted rgb(${cb})`);
  });

  await suite.test('popup mode switch updates storage', async () => {
    const { popup } = await openPopup('http://light.test/light.html');
    await popup.locator('#mode-whitelist').check({ force: true });
    await sleep(300);
    const s1 = await storage();
    await popup.locator('#mode-blacklist').check({ force: true });
    await sleep(300);
    const s2 = await storage();
    await popup.close();
    assert(s1.listMode === 'whitelist' && s2.listMode === 'blacklist', `${s1.listMode} -> ${s2.listMode}`);
  });

  await suite.test('follow system theme: light OS leaves pages light', async () => {
    await setStorage({ followSystem: true });
    await light.emulateMedia({ colorScheme: 'light' });
    await sleep(400);
    const c1 = await pageTone(light, await shot(light, 'follow-light'));
    await light.emulateMedia({ colorScheme: 'dark' });
    await sleep(400);
    const c2 = await pageTone(light, await shot(light, 'follow-dark'));
    await setStorage({ followSystem: false });
    await light.emulateMedia({ colorScheme: 'light' });
    await sleep(400);
    assert(isLight(c1), `OS light: rgb(${c1})`);
    assert(isDark(c2), `OS dark: rgb(${c2})`);
  });

  await suite.test('keyboard command is declared (Alt+Shift+D)', async () => {
    const cmd = Object.values(manifest.commands || {})[0];
    assert(cmd && /Alt\+Shift\+D/i.test(cmd.suggested_key?.default || ''), JSON.stringify(manifest.commands));
  });

  await suite.test('keyboard command toggles the active site', async () => {
    await light.bringToFront();
    const tabId = await tabIdFor('http://light.test/light.html');
    await sw.evaluate(id => globalThis.toggleSiteForTab(id), tabId);
    await sleep(500);
    const off = await pageTone(light, await shot(light, 'cmd-off'));
    await sw.evaluate(id => globalThis.toggleSiteForTab(id), tabId);
    await sleep(500);
    const on = await pageTone(light, await shot(light, 'cmd-on'));
    assert(isLight(off) && isDark(on), `off rgb(${off}) on rgb(${on})`);
  });

  await suite.test('popup handles restricted pages gracefully', async () => {
    const p = await context.newPage();
    await p.goto('chrome://version');
    const { popup, errors } = await openPopup('chrome://version/');
    const status = (await popup.locator('#site-status').textContent()).trim();
    const disabled = await popup.locator('#site-toggle').isDisabled();
    await popup.close(); await p.close();
    assert(errors.length === 0, errors.join(' | '));
    assert(disabled, 'site toggle should be disabled on restricted pages');
    return `status="${status}"`;
  });

  const registration = () => sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts({ ids: ['dark-early'] }))[0] || null);
  const engineOn = page => page.evaluate(() => !!document.getElementById('dark-by-eyed'));

  await suite.test('IP addresses in the list and the native-dark cache keep the early script registered', async () => {
    const saved = await storage();
    await setStorage({ blacklist_sites: [...saved.blacklist_sites, 'kept.test', '192.168.1.1', '123'], nativeDarkHosts: ['127.0.0.1', '10.0.0.7'] });
    await sleep(600);
    const reg = await registration();
    const kept = await open('http://kept.test/light.html');
    const k = [await kept.evaluate(() => window.__earlyDark), await engineOn(kept)];
    await kept.close();
    await setStorage({ listMode: 'whitelist', whitelist_sites: ['wl.test', '192.168.1.1'] });
    await sleep(600);
    const wlReg = await registration();
    const wl = await open('http://wl.test/light.html');
    const w = [await wl.evaluate(() => window.__earlyDark), await engineOn(wl)];
    await wl.close();
    await setStorage({ listMode: 'blacklist', blacklist_sites: saved.blacklist_sites, whitelist_sites: saved.whitelist_sites || [], nativeDarkHosts: [] });
    await sleep(400);
    const ex = reg?.excludeMatches || [];
    assert(ex.includes('*://kept.test/*') && ex.includes('*://192.168.1.1/*') && ex.includes('*://127.0.0.1/*'), `excludeMatches=${JSON.stringify(ex)}`);
    assert(k.join() === 'false,false', `kept.test early=${k[0]} on=${k[1]} (should stay light, no flash)`);
    assert(wlReg && wlReg.matches.includes('*://wl.test/*') && wlReg.matches.includes('*://192.168.1.1/*'), `whitelist registration ${JSON.stringify(wlReg)}`);
    assert(w.join() === 'true,true', `wl.test early=${w[0]} on=${w[1]} (should be dark without a flash)`);
  });

  await suite.test('a pattern the browser rejects is dropped on its own, not with every exclude', async () => {
    const r = await sw.evaluate(() => globalThis.dropInvalidPatterns({
      id: 'dark-early', js: ['engine.js', 'early.js'], runAt: 'document_start', allFrames: false,
      matches: ['<all_urls>'], excludeMatches: ['*://ok.test/*', '*://www.1.2.3.4/*', '*://www.ok.test/*'],
    }));
    assert(JSON.stringify(r.excludeMatches) === JSON.stringify(['*://ok.test/*', '*://www.ok.test/*']), JSON.stringify(r));
  });

  await suite.test('settings writes update the early script in place (never unregistered in between)', async () => {
    const r = await sw.evaluate(async () => {
      const orig = chrome.scripting.unregisterContentScripts;
      let calls = 0;
      chrome.scripting.unregisterContentScripts = (...a) => { calls++; return orig.apply(chrome.scripting, a); };
      try {
        await chrome.storage.local.set({ nativeDarkHosts: ['gap.test'] });
        await globalThis.syncEarlyScript();
        const [reg] = await chrome.scripting.getRegisteredContentScripts({ ids: ['dark-early'] });
        await chrome.storage.local.set({ nativeDarkHosts: [] });
        await globalThis.syncEarlyScript();
        const [reg2] = await chrome.scripting.getRegisteredContentScripts({ ids: ['dark-early'] });
        return { calls, has: reg.excludeMatches.includes('*://gap.test/*'), gone: !(reg2.excludeMatches || []).includes('*://gap.test/*') };
      } finally {
        chrome.scripting.unregisterContentScripts = orig;
      }
    });
    assert(r.calls === 0 && r.has && r.gone, JSON.stringify(r));
  });

  await suite.test('a dark page on a host does not un-darken light pages of that host', async () => {
    const lightTab = await open('http://site.test/light.html');
    const darkTab = await open('http://site.test/dark-native.html', { settle: 900 });
    const cache = (await storage()).nativeDarkHosts;
    const other = await engineOn(lightTab);
    const fresh = await open('http://site.test/light.html?fresh', { settle: 600 });
    const freshOn = await engineOn(fresh);
    await lightTab.close(); await darkTab.close(); await fresh.close();
    await setStorage({ nativeDarkHosts: [] });
    assert(cache.includes('site.test'), `cache ${JSON.stringify(cache)}`);
    assert(other && freshOn, `open light tab on=${other}, fresh light visit on=${freshOn}`);
  });

  await suite.test('site switch forces dark mode on a natively dark site, and turns it off again', async () => {
    const page = await open('http://forced.test/dark-native.html', { settle: 900 });
    const { popup } = await openPopup('http://forced.test/*');
    const before = [await popup.locator('#site-toggle').isChecked(), (await popup.locator('#site-status').textContent()).trim()];
    await popup.locator('#site-toggle').click({ force: true });
    await sleep(700);
    const on = [await popup.locator('#site-toggle').isChecked(), await engineOn(page), (await storage()).forceDark_sites];
    await page.reload({ waitUntil: 'load' }); await sleep(900);
    const afterReload = await engineOn(page);
    await popup.locator('#site-toggle').click({ force: true });
    await sleep(700);
    const off = [await popup.locator('#site-toggle').isChecked(), await engineOn(page), (await storage()).forceDark_sites, (await storage()).blacklist_sites.includes('forced.test')];
    await popup.close(); await page.close();
    await setStorage({ nativeDarkHosts: [] });
    assert(before[0] === false && before[1] === 'Uses its own dark theme.', `before: checked=${before[0]} "${before[1]}"`);
    assert(on[0] && on[1] && on[2].includes('forced.test') && afterReload, `on: checked=${on[0]} engine=${on[1]} forced=${JSON.stringify(on[2])} afterReload=${afterReload}`);
    assert(!off[0] && !off[1] && !off[2].includes('forced.test') && !off[3], `off: ${JSON.stringify(off)}`);
  });

  const sitesTab = async popup => { await popup.locator('[data-tab="sites"]').click(); await sleep(150); };

  await suite.test('popup: Enter on a search term filters instead of adding a junk site', async () => {
    const saved = (await storage()).blacklist_sites;
    await setStorage({ blacklist_sites: [...saved, 'one.test', 'two.test', 'three.test'] });
    const { popup } = await openPopup('http://light.test/light.html');
    await sitesTab(popup);
    await popup.fill('#site-input', 'goog');
    await popup.press('#site-input', 'Enter');
    await sleep(300);
    const list = (await storage()).blacklist_sites;
    const shown = await popup.locator('#site-list li').count();
    const note = (await popup.locator('#site-note').textContent()).trim();
    await popup.close();
    await setStorage({ blacklist_sites: saved });
    assert(!list.includes('goog') && shown === 1, `list=${JSON.stringify(list)} shown=${shown} note="${note}"`);
  });

  await suite.test('popup: writes from elsewhere keep keyboard focus in the site list', async () => {
    const saved = (await storage()).blacklist_sites;
    const many = Array.from({ length: 30 }, (_, i) => `site${String(i).padStart(3, '0')}.example.org`);
    await setStorage({ blacklist_sites: many });
    const { popup } = await openPopup('http://light.test/light.html');
    await sitesTab(popup);
    await popup.locator('[data-site="site010.example.org"] button[data-remove]').focus();
    await setStorage({ nativeDarkHosts: ['somewhere.test'] });
    await sleep(300);
    const a = await popup.evaluate(() => document.activeElement.getAttribute('aria-label'));
    await setStorage({ blacklist_sites: [...many, 'zzz.example.org'] }); // the list itself changes
    await sleep(300);
    const b = await popup.evaluate(() => document.activeElement.getAttribute('aria-label'));
    await popup.close();
    await setStorage({ blacklist_sites: saved, nativeDarkHosts: [] });
    assert(a === 'Remove site010.example.org' && b === 'Remove site010.example.org', `focus: "${a}", then "${b}"`);
  });

  await suite.test('popup: Undo stays while focused; hidden notes leave no stale description', async () => {
    const saved = (await storage()).blacklist_sites;
    await setStorage({ blacklist_sites: [...saved, 'undo.test'] });
    const { popup } = await openPopup('http://light.test/light.html');
    await sitesTab(popup);
    const desc0 = await popup.locator('#site-input').getAttribute('aria-describedby');
    await popup.locator('[data-site="undo.test"] button[data-remove]').click();
    await sleep(200);
    await popup.locator('#site-undo').focus();
    await sleep(7600);
    const stillThere = await popup.locator('#site-note').isVisible();
    await popup.locator('#site-input').focus();
    await sleep(7400);
    const gone = !(await popup.locator('#site-note').isVisible());
    const desc = await popup.locator('#site-input').getAttribute('aria-describedby');
    await popup.close();
    await setStorage({ blacklist_sites: saved });
    assert(desc0 === null, `fresh popup: input described by ${desc0}`);
    assert(stillThere && gone && desc === null, `visible while focused=${stillThere}, hidden later=${gone}, describedby=${desc}`);
  });

  await suite.test('popup: Reset keeps keyboard focus; sliders announce a percentage', async () => {
    const { popup } = await openPopup('http://light.test/light.html');
    await popup.locator('#sepia').focus();
    await popup.keyboard.press('ArrowRight');
    await sleep(200);
    const valuetext = await popup.locator('#sepia').getAttribute('aria-valuetext');
    await popup.locator('#reset-adjust').focus();
    await popup.keyboard.press('Enter');
    await sleep(300);
    const r = await popup.evaluate(() => [document.activeElement.id, document.getElementById('reset-adjust').getAttribute('aria-disabled')]);
    await popup.close();
    await setStorage({ sepia: 0 });
    assert(valuetext === '1%', `aria-valuetext=${valuetext}`);
    assert(r[0] === 'reset-adjust' && r[1] === 'true', `focus on #${r[0]}, aria-disabled=${r[1]}`);
  });

  await suite.test('popup: long hostnames stay inside the panel', async () => {
    const long = `${'a'.repeat(63)}.${'b'.repeat(63)}.example.com`;
    const page = await open(`http://${long}/light.html`);
    const saved = (await storage()).blacklist_sites;
    const { popup } = await openPopup(`http://${long}/*`);
    await sitesTab(popup);
    const quick = await popup.evaluate(() => [document.getElementById('site-add-current').getBoundingClientRect().right, document.body.clientWidth]);
    await popup.locator('#site-add-current').click();
    await sleep(300);
    await popup.fill('#site-input', long);
    await popup.click('#site-add');
    await sleep(300);
    const note = await popup.evaluate(() => { const n = document.getElementById('site-note'); return [n.scrollWidth, n.clientWidth]; });
    await popup.close(); await page.close();
    await setStorage({ blacklist_sites: saved });
    assert(quick[0] <= quick[1] + 1, `quick-add right edge ${quick[0]} > ${quick[1]}`);
    assert(note[0] <= note[1] + 1, `note scrollWidth ${note[0]} > clientWidth ${note[1]}`);
  });

  await suite.test('popup: Unicode (IDN) sites can be typed and are shown in Unicode', async () => {
    const page = await open('http://xn--mnchen-3ya.de/light.html');
    const saved = (await storage()).blacklist_sites;
    const { popup } = await openPopup('http://xn--mnchen-3ya.de/*');
    const host = (await popup.locator('#current-host').textContent()).trim();
    await sitesTab(popup);
    await popup.fill('#site-input', 'bücher.example');
    await popup.click('#site-add');
    await sleep(300);
    const list = (await storage()).blacklist_sites;
    const shown = (await popup.locator('[data-site="xn--bcher-kva.example"] .pattern').textContent()).trim();
    await popup.close(); await page.close();
    await setStorage({ blacklist_sites: saved });
    assert(host === 'münchen.de', `header "${host}"`);
    assert(list.includes('xn--bcher-kva.example') && shown === 'bücher.example', `stored ${JSON.stringify(list)}, shown "${shown}"`);
  });

  await suite.test('migration: v1 "www." entries are normalised (and excluded from the early script)', async () => {
    const saved = (await storage()).blacklist_sites;
    await setStorage({ blacklist_sites: [...saved, 'www.wwwentry.test', 'WWW.Upper.test'] });
    await sw.evaluate(() => globalThis.migrateStorage());
    await sleep(500);
    const list = (await storage()).blacklist_sites;
    const ex = (await registration())?.excludeMatches || [];
    const p = await open('http://wwwentry.test/light.html');
    const early = await p.evaluate(() => window.__earlyDark);
    await p.close();
    await setStorage({ blacklist_sites: saved });
    assert(list.includes('wwwentry.test') && list.includes('upper.test') && !list.some(x => x.startsWith('www.')), JSON.stringify(list));
    assert(ex.includes('*://wwwentry.test/*') && early === false, `excludeMatches has wwwentry.test: ${ex.includes('*://wwwentry.test/*')}, early=${early}`);
  });

  await suite.test('migration: legacy "blacklisted_sites" key is merged', async () => {
    await setStorage({ blacklisted_sites: ['legacy-key.example'] });
    await sw.evaluate(() => globalThis.migrateStorage());
    const s = await storage();
    assert(s.blacklist_sites.includes('legacy-key.example') && !('blacklisted_sites' in s), JSON.stringify(s));
  });
}

if (!LEGACY) {
  // Last: granting file access reloads the extension.
  await suite.test('local file:// pages stay dark (Chrome with "Allow access to file URLs")', async () => {
    const ext = await context.newPage();
    await ext.goto('chrome://extensions');
    const res = await ext.evaluate(id => new Promise(r => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, fileAccess: true }, () => r(chrome.runtime.lastError?.message || 'ok'))), extId);
    await ext.close();
    await sleep(1500);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dark-file-'));
    const file = path.join(dir, 'local.html');
    fs.copyFileSync(path.join(ROOT, 'tests/e2e/fixtures/light.html'), file);
    const p = await open(`file://${file}`, { settle: 900 });
    const c = await pageTone(p, await shot(p, 'file'));
    const r = await p.evaluate(() => [window.__earlyDark, !!document.getElementById('dark-by-eyed')]);
    await p.close();
    fs.rmSync(dir, { recursive: true, force: true });
    assert(res === 'ok', `could not grant file access: ${res}`);
    assert(r.join() === 'true,true' && isDark(c), `early=${r[0]} engine=${r[1]} page rgb(${c})`);
  });
}

const failed = suite.summary();
await context.close();
server.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
