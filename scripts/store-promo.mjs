// Generates the Chrome Web Store promo tiles (24-bit PNG, no alpha):
//   store/promo/small-440x280.png      small promo tile
//   store/promo/marquee-1400x560.png   marquee promo tile
// Uses src/icons/256.png and store/screenshots/1-before-after.png (run `npm run screenshots` first).
//   node scripts/store-promo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'store/promo');
const icon = fs.readFileSync(path.join(ROOT, 'src/icons/256.png')).toString('base64');
const shotPath = path.join(ROOT, 'store/screenshots/1-before-after.png');
if (!fs.existsSync(shotPath)) throw new Error('Run `npm run screenshots` first');
const shot = fs.readFileSync(shotPath).toString('base64');
fs.mkdirSync(OUT, { recursive: true });

const NIGHT = '#121019';
const CREAM = '#f3efe6';
const MOON = '#ece7da';
const MUTED = '#a39cb2';

const FONT = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=block" rel="stylesheet">`;
const BASE = `*{box-sizing:border-box;margin:0}
  html,body{overflow:hidden;font-family:Geist,'Noto Sans',sans-serif;-webkit-font-smoothing:antialiased}`;

// Small tile: the background is the before/after split, and the type is drawn with a difference
// blend, so the wordmark itself inverts across the seam: dark on the light half, light on the dark.
const small = `<!doctype html><html><head>${FONT}<style>${BASE}
  body{width:440px;height:280px;position:relative;background:linear-gradient(90deg,${CREAM} 0 50%,${NIGHT} 50% 100%)}
  .icon{position:absolute;left:184px;top:34px;width:72px;height:72px;border-radius:17px;
    box-shadow:0 8px 22px rgba(0,0,0,.28),0 0 0 1px rgba(255,255,255,.06)}
  .type{position:absolute;inset:0;color:#fff;mix-blend-mode:difference;text-align:center}
  .word{position:absolute;left:0;right:0;top:128px;font-size:46px;letter-spacing:-.025em;line-height:1}
  .word b{font-weight:700}.word span{font-weight:400}
  .tag{position:absolute;left:0;right:0;top:192px;font-size:17px;font-weight:500;letter-spacing:-.005em}
  sup{font-size:.36em;font-weight:500;vertical-align:1.5em;margin-left:1px}
</style></head><body>
  <img class="icon" src="data:image/png;base64,${icon}">
  <div class="type"><div class="word"><b>Dark</b> <span>by Eyed</span><sup>™</sup></div>
  <div class="tag">Dark mode for every website</div></div>
</body></html>`;

// Marquee: wordmark and promise on the left, the real before/after screenshot on the right.
const marquee = `<!doctype html><html><head>${FONT}<style>${BASE}
  body{width:1400px;height:560px;position:relative;background:${NIGHT};color:${MOON}}
  .copy{position:absolute;left:88px;top:0;bottom:0;width:440px;display:flex;flex-direction:column;justify-content:center}
  .icon{width:84px;height:84px;border-radius:20px;margin-bottom:30px;box-shadow:0 0 0 1px rgba(255,255,255,.06)}
  .word{font-size:58px;letter-spacing:-.03em;line-height:1}
  .word b{font-weight:700}.word span{font-weight:400;color:${MUTED}}
  sup{font-size:.34em;font-weight:500;vertical-align:1.6em;margin-left:2px;color:${MUTED}}
  h2{margin-top:22px;font-size:27px;font-weight:500;letter-spacing:-.015em;line-height:1.25}
  p{margin-top:16px;font-size:18px;line-height:1.55;color:${MUTED};max-width:400px}
  .frame{position:absolute;right:72px;top:49px;width:740px;height:462px;border-radius:12px;overflow:hidden;
    box-shadow:0 0 0 1px rgba(255,255,255,.09),0 30px 80px rgba(0,0,0,.55)}
  .frame img{display:block;width:740px;height:462px}
</style></head><body>
  <div class="copy">
    <img class="icon" src="data:image/png;base64,${icon}">
    <div class="word"><b>Dark</b> <span>by Eyed</span><sup>™</sup></div>
    <h2>Dark mode for every website.</h2>
    <p>Photos keep their real colours, pages load without a white flash, and sites that are already dark are left alone.</p>
  </div>
  <div class="frame"><img src="data:image/png;base64,${shot}"></div>
</body></html>`;

const browser = await chromium.launch();
async function render(html, width, height, name) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  const png = PNG.sync.read(await page.screenshot());
  fs.writeFileSync(path.join(OUT, name), PNG.sync.write(png, { colorType: 2 }));
  await page.close();
  console.log(`wrote store/promo/${name}`);
}
await render(small, 440, 280, 'small-440x280.png');
await render(marquee, 1400, 560, 'marquee-1400x560.png');
await browser.close();
