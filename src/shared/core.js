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
   * Accepts "example.com", "*.example.com", "example.*", or a pasted URL.
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

  /**
   * Full decision for a page.
   * @param {object} settings
   * @param {string} host
   * @param {{systemDark?: boolean, nativeDark?: boolean}} env
   * @returns {{dark: boolean, reason: string}}
   *   reason: 'on' | 'disabled' | 'system-light' | 'listed-off' | 'not-listed' | 'native-dark' | 'no-host'
   */
  function decide(settings, host, env = {}) {
    const s = sanitize(settings);
    const h = normalizeHost(host);
    if (!h) return { dark: false, reason: 'no-host' };
    if (!s.enabled) return { dark: false, reason: 'disabled' };
    const { wantsDark } = siteStatus(s, h);
    if (!wantsDark) return { dark: false, reason: s.listMode === 'blacklist' ? 'listed-off' : 'not-listed' };
    if (s.followSystem && !env.systemDark) return { dark: false, reason: 'system-light' };
    if (s.detectDark && (env.nativeDark || s.nativeDarkHosts.includes(h))) return { dark: false, reason: 'native-dark' };
    return { dark: true, reason: 'on' };
  }

  /**
   * Storage update that flips the current site's per-site state in the active list mode.
   * Turning a site "off" in blacklist mode adds its host; turning it back on removes every
   * pattern that matches it (including wildcards). Whitelist mode is the mirror image.
   * Also clears the native-dark cache for the host so a manual "on" is respected.
   */
  function toggleSiteUpdate(settings, host) {
    const s = sanitize(settings);
    const h = normalizeHost(host);
    const key = listKey(s);
    const list = s[key].slice();
    const matched = matchingPatterns(list, h);
    const update = {};
    update[key] = matched.length ? list.filter(p => !matched.includes(p)) : list.concat(h);
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

  /**
   * Converts a site pattern into WebExtension match patterns (for scripting.registerContentScripts).
   * "example.*" cannot be expressed and returns [].
   */
  function toMatchPatterns(pattern) {
    const p = String(pattern || '').toLowerCase();
    if (!isValidPattern(p) || p.endsWith('.*')) return [];
    if (p.startsWith('*.')) return [`*://${p}/*`];
    return [`*://${p}/*`, `*://www.${p}/*`];
  }

  async function getSettings() {
    return sanitize(await api.storage.local.get(Object.keys(DEFAULTS)));
  }

  function setSettings(update) {
    return api.storage.local.set(update);
  }

  const DarkCore = {
    api, DEFAULTS, LIMITS, NATIVE_DARK_CACHE_MAX,
    normalizeHost, hostFromUrl, isRestrictedUrl, isValidPattern, parseSiteInput,
    matchPattern, matchingPatterns, listKey, sanitize, siteStatus, decide,
    toggleSiteUpdate, rememberNativeDarkUpdate, engineOptions, toMatchPatterns,
    getSettings, setSettings,
  };

  global.DarkCore = DarkCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
