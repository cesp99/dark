// Builds dist/chrome and dist/firefox from src/.
//   node scripts/build.mjs           build both
//   node scripts/build.mjs --zip     also produce dist/dark-<browser>-<version>.zip
//   DIST_DIR=/tmp/x node scripts/build.mjs   build into another directory
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.resolve(process.env.DIST_DIR || path.join(ROOT, 'dist'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const CONTENT_JS = ['shared/core.js', 'engine.js', 'content.js'];

function baseManifest() {
  return {
    manifest_version: 3,
    name: 'Dark by Eyed™',
    version: pkg.version,
    description: pkg.description,
    icons: { 48: 'icons/48.png', 96: 'icons/96.png', 256: 'icons/256.png' },
    permissions: ['storage', 'scripting'],
    host_permissions: ['<all_urls>'],
    action: {
      default_icon: { 48: 'icons/48.png', 96: 'icons/96.png' },
      default_title: 'Dark by Eyed',
      default_popup: 'popup/popup.html',
    },
    content_scripts: [{ matches: ['<all_urls>'], js: CONTENT_JS, run_at: 'document_start' }],
    commands: {
      'toggle-site': {
        suggested_key: { default: 'Alt+Shift+D' },
        description: 'Toggle dark mode on the current site',
      },
    },
  };
}

const TARGETS = {
  chrome: () => ({
    ...baseManifest(),
    minimum_chrome_version: '111',
    background: { service_worker: 'background.js' },
  }),
  firefox: () => ({
    ...baseManifest(),
    author: 'Carlo Esposito - Aploide',
    background: { scripts: ['shared/core.js', 'background.js'] },
    browser_specific_settings: {
      gecko: {
        id: 'dark-by-eyed@aploi.de',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
      gecko_android: {
        strict_min_version: '142.0',
      },
    },
  }),
};

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const a = path.join(from, entry.name), b = path.join(to, entry.name);
    entry.isDirectory() ? copyDir(a, b) : fs.copyFileSync(a, b);
  }
}

for (const [name, manifest] of Object.entries(TARGETS)) {
  const out = path.join(DIST, name);
  fs.rmSync(out, { recursive: true, force: true });
  copyDir(SRC, out);
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest(), null, 2) + '\n');
  if (process.argv.includes('--zip')) {
    const zip = path.join(DIST, `dark-${name}-${pkg.version}.zip`);
    fs.rmSync(zip, { force: true });
    try {
      execFileSync('zip', ['-qr', zip, '.'], { cwd: out, stdio: 'ignore' });
    } catch {
      // No `zip` binary (e.g. minimal Linux installs): Python's zipfile stores paths relative to cwd.
      execFileSync('python3', ['-m', 'zipfile', '-c', zip, ...fs.readdirSync(out)], { cwd: out });
    }
    console.log(`zipped ${path.relative(ROOT, zip)}`);
  }
  console.log(`built ${path.relative(ROOT, out) || out}`);
}
