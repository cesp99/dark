// Shared helpers for the end-to-end suites (Chromium + Firefox).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = path.join(ROOT, 'tests/e2e/fixtures');
export const ARTIFACTS = path.join(ROOT, 'tests/e2e/artifacts');

/** A page with many elements and many CSS rules, used to measure engine cost. */
function heavyPage() {
  const rows = [];
  for (let i = 0; i < 4000; i++) {
    rows.push(`<div class="row r${i % 50}"><span class="label">Row ${i}</span> <a href="#${i}">link ${i}</a> <em>item</em></div>`);
  }
  const rules = [];
  for (let i = 0; i < 50; i++) rules.push(`.r${i}{background:hsl(${i * 7},60%,96%);border-bottom:1px solid hsl(${i * 7},30%,85%)}`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Heavy</title><style>body{margin:0;background:#fff;color:#222;font:14px system-ui}${rules.join('')}</style></head><body>${rows.join('\n')}</body></html>`;
}

/** Starts a fixture server. Every hostname maps here via the browser's resolver rules. */
export async function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/heavy.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(heavyPage());
    }
    const file = path.join(FIXTURES, path.basename(url.pathname));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

/** Extracts the pre-revamp extension (main branch) into a temp dir. */
export function extractLegacy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dark-legacy-'));
  const tar = execFileSync('git', ['-C', ROOT, 'archive', 'main', 'dark-chrome', 'dark-firefox']);
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  return { chrome: path.join(dir, 'dark-chrome'), firefox: path.join(dir, 'dark-firefox') };
}

export function decodePng(buf) { return PNG.sync.read(buf); }

/** Average colour of a rectangle in a decoded PNG. */
export function avgColor(png, x, y, w, h) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let j = Math.max(0, y); j < Math.min(png.height, y + h); j++) {
    for (let i = Math.max(0, x); i < Math.min(png.width, x + w); i++) {
      const k = (png.width * j + i) * 4;
      r += png.data[k]; g += png.data[k + 1]; b += png.data[k + 2]; n++;
    }
  }
  return n ? [r / n, g / n, b / n].map(Math.round) : [0, 0, 0];
}

/** Relative luminance 0..1. */
export function luminance([r, g, b]) {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export const isReddish = ([r, g, b]) => r > 150 && g < 90 && b < 90;
export const isDark = c => luminance(c) < 0.12;
export const isLight = c => luminance(c) > 0.6;

/** Tiny test runner that records results instead of throwing on the first failure. */
export class Suite {
  constructor(name) { this.name = name; this.results = []; }
  async test(title, fn) {
    const t0 = performance.now();
    try {
      const note = await fn();
      this.results.push({ title, ok: true, note, ms: Math.round(performance.now() - t0) });
      console.log(`  ✓ ${title}${note ? `  (${note})` : ''}`);
    } catch (e) {
      this.results.push({ title, ok: false, note: String(e?.message || e).split('\n')[0] });
      console.log(`  ✗ ${title}\n      ${String(e?.message || e).split('\n').slice(0, 3).join('\n      ')}`);
    }
  }
  summary() {
    const failed = this.results.filter(r => !r.ok).length;
    console.log(`\n${this.name}: ${this.results.length - failed}/${this.results.length} passed`);
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, `${this.name.replace(/\W+/g, '-')}.json`), JSON.stringify(this.results, null, 2));
    return failed;
  }
}

export function assert(cond, msg) { if (!cond) throw new Error(msg); }
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Polls fn until it returns truthy or times out; returns the last value. */
export async function waitFor(fn, { timeout = 3000, interval = 50 } = {}) {
  const end = Date.now() + timeout;
  let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(interval); }
  return v;
}
