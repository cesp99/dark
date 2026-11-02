/*
 * Dark by Eyed — content script (top frame, document_start).
 *
 * The authoritative per-page controller: reads the settings, decides with DarkCore.decide(),
 * drives the engine, follows storage / OS-theme changes live and detects sites that already ship
 * a dark theme. The early script (early.js) may already have enabled the engine synchronously;
 * in that case parameters are updated in place, never removed and re-added.
 */
(function () {
  'use strict';

  if (window.top !== window) return;
  const Core = globalThis.DarkCore;
  const Engine = globalThis.DarkEngine;
  if (!Core || !Engine || globalThis.__darkContentLoaded) return;
  globalThis.__darkContentLoaded = true;

  const api = Core.api;
  const host = Core.isRestrictedUrl(location.href) ? '' : Core.hostFromUrl(location.href);
  const localFile = location.protocol === 'file:';
  const engine = Engine.create();
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  // Private windows share storage.local with normal ones: nothing seen there is written to disk.
  const incognito = !!(api.extension && api.extension.inIncognitoContext);

  let settings = null;
  let decision = { dark: engine.isEnabled(), reason: 'pending' };
  let nativeDetected = false; // this page was seen to ship its own dark theme
  let seenLight = false;      // this page was looked at and is light (it does not ship a dark theme)
  let lightStreak = 0;        // "light" detections at load and later, on a host cached as natively dark
  let cachedAtStart = false;  // the host was cached when this page loaded (so it got no early script)
  let persisting = false;

  const ENGINE_KEYS = { brightness: 1, contrast: 1, sepia: 1 };
  // The page's own detection wins over the per-host cache, which is only a hint to avoid a flash
  // (and is shared by every page of the host, in every tab).
  const env = () => ({
    systemDark: mql.matches,
    nativeDark: nativeDetected ? true : seenLight ? false : undefined,
    localFile,
  });

  function apply() {
    if (!settings) return;
    decision = Core.decide(settings, host, env());
    if (decision.dark) {
      const opts = Core.engineOptions(settings);
      if (engine.isEnabled()) engine.update(opts);
      else engine.enable(opts);
    } else if (engine.isEnabled()) {
      engine.disable();
    }
  }

  /** Detection only matters when the page would be dark if it were not natively dark. */
  function detectionMatters() {
    if (!settings || !settings.detectDark || (!host && !localFile) || Core.isForced(settings, host)) return false;
    return Core.decide(settings, host, { systemDark: mql.matches, nativeDark: false, localFile }).dark;
  }

  const isCached = () => !!host && settings.nativeDarkHosts.includes(Core.normalizeHost(host));

  function looksNativeDark() {
    try { return engine.detectNativeDark(); } catch (e) { console.warn('[dark] detection failed', e); return false; }
  }

  /**
   * @param {'body'|'ready'|'settings'|'load'|'late'|'change'} phase
   * Before the settings have arrived this only prevents a flash: if the early script darkened a page
   * that turns out to be natively dark, the engine is switched off at once (decide() runs later).
   * A light page is darkened as soon as it is seen to be light, even on a host cached as natively dark
   * (the cache only decides before the page could be looked at). A page that loaded with its host
   * cached forgets the host again if it is still light at load and a second later.
   */
  function detect(phase) {
    if (!settings) {
      if (nativeDetected || !engine.isEnabled()) return;
      if (looksNativeDark()) {
        nativeDetected = true;
        engine.disable();
      } else {
        seenLight = true;
      }
      return;
    }
    if (nativeDetected || !detectionMatters()) return;
    if (looksNativeDark()) {
      nativeDetected = true;
      apply();
      remember();
      return;
    }
    // A light page is darkened right away, even on a host cached as natively dark.
    if (!seenLight) { seenLight = true; apply(); }
    if (phase === 'load' || phase === 'late') lightStreak++;
    // Only a page that was itself misled by the cache clears it: a light page that happens to be open
    // while another tab caches the host leaves the entry alone.
    if (phase === 'late' && lightStreak >= 2 && cachedAtStart && isCached()) {
      persist(s => {
        const h = Core.normalizeHost(host);
        return s.nativeDarkHosts.includes(h) ? { nativeDarkHosts: s.nativeDarkHosts.filter(x => x !== h) } : null;
      });
    }
  }

  /**
   * Remembers the host so the next visit skips the early script. Already-cached hosts are not
   * re-written: every write re-registers the early script in the background.
   */
  function remember() {
    if (host && !isCached()) persist(s => Core.rememberNativeDarkUpdate(s, host));
  }

  /** Writes an update computed from fresh settings; storage is only touched when it is non-null. */
  async function persist(makeUpdate) {
    if (persisting || incognito) return;
    persisting = true;
    try {
      const update = makeUpdate(await Core.getSettings());
      if (update) await Core.setSettings(update);
    } catch (e) {
      console.warn('[dark] could not save', e);
    } finally {
      persisting = false;
    }
  }

  // ---------------------------------------------------------------- detection schedule

  function whenBody(fn) {
    if (document.body) { fn(); return; }
    const root = document.documentElement || document;
    const mo = new MutationObserver(() => {
      if (document.body) { mo.disconnect(); fn(); }
    });
    mo.observe(root, { childList: true, subtree: root === document });
    document.addEventListener('DOMContentLoaded', () => mo.disconnect(), { once: true });
  }

  function scheduleDetection() {
    whenBody(() => detect('body'));
    const onReady = () => detect('ready');
    const onLoad = () => { detect('load'); setTimeout(() => detect('late'), 1000); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
    else onReady();
    if (document.readyState !== 'complete') window.addEventListener('load', onLoad, { once: true });
    else onLoad();
  }

  // ---------------------------------------------------------------- live updates

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !settings) return;
    const next = Object.assign({}, settings);
    let relevant = false, decisive = false;
    for (const [k, v] of Object.entries(changes)) {
      if (!(k in Core.DEFAULTS)) continue;
      relevant = true;
      if (!(k in ENGINE_KEYS)) decisive = true;
      if (v.newValue === undefined) delete next[k];
      else next[k] = v.newValue;
    }
    if (!relevant) return;
    settings = Core.sanitize(next);
    apply();
    // Slider drags only change filter parameters: no need to look at the page again for those.
    if (decisive && document.readyState !== 'loading') detect('change');
  }

  function onSchemeChanged() {
    if (!settings) return;
    // A site whose own theme follows the OS may have switched: look again once its scripts have run.
    nativeDetected = false;
    seenLight = false;
    lightStreak = 0;
    if (document.readyState !== 'loading') detect('change'); // media queries apply synchronously
    apply();
    setTimeout(() => detect('change'), 300);
  }

  async function reload() {
    try {
      settings = await Core.getSettings();
    } catch (e) {
      console.warn('[dark] could not read settings', e);
      return;
    }
    if (decision.reason === 'pending') cachedAtStart = isCached();
    apply();
  }

  if (host || localFile) scheduleDetection();
  const ready = reload().then(() => {
    if (nativeDetected && detectionMatters()) remember(); // detected before the settings arrived
    // A host cached as natively dark got no early script: look at the page now rather than at load.
    else if (!nativeDetected && !seenLight && document.body && (host || localFile)) detect('settings');
  });

  api.storage.onChanged.addListener(onStorageChanged);
  mql.addEventListener('change', onSchemeChanged);
  window.addEventListener('pageshow', e => { if (e.persisted) reload(); });

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'get-state') return false;
    if (sender && sender.id && sender.id !== api.runtime.id) return false;
    ready.then(() => sendResponse({ host, dark: engine.isEnabled(), reason: decision.reason, nativeDark: nativeDetected }));
    return true;
  });
})();
