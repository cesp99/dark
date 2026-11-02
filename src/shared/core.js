/*
 * Dark by Eyed — shared core.
 * Settings schema, host normalisation, site-pattern matching and the
 * "should this page be dark?" decision. Loaded as a classic script by the
 * background worker, the content scripts and the popup, and by unit tests.
 */
(function (global) {
  'use strict';

  const api = global.browser ?? global.chrome;

  /** Every persisted setting with its default. Keys kept from v1 for migration. */
  const DEFAULTS = Object.freeze({
    enabled: true,               // master switch
    listMode: 'blacklist',       // 'blacklist' = dark everywhere except listed; 'whitelist' = only listed
    blacklist_sites: [],
    whitelist_sites: [],
    brightness: 100,             // percent, 50..150
    contrast: 100,               // percent, 50..150
    sepia: 0,                    // percent, 0..100
    followSystem: false,         // only darken while the OS is in dark mode
    detectDark: true,            // skip sites that already have a dark theme
    nativeDarkHosts: [],         // cache of hosts detected as natively dark (most recent last)
    forceDark_sites: [],         // hosts the user turned on although they look natively dark
  });

  const LIMITS = Object.freeze({
    brightness: [50, 150],
    contrast: [50, 150],
    sepia: [0, 100],
  });

  const NATIVE_DARK_CACHE_MAX = 300;

  const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  const PATTERN_RE = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*(?:\\.\\*)?$`);

  /** Lowercases, strips a trailing dot and a single leading "www.". */
  function normalizeHost(host) {
    let h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
    if (h.startsWith('www.')) h = h.slice(4);
    return h;
  }

  function hostFromUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') return '';
      return normalizeHost(u.hostname);
    } catch {
      return '';
    }
  }

  const RESTRICTED_HOSTS = ['chromewebstore.google.com', 'addons.mozilla.org', 'accounts-static.cdn.mozilla.net'];

  /** Pages the browser never lets extensions script (or that we can't identify). */
  function isRestrictedUrl(url) {
    let u;
    try { u = new URL(url); } catch { return true; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') return true;
    const h = normalizeHost(u.hostname);
    if (RESTRICTED_HOSTS.includes(h)) return true;
    if (h === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return true;
    return false;
  }

  function isValidPattern(p) {
    return typeof p === 'string' && p.length <= 253 && PATTERN_RE.test(p) && !(p.startsWith('*.') && p.endsWith('.*'));
  }

  /**
   * Turns free-form user input into a site pattern.
   * Accepts "example.com", "*.example.com", "example.*", or a pasted URL. Unicode (IDN) names are stored
   * in their ASCII (punycode) form, which is what pages report as their host.
   * @returns {{ok: true, value: string} | {ok: false, error: string}}
   */
  function parseSiteInput(raw) {
    let s = String(raw || '').trim().toLowerCase();
    if (!s) return { ok: false, error: 'Enter a website, e.g. example.com' };
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(s) || /[/?#]/.test(s)) {
      try {
        const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `http://${s}`);
        s = u.hostname;
      } catch {
        return { ok: false, error: 'That doesn’t look like a web address' };
      }
    }
    s = s.replace(/:\d+$/, '').replace(/\.$/, '');
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7f]/.test(s)) {
      const pre = s.startsWith('*.') ? '*.' : '', post = !pre && s.endsWith('.*') ? '.*' : '';
      try {
        s = pre + new URL(`http://${s.slice(pre.length, s.length - post.length)}`).hostname + post;
      } catch {
        return { ok: false, error: 'That doesn’t look like a web address' };
      }
    }
    if (!s.startsWith('*.')) s = normalizeHost(s);
    if (!isValidPattern(s)) {
      return { ok: false, error: 'Use a domain like example.com, *.example.com or example.*' };
    }
    return { ok: true, value: s };
  }

  /**
   * Pattern semantics:
   *   example.com    -> example.com and www.example.com
   *   *.example.com  -> example.com and every subdomain (dot boundary enforced)
   *   example.*      -> example.<any tld>, e.g. example.com, example.co.uk
   */
  function matchPattern(pattern, host) {
    const h = normalizeHost(host);
    const p = String(pattern || '').toLowerCase();
    if (!h || !p) return false;
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return h === base || h.endsWith('.' + base);
    }
    if (p.endsWith('.*')) {
      const prefix = normalizeHost(p.slice(0, -2));
      return h.startsWith(prefix + '.');
    }
    return h === normalizeHost(p);
  }

  // ------------------------------------------------------------------ punycode (display only)

  const PUNY = { base: 36, tMin: 1, tMax: 26, skew: 38, damp: 700, bias: 72, n: 128 };

  function punyDecode(input) {
    const { base, tMin, tMax, skew, damp } = PUNY;
    const out = [];
    let i = 0, n = PUNY.n, bias = PUNY.bias;
    const b = input.lastIndexOf('-');
    for (let j = 0; j < Math.max(0, b); j++) out.push(input.charCodeAt(j));
    const adapt = (delta, num, first) => {
      delta = first ? Math.floor(delta / damp) : delta >> 1;
      delta += Math.floor(delta / num);
      let k = 0;
      for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
      return k + Math.floor(((base - tMin + 1) * delta) / (delta + skew));
    };
    for (let idx = b > 0 ? b + 1 : 0; idx < input.length;) {
      const oldi = i;
      for (let w = 1, k = base; ; k += base) {
        if (idx >= input.length) throw new Error('bad punycode');
        const c = input.charCodeAt(idx++);
        const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base;
        if (digit >= base) throw new Error('bad punycode');
        i += digit * w;
        const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
        if (digit < t) break;
        w *= base - t;
      }
      bias = adapt(i - oldi, out.length + 1, oldi === 0);
      n += Math.floor(i / (out.length + 1));
      i %= out.length + 1;
      out.splice(i++, 0, n);
    }
    return String.fromCodePoint(...out);
  }

  /** "xn--mnchen-3ya.de" -> "münchen.de" for display (patterns and hosts stay ASCII everywhere else). */
  function toUnicodeHost(host) {
    const h = String(host || '');
    if (!h.includes('xn--')) return h;
    return h.split('.').map(label => {
      if (!label.startsWith('xn--')) return label;
      try { return punyDecode(label.slice(4)); } catch { return label; }
    }).join('.');
  }

  function matchingPatterns(list, host) {
    return (Array.isArray(list) ? list : []).filter(p => matchPattern(p, host));
  }

  function listKey(settings) {
    return (settings.listMode === 'whitelist' ? 'whitelist' : 'blacklist') + '_sites';
  }

  function clamp(v, [lo, hi], fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  }

  /** Fills defaults and sanitises types/ranges. */
  function sanitize(raw) {
    const s = Object.assign({}, DEFAULTS, raw || {});
    s.enabled = s.enabled !== false;
    s.listMode = s.listMode === 'whitelist' ? 'whitelist' : 'blacklist';
    s.blacklist_sites = Array.isArray(s.blacklist_sites) ? s.blacklist_sites.filter(x => typeof x === 'string') : [];
    s.whitelist_sites = Array.isArray(s.whitelist_sites) ? s.whitelist_sites.filter(x => typeof x === 'string') : [];
    s.nativeDarkHosts = Array.isArray(s.nativeDarkHosts) ? s.nativeDarkHosts.filter(x => typeof x === 'string') : [];
    s.forceDark_sites = Array.isArray(s.forceDark_sites) ? s.forceDark_sites.filter(x => typeof x === 'string') : [];
    for (const k of Object.keys(LIMITS)) s[k] = clamp(s[k], LIMITS[k], DEFAULTS[k]);
    s.followSystem = s.followSystem === true;
    s.detectDark = s.detectDark !== false;
    return s;
  }

  /**
   * Per-site status according to the list only (ignores master switch and system theme).
   * @returns {{listedBy: string[], wantsDark: boolean}}
   */
  function siteStatus(settings, host) {
    const s = sanitize(settings);
    const listedBy = matchingPatterns(s[listKey(s)], host);
    const wantsDark = s.listMode === 'blacklist' ? listedBy.length === 0 : listedBy.length > 0;
    return { listedBy, wantsDark };
  }

  /** Whether the user turned dark mode on for this host although it looks natively dark. */
  function isForced(settings, host) {
    const s = sanitize(settings);
    return s.forceDark_sites.includes(normalizeHost(host));
  }

  /**
   * Whether the page counts as natively dark: the page's own detection when it has one
   * (env.nativeDark is a boolean), otherwise the cache of hosts seen dark before.
   */
  function looksNative(s, h, env) {
    if (!s.detectDark || s.forceDark_sites.includes(h)) return false;
    return typeof env.nativeDark === 'boolean' ? env.nativeDark : s.nativeDarkHosts.includes(h);
  }

  /**
   * Full decision for a page.
   * @param {object} settings
   * @param {string} host
   * @param {{systemDark?: boolean, nativeDark?: boolean, localFile?: boolean}} env
   *   nativeDark: the page's own detection result; leave undefined to fall back on the host cache.
   *   localFile: a file:// page (no host): dark in "everywhere" mode, never in "only on" mode.
   * @returns {{dark: boolean, reason: string}}
   *   reason: 'on' | 'disabled' | 'system-light' | 'listed-off' | 'not-listed' | 'native-dark' | 'no-host'
   */
  function decide(settings, host, env = {}) {
    const s = sanitize(settings);
    const h = normalizeHost(host);
    if (!h && !env.localFile) return { dark: false, reason: 'no-host' };
    if (!s.enabled) return { dark: false, reason: 'disabled' };
    const wantsDark = h ? siteStatus(s, h).wantsDark : s.listMode === 'blacklist';
    if (!wantsDark) return { dark: false, reason: s.listMode === 'blacklist' ? 'listed-off' : 'not-listed' };
    if (s.followSystem && !env.systemDark) return { dark: false, reason: 'system-light' };
    if (looksNative(s, h, env)) return { dark: false, reason: 'native-dark' };
    return { dark: true, reason: 'on' };
  }

  /**
   * What the per-site switch shows: whether this site is darkened as far as the site itself is concerned
   * (the list, a native dark theme and the user's override; not the master switch or the OS theme).
   */
  function siteOn(settings, host, env = {}) {
    const s = sanitize(settings);
    const h = normalizeHost(host);
    return siteStatus(s, h).wantsDark && !looksNative(s, h, env);
  }

  /**
   * Storage update that flips the current site's per-site state (see siteOn()).
   * Turning a site "off" in blacklist mode adds its host; turning it back on removes every
   * pattern that matches it (including wildcards). Whitelist mode is the mirror image.
   * A site that looks natively dark (env.nativeDark, or the cache) is turned on with an override in
   * forceDark_sites, which detection then leaves alone; turning it off drops the override again.
   * The native-dark cache entry for the host is cleared either way.
   */
  function toggleSiteUpdate(settings, host, env = {}) {
    const s = sanitize(settings);
    const h = normalizeHost(host);
    const key = listKey(s);
    const list = s[key].slice();
    const matched = matchingPatterns(list, h);
    const forced = s.forceDark_sites.includes(h);
    const native = s.detectDark && (typeof env.nativeDark === 'boolean' ? env.nativeDark : s.nativeDarkHosts.includes(h));
    const update = {};
    if (siteOn(s, h, env)) {
      if (forced) update.forceDark_sites = s.forceDark_sites.filter(x => x !== h);
      // Dropping the override is enough while the site still looks natively dark.
      if (!(forced && native)) update[key] = matched.length ? list.filter(p => !matched.includes(p)) : list.concat(h);
    } else {
      if (!siteStatus(s, h).wantsDark) update[key] = matched.length ? list.filter(p => !matched.includes(p)) : list.concat(h);
      if (native && !forced) update.forceDark_sites = s.forceDark_sites.concat(h);
    }
    if (s.nativeDarkHosts.includes(h)) update.nativeDarkHosts = s.nativeDarkHosts.filter(x => x !== h);
    return update;
  }

  /** Adds a host to the native-dark cache (LRU, bounded). Returns null if unchanged. */
  function rememberNativeDarkUpdate(settings, host) {
    const s = sanitize(settings);
    const h = normalizeHost(host);
    if (!h || s.nativeDarkHosts[s.nativeDarkHosts.length - 1] === h) return null;
    const next = s.nativeDarkHosts.filter(x => x !== h).concat(h).slice(-NATIVE_DARK_CACHE_MAX);
    return { nativeDarkHosts: next };
  }

  /** Engine options derived from settings. */
  function engineOptions(settings) {
    const s = sanitize(settings);
    return { brightness: s.brightness, contrast: s.contrast, sepia: s.sepia };
  }

  const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

  /**
   * Converts a site pattern into WebExtension match patterns (for scripting.registerContentScripts).
   * "example.*" cannot be expressed and returns []. A host whose last label is a number is an IPv4
   * address to the URL parser: only a real dotted address has a match pattern, and never a "www."
   * variant (Chrome rejects the whole registration over a single such pattern).
   */
  function toMatchPatterns(pattern) {
    const raw = String(pattern || '').toLowerCase();
    if (!isValidPattern(raw) || raw.endsWith('.*')) return [];
    const wild = raw.startsWith('*.');
    const p = wild ? raw : normalizeHost(raw); // v1 lists may hold "www.example.com"
    const last = p.slice(p.lastIndexOf('.') + 1);
    if (/^(\d+|0x[0-9a-f]*)$/.test(last)) return !wild && IPV4_RE.test(p) ? [`*://${p}/*`] : [];
    if (wild) return [`*://${p}/*`];
    return [`*://${p}/*`, `*://www.${p}/*`];
  }

  /**
   * Normalises a stored site list (v1 accepted entries such as "www.example.com", which v1 never matched
   * and v2 reads as example.com). Entries that are not valid patterns are kept as they are.
   */
  function normalizeSiteList(list) {
    const out = [];
    for (const x of Array.isArray(list) ? list : []) {
      if (typeof x !== 'string') continue;
      const r = parseSiteInput(x);
      const v = r.ok ? r.value : x;
      if (!out.includes(v)) out.push(v);
    }
    return out;
  }

  async function getSettings() {
    return sanitize(await api.storage.local.get(Object.keys(DEFAULTS)));
  }

  function setSettings(update) {
    return api.storage.local.set(update);
  }

  const DarkCore = {
    api, DEFAULTS, LIMITS, NATIVE_DARK_CACHE_MAX,
    normalizeHost, hostFromUrl, isRestrictedUrl, isValidPattern, parseSiteInput, toUnicodeHost,
    matchPattern, matchingPatterns, listKey, sanitize, siteStatus, decide, siteOn, isForced,
    toggleSiteUpdate, rememberNativeDarkUpdate, engineOptions, toMatchPatterns, normalizeSiteList,
    getSettings, setSettings,
  };

  global.DarkCore = DarkCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
