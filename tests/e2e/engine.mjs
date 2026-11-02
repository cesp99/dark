// Engine-focused end-to-end checks (photo backgrounds, nesting, SPA content, shadow DOM, top layer,
// fixed headers, native-dark heuristics, script cost) against the built extension.
//   node tests/e2e/engine.mjs             Chromium (Playwright), loads $DIST_DIR/chrome
//   node tests/e2e/engine.mjs --firefox   Firefox (puppeteer-core over BiDi), loads $DIST_DIR/firefox
// Uses its own fixture server because these fixtures need real text/css MIME types and a
// cross-origin stylesheet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  ROOT, ARTIFACTS, decodePng, avgColor, isReddish, isDark, isLight, Suite, assert, sleep,
} from './lib.mjs';

const FIREFOX = process.argv.includes('--firefox');
const HEADED = process.argv.includes('--headed');
const FIXTURES = path.join(ROOT, 'tests/e2e/fixtures');
const extDir = path.join(process.env.DIST_DIR || path.join(ROOT, 'dist'), FIREFOX ? 'firefox' : 'chrome');
assert(fs.existsSync(path.join(extDir, 'manifest.json')), `No manifest in ${extDir} — run npm run build`);
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));

/** 4000 rows, every 40th with a photo background from a stylesheet. */
function heavyPage() {
  const rows = [];
  for (let i = 0; i < 4000; i++) rows.push(`<div class="row r${i % 50}${i % 40 === 0 ? ' photo-bg' : ''}"><span>Row ${i}</span> <a href="#">link</a></div>`);
  return `<!doctype html><html><head><link rel="stylesheet" href="engine-cases.css"><style>.row{height:40px}</style></head><body>${rows.join('')}</body></html>`;
}

/** An infinite-scroll feed: N rows, and photo cards styled only by a cross-origin (unreadable) stylesheet. */
function feedPage(n) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(`<div class="row"><span>Row ${i}</span> <a href="#">link</a></div>`);
  return `<!doctype html><html><head><link rel="stylesheet" href="http://xo.test/engine-cases-xo.css"><style>.row{height:24px}.card{width:200px;height:110px;display:inline-block}</style></head><body>${rows.join('')}</body></html>`;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/heavy-engine.html') { res.writeHead(200, { 'content-type': TYPES['.html'] }); return res.end(heavyPage()); }
  if (url.pathname === '/feed.html') { res.writeHead(200, { 'content-type': TYPES['.html'] }); return res.end(feedPage(Number(url.searchParams.get('n')) || 8000)); }
  const file = path.join(FIXTURES, path.basename(url.pathname));
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ---------------------------------------------------------------- browser adapters
let browser, context, newPage, cleanup;
if (FIREFOX) {
  const puppeteer = (await import('puppeteer-core')).default;
  browser = await puppeteer.launch({
    browser: 'firefox',
    executablePath: process.env.FIREFOX_PATH || '/usr/bin/firefox',
    headless: !HEADED,
    defaultViewport: { width: 1000, height: 760 },
    extraPrefsFirefox: {
      'network.proxy.type': 1, 'network.proxy.http': '127.0.0.1', 'network.proxy.http_port': port,
      'network.proxy.no_proxies_on': '', 'network.proxy.allow_hijacking_localhost': true,
      'dom.security.https_only_mode': false, 'layout.css.prefers-color-scheme.content-override': 1,
      'ui.systemUsesDarkTheme': 0, 'full-screen-api.allow-trusted-requests-only': false,
      'full-screen-api.transition-duration.enter': '0 0', 'full-screen-api.transition-duration.leave': '0 0',
    },
  });
  await browser.installExtension(extDir);
  await sleep(800);
  newPage = () => browser.newPage();
  cleanup = () => browser.close();
} else {
  const { chromium } = await import('playwright');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dark-engine-profile-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', headless: !HEADED, viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1, colorScheme: 'light',
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--host-resolver-rules=MAP * 127.0.0.1:${port}`],
  });
  if (!context.serviceWorkers().length) await context.waitForEvent('serviceworker');
  await sleep(500);
  newPage = () => context.newPage();
  cleanup = async () => { await context.close(); fs.rmSync(userDataDir, { recursive: true, force: true }); };
}

const suite = new Suite(FIREFOX ? 'firefox-engine' : 'chrome-engine');
console.log(`\n${suite.name}  (${manifest.name} v${manifest.version})\n`);
fs.mkdirSync(ARTIFACTS, { recursive: true });

async function open(url, settle = 600) {
  const page = await newPage();
  await page.goto(url, { waitUntil: 'load' });
  await sleep(settle);
  return page;
}
async function shot(page, name) {
  if (FIREFOX) await page.bringToFront().catch(() => {});
  const buf = Buffer.from(await page.screenshot());
  fs.writeFileSync(path.join(ARTIFACTS, `${suite.name}-${name}.png`), buf);
  return decodePng(buf);
}
const rect = (page, sel) => page.evaluate(s => {
  const [host, inner] = s.split(' >>> ');
  const el = inner ? document.querySelector(host).shadowRoot.querySelector(inner) : document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}, sel);
async function region(page, png, sel) {
  const b = await rect(page, sel);
  assert(b, `${sel} not found`);
  return avgColor(png, Math.round(b.x + b.width * 0.3), Math.round(b.y + b.height * 0.3), Math.round(b.width * 0.4), Math.round(b.height * 0.4));
}
const darkOn = page => page.evaluate(() => !!document.getElementById('dark-by-eyed'));

// ---------------------------------------------------------------- rendering cases
const cases = await open('http://cases.test/engine-cases.html', 2500);
await suite.test('early script and content script share one engine (one <style>)', async () => {
  const n = await cases.evaluate(() => document.querySelectorAll('style#dark-by-eyed').length);
  assert(n === 1, `${n} engine styles in the document`);
});
let png = await shot(cases, 'cases');
const expectRed = (sel, what) => suite.test(`${what} keeps its colours`, async () => {
  const c = await region(cases, png, sel);
  assert(isReddish(c), `${sel} rgb(${c})`);
  return `rgb(${c})`;
});
await expectRed('#class-bg', 'stylesheet photo background (class)');
await expectRed('#inline-bg', 'inline-style photo background');
await expectRed('#nested-img', '<img> inside a re-inverted background (no double inversion)');
await expectRed('#xo-bg', 'photo background from a cross-origin stylesheet');
await expectRed('#late-bg', 'inline background added later (SPA)');
await expectRed('#cij-bg', 'CSS-in-JS rule inserted via insertRule');
await expectRed('#svg-image', 'SVG <image>');
await expectRed('#vid', '<video> (poster)');
await expectRed('x-card >>> #sh-img', '<img> inside an open shadow root');
await expectRed('x-lazy >>> #lazy-img', '<img> inside a shadow root attached after load');
await suite.test('content drawn over a photo layer keeps its designed colours (hero text)', async () => {
  const over = await region(cases, png, '#cover-over');
  const b = await rect(cases, '#cover');
  const photo = avgColor(png, Math.round(b.x + 150), Math.round(b.y + 75), 40, 25);
  const marks = await cases.evaluate(() => [document.getElementById('cover').getAttribute('data-dark-bg'), getComputedStyle(document.getElementById('cover-img')).filter]);
  assert(isLight(over) && isReddish(photo), `overlay rgb(${over}) photo rgb(${photo}) mark=${marks.join(' / ')}`);
  return `overlay rgb(${over}) photo rgb(${photo})`;
});
await suite.test('raster thumbnails of SVGs (Wikimedia .svg.png) follow the page; photos do not', async () => {
  const f = await cases.evaluate(() => ['/w/thumb/a/ab/Euler.svg/250px-Euler.svg.png', '/w/thumb/c/cd/Photo.jpg/250px-Photo.jpg'].map(src => {
    const i = document.createElement('img'); i.src = src; i.alt = ''; document.body.appendChild(i);
    const v = getComputedStyle(i).filter; i.remove(); return v;
  }));
  assert(f[0] === 'none' && f[1] !== 'none', `svg thumb filter=${f[0]} photo thumb filter=${f[1]}`);
});
await suite.test('gradient background follows the page (not re-inverted)', async () => {
  const c = await region(cases, png, '#gradient');
  assert(isDark(c), `rgb(${c})`);
  return `rgb(${c})`;
});
await suite.test('small svg icon background follows the page', async () => {
  const c = await region(cases, png, '#icon');
  assert(isDark(c), `rgb(${c})`);
});
await suite.test('fixed header stays fixed while scrolling', async () => {
  const before = avgColor(png, 300, 10, 200, 20);
  await cases.evaluate(() => scrollTo(0, 700));
  await sleep(300);
  const png2 = await shot(cases, 'cases-scrolled');
  const after = avgColor(png2, 300, 10, 200, 20);
  const top = (await rect(cases, '#fixed')).y;
  await cases.evaluate(() => scrollTo(0, 0));
  assert(top === 0 && before.join() === after.join() && !isDark(after), `top=${top} before rgb(${before}) after rgb(${after})`);
  return `header rgb(${after})`;
});
await suite.test('modal <dialog> (top layer) is darkened too', async () => {
  await cases.evaluate(() => document.getElementById('dlg').showModal());
  await sleep(300);
  const p = await shot(cases, 'dialog');
  const c = await region(cases, p, '#dlg');
  await cases.evaluate(() => document.getElementById('dlg').close());
  assert(isDark(c), `dialog rgb(${c})`);
  return `rgb(${c})`;
});
await suite.test('fullscreen element is darkened and its media keeps colours', async () => {
  await cases.click('#fs-btn');
  await sleep(700);
  const fsOn = await cases.evaluate(() => !!document.fullscreenElement);
  assert(fsOn, 'could not enter fullscreen');
  const p = await shot(cases, 'fullscreen');
  const bg = avgColor(p, p.width - 120, p.height - 120, 80, 80);
  const img = await region(cases, p, '#fs-img');
  await cases.evaluate(() => document.exitFullscreen()).catch(() => {});
  await sleep(300);
  assert(isDark(bg) && isReddish(img), `fullscreen bg rgb(${bg}) img rgb(${img})`);
  return `bg rgb(${bg}) img rgb(${img})`;
});
await suite.test('fullscreen <video> keeps its colours', async () => {
  await cases.click('#vid-btn');
  await sleep(700);
  assert(await cases.evaluate(() => document.fullscreenElement?.id === 'vid'), 'could not enter fullscreen');
  const p = await shot(cases, 'video-fullscreen');
  const c = avgColor(p, Math.round(p.width / 2) - 40, Math.round(p.height / 2) - 40, 80, 80);
  await cases.evaluate(() => document.exitFullscreen()).catch(() => {});
  await sleep(300);
  assert(isReddish(c), `fullscreen video rgb(${c})`);
  return `rgb(${c})`;
});
await suite.test('translucent black modal scrim dims the dark page (no white haze)', async () => {
  const before = (img => avgColor(img, img.width - 120, img.height - 120, 80, 80))(await shot(cases, 'scrim-before'));
  await cases.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'scrim';
    d.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:50';
    document.body.appendChild(d);
  });
  await sleep(700);
  const p = await shot(cases, 'scrim');
  const c = avgColor(p, p.width - 120, p.height - 120, 80, 80);
  await cases.evaluate(() => document.getElementById('scrim').remove());
  assert(isDark(c) && c[0] <= before[0], `page under the scrim rgb(${c}), without rgb(${before})`);
  return `rgb(${before}) -> rgb(${c})`;
});
await cases.close();

// ---------------------------------------------------------------- native-dark heuristics
const nativeCase = (title, file, expectDarkMode, settle = 900) => suite.test(title, async () => {
  const p = await open(`http://${file.replace('.html', '')}.test/${file}`, settle);
  const on = await darkOn(p);
  const c = (img => avgColor(img, img.width - 120, img.height - 120, 80, 80))(await shot(p, file.replace('.html', '')));
  await p.close();
  assert(on === expectDarkMode, `engine ${on ? 'on' : 'off'}, page rgb(${c})`);
  if (!expectDarkMode) assert(isDark(c), `page should look dark, got rgb(${c})`);
  return `engine ${on ? 'on' : 'off'}`;
});
await nativeCase('dark app shell on a transparent body is detected as natively dark', 'dark-wrapper.html', false);
await nativeCase('light site with a dark hero is still darkened', 'light-dark-hero.html', true);
await nativeCase('light site behind a dark consent overlay is still darkened', 'light-overlay.html', true);
await nativeCase('theme applied after load is detected', 'late-theme.html', false, 2200);
await nativeCase('dark html behind a light body covering the page is not natively dark', 'html-dark-body-light.html', true);

// ---------------------------------------------------------------- cost
if (!FIREFOX) {
  await suite.test('no long tasks from the engine on a 4000-row page with photo backgrounds', async () => {
    const p = await newPage();
    const cdp = await context.newCDPSession(p);
    await cdp.send('Performance.enable');
    await p.addInitScript(() => {
      window.__long = [];
      new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true });
    });
    await p.goto('http://heavy.test/heavy-engine.html', { waitUntil: 'load' });
    await sleep(1500);
    // SPA-style churn: add 2000 rows in batches.
    await p.evaluate(async () => {
      for (let b = 0; b < 20; b++) {
        const frag = document.createDocumentFragment();
        for (let i = 0; i < 100; i++) { const d = document.createElement('div'); d.className = 'row' + (i % 10 === 0 ? ' photo-bg' : ''); d.textContent = 'added'; frag.appendChild(d); }
        document.body.appendChild(frag);
        await new Promise(r => setTimeout(r, 30));
      }
    });
    await sleep(1500);
    const long = await p.evaluate(() => window.__long);
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map(x => [x.name, x.value]));
    const photo = await p.evaluate(() => getComputedStyle(document.querySelector('.photo-bg')).filter);
    await p.close();
    assert(photo !== 'none', 'photo-bg rows not re-inverted');
    // The initial parse of a 4000-row document is itself a long task; anything after load would be ours.
    const afterLoad = long.slice(1);
    assert(afterLoad.every(d => d < 50), `long tasks: ${long.join(', ')} ms`);
    return `recalcStyle=${Math.round(m.RecalcStyleDuration * 1000)}ms script=${Math.round(m.ScriptDuration * 1000)}ms long=[${long.join(',')}]`;
  });
}

if (!FIREFOX) {
  await suite.test('no long tasks when an infinite-scroll feed appends photo cards (unreadable stylesheet)', async () => {
    const p = await newPage();
    await p.addInitScript(() => {
      window.__long = [];
      new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true });
    });
    await p.goto('http://feed.test/feed.html?n=8000', { waitUntil: 'load' });
    await sleep(2500); // initial element pass
    const t0 = await p.evaluate(() => performance.now());
    await p.evaluate(async () => {
      for (let b = 0; b < 5; b++) {
        const s = document.createElement('section');
        for (let i = 0; i < 60; i++) { const d = document.createElement('div'); d.className = 'card xo-photo'; s.appendChild(d); }
        document.body.insertBefore(s, document.body.firstChild);
        await new Promise(r => setTimeout(r, 400));
      }
    });
    await sleep(1000);
    const [long, marked] = await p.evaluate(() => [window.__long, document.querySelectorAll('.card[data-dark-bg]').length]);
    await p.close();
    const after = long.filter(([start]) => start > t0).map(([, d]) => d);
    assert(marked === 300, `${marked}/300 cards re-inverted`);
    assert(after.every(d => d < 50), `long tasks while appending: ${after.join(', ')} ms`);
    return `${marked} cards, long=[${after.join(',')}]`;
  });
}

const failed = suite.summary();
await cleanup();
server.close();
process.exit(failed ? 1 : 0);
