import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from './load.mjs';

const C = loadScript('src/shared/core.js').DarkCore;
const plain = v => JSON.parse(JSON.stringify(v));

test('normalizeHost strips only a leading www.', () => {
  assert.equal(C.normalizeHost('WWW.Example.com.'), 'example.com');
  assert.equal(C.normalizeHost('mywww.example.com'), 'mywww.example.com');
  assert.equal(C.normalizeHost('shop.www.example.com'), 'shop.www.example.com');
});

test('matchPattern: exact', () => {
  assert.ok(C.matchPattern('example.com', 'example.com'));
  assert.ok(C.matchPattern('example.com', 'www.example.com'));
  assert.ok(!C.matchPattern('example.com', 'sub.example.com'));
  assert.ok(!C.matchPattern('example.com', 'notexample.com'));
});

test('matchPattern: *.domain enforces a dot boundary and matches the apex', () => {
  assert.ok(C.matchPattern('*.google.com', 'google.com'));
  assert.ok(C.matchPattern('*.google.com', 'mail.google.com'));
  assert.ok(C.matchPattern('*.google.com', 'a.b.google.com'));
  assert.ok(!C.matchPattern('*.google.com', 'notgoogle.com'));
  assert.ok(!C.matchPattern('*.google.com', 'google.com.evil.net'));
});

test('matchPattern: name.* matches any tld', () => {
  assert.ok(C.matchPattern('example.*', 'example.com'));
  assert.ok(C.matchPattern('example.*', 'example.co.uk'));
  assert.ok(C.matchPattern('example.*', 'www.example.de'));
  assert.ok(!C.matchPattern('example.*', 'myexample.com'));
  assert.ok(!C.matchPattern('example.*', 'example'));
});

test('parseSiteInput accepts domains, wildcards and URLs', () => {
  assert.deepEqual(plain(C.parseSiteInput(' Example.COM ')), { ok: true, value: 'example.com' });
  assert.deepEqual(plain(C.parseSiteInput('www.example.com')), { ok: true, value: 'example.com' });
  assert.deepEqual(plain(C.parseSiteInput('*.example.com')), { ok: true, value: '*.example.com' });
  assert.deepEqual(plain(C.parseSiteInput('example.*')), { ok: true, value: 'example.*' });
  assert.deepEqual(plain(C.parseSiteInput('https://www.Foo.org/a/b?c=1')), { ok: true, value: 'foo.org' });
  assert.deepEqual(plain(C.parseSiteInput('foo.org/path')), { ok: true, value: 'foo.org' });
  assert.deepEqual(plain(C.parseSiteInput('localhost:8080')), { ok: true, value: 'localhost' });
  assert.deepEqual(plain(C.parseSiteInput('192.168.1.10')), { ok: true, value: '192.168.1.10' });
});

test('parseSiteInput rejects junk', () => {
  for (const bad of ['', '   ', 'not a domain!!', '<script>', '*.*', '*.example.*', 'exa mple.com', '-bad.com', 'a..b']) {
    assert.equal(C.parseSiteInput(bad).ok, false, bad);
  }
});

test('decide: blacklist / whitelist / master / system / native', () => {
  const base = { blacklist_sites: ['*.google.com'], whitelist_sites: ['wiki.org'] };
  assert.equal(C.decide(base, 'example.com').dark, true);
  assert.equal(C.decide(base, 'mail.google.com').reason, 'listed-off');
  assert.equal(C.decide({ ...base, listMode: 'whitelist' }, 'example.com').reason, 'not-listed');
  assert.equal(C.decide({ ...base, listMode: 'whitelist' }, 'wiki.org').dark, true);
  assert.equal(C.decide({ ...base, enabled: false }, 'example.com').reason, 'disabled');
  assert.equal(C.decide({ ...base, followSystem: true }, 'example.com', { systemDark: false }).reason, 'system-light');
  assert.equal(C.decide({ ...base, followSystem: true }, 'example.com', { systemDark: true }).dark, true);
  assert.equal(C.decide(base, 'example.com', { nativeDark: true }).reason, 'native-dark');
  assert.equal(C.decide({ ...base, detectDark: false }, 'example.com', { nativeDark: true }).dark, true);
  assert.equal(C.decide({ ...base, nativeDarkHosts: ['example.com'] }, 'www.example.com').reason, 'native-dark');
  assert.equal(C.decide(base, '').reason, 'no-host');
});

test('toggleSiteUpdate flips state in both modes and removes wildcard matches', () => {
  let s = { blacklist_sites: ['*.google.com', 'a.com'] };
  assert.deepEqual(plain(C.toggleSiteUpdate(s, 'mail.google.com')), { blacklist_sites: ['a.com'] });
  assert.deepEqual(plain(C.toggleSiteUpdate(s, 'b.com')), { blacklist_sites: ['*.google.com', 'a.com', 'b.com'] });
  s = { listMode: 'whitelist', whitelist_sites: [] };
  assert.deepEqual(plain(C.toggleSiteUpdate(s, 'www.wiki.org')), { whitelist_sites: ['wiki.org'] });
  s = { nativeDarkHosts: ['x.com'], blacklist_sites: ['x.com'] };
  assert.deepEqual(plain(C.toggleSiteUpdate(s, 'x.com')), { blacklist_sites: [], nativeDarkHosts: [] });
});

test('rememberNativeDarkUpdate is bounded and deduplicated', () => {
  const many = Array.from({ length: C.NATIVE_DARK_CACHE_MAX }, (_, i) => `h${i}.com`);
  const u = C.rememberNativeDarkUpdate({ nativeDarkHosts: many }, 'new.com');
  assert.equal(u.nativeDarkHosts.length, C.NATIVE_DARK_CACHE_MAX);
  assert.equal(u.nativeDarkHosts.at(-1), 'new.com');
  assert.equal(C.rememberNativeDarkUpdate({ nativeDarkHosts: ['a.com'] }, 'a.com'), null);
});

test('sanitize clamps ranges and fixes types', () => {
  const s = C.sanitize({ brightness: 999, contrast: 'x', sepia: -5, listMode: 'weird', blacklist_sites: 'nope' });
  assert.equal(s.brightness, 150);
  assert.equal(s.contrast, 100);
  assert.equal(s.sepia, 0);
  assert.equal(s.listMode, 'blacklist');
  assert.deepEqual(plain(s.blacklist_sites), []);
});

test('toMatchPatterns', () => {
  assert.deepEqual(plain(C.toMatchPatterns('*.eyed.to')), ['*://*.eyed.to/*']);
  assert.deepEqual(plain(C.toMatchPatterns('aploi.de')), ['*://aploi.de/*', '*://www.aploi.de/*']);
  assert.deepEqual(plain(C.toMatchPatterns('example.*')), []);
  assert.deepEqual(plain(C.toMatchPatterns('bad pattern')), []);
});

test('isRestrictedUrl', () => {
  assert.ok(C.isRestrictedUrl('chrome://version/'));
  assert.ok(C.isRestrictedUrl('about:addons'));
  assert.ok(C.isRestrictedUrl('https://chromewebstore.google.com/detail/x'));
  assert.ok(C.isRestrictedUrl('https://addons.mozilla.org/en-US/firefox/'));
  assert.ok(C.isRestrictedUrl('not a url'));
  assert.ok(!C.isRestrictedUrl('https://example.com/'));
});
