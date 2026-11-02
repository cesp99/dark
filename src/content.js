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
  const engine = Engine.create();
  const mql = window.matchMedia('(prefers-color-scheme: dark)');

  let settings = null;
  let decision = { dark: engine.isEnabled(), reason: 'pending' };
  let nativeDetected = false; // this page was seen to ship its own dark theme
  let lightStreak = 0;        // consecutive "light" detections on a host cached as natively dark
  let persisting = false;

  const ENGINE_KEYS = { brightness: 1, contrast: 1, sepia: 1 };
  const env = () => ({ systemDark: mql.matches, nativeDark: nativeDetected });

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
    if (!settings || !settings.detectDark || !host) return false;
    return Core.decide(Object.assign({}, settings, { nativeDarkHosts: [] }), host, { systemDark: mql.matches }).dark;
  }

  const isCached = () => settings.nativeDarkHosts.includes(Core.normalizeHost(host));

  function looksNativeDark() {
    try { return engine.detectNativeDark(); } catch (e) { console.warn('[dark] detection failed', e); return false; }
  }

  /**
   * @param {'body'|'ready'|'load'|'late'|'change'} phase
   * Before the settings have arrived this only prevents a flash: if the early script darkened a page
   * that turns out to be natively dark, the engine is switched off at once (decide() runs later).
   * A host cached as natively dark is forgotten again only if the page is light at every phase of a
   * load (sites whose theme follows the OS, or where only some pages are dark).
   */
  function detect(phase) {
    if (!settings) {
      if (!nativeDetected && engine.isEnabled() && looksNativeDark()) {
        nativeDetected = true;
        engine.disable();
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
    if (phase === 'ready' || phase === 'load' || phase === 'late') lightStreak++;
    if (phase === 'late' && lightStreak >= 3 && isCached()) {
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
    if (!isCached()) persist(s => Core.rememberNativeDarkUpdate(s, host));
  }

  /** Writes an update computed from fresh settings; storage is only touched when it is non-null. */
  async function persist(makeUpdate) {
    if (persisting) return;
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
    apply();
  }

  if (host) scheduleDetection();
  const ready = reload().then(() => {
    if (nativeDetected && detectionMatters()) remember(); // detected before the settings arrived
  });

  api.storage.onChanged.addListener(onStorageChanged);
  mql.addEventListener('change', onSchemeChanged);
  window.addEventListener('pageshow', e => { if (e.persisted) reload(); });

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'get-state') return false;
    if (sender && sender.id && sender.id !== api.runtime.id) return false;
    ready.then(() => sendResponse({ host, dark: engine.isEnabled(), reason: decision.reason }));
    return true;
  });
})();
