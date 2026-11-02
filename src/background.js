/*
 * Dark by Eyed — background (Chrome service worker / Firefox event page).
 *
 * Responsibilities:
 *  - seed defaults on install, migrate v1 storage on update
 *  - keep the "early" content script registration in sync with settings, so pages that
 *    should be dark are darkened synchronously at document_start (no white flash) and
 *    pages that shouldn't never get the early script at all
 *  - handle the Alt+Shift+D command (and the equivalent runtime message)
 */
'use strict';

if (typeof importScripts === 'function' && !globalThis.DarkCore) {
  importScripts('shared/core.js');
}

const { api, DEFAULTS, sanitize, getSettings, setSettings, toggleSiteUpdate, toMatchPatterns,
  hostFromUrl, isRestrictedUrl, normalizeSiteList } = globalThis.DarkCore;

const EARLY_ID = 'dark-early';
const ALL_URLS = ['<all_urls>'];
const REGISTRATION_KEYS = ['enabled', 'listMode', 'blacklist_sites', 'whitelist_sites', 'nativeDarkHosts', 'forceDark_sites', 'detectDark', 'followSystem'];

/**
 * Merges the v1 "blacklisted_sites" key (written by the old background script) into blacklist_sites,
 * and normalises v1 list entries ("www.example.com" -> "example.com", lowercase, deduplicated).
 */
async function migrateStorage() {
  const data = await api.storage.local.get(null);
  const update = {};
  for (const key of ['blacklist_sites', 'whitelist_sites']) {
    const extra = key === 'blacklist_sites' && Array.isArray(data.blacklisted_sites) ? data.blacklisted_sites : [];
    if (!Array.isArray(data[key]) && !extra.length) continue;
    const list = normalizeSiteList([...(Array.isArray(data[key]) ? data[key] : []), ...extra]);
    if (JSON.stringify(list) !== JSON.stringify(data[key])) update[key] = list;
  }
  if (Object.keys(update).length) await api.storage.local.set(update);
  for (const k of ['blacklisted_sites', 'tempDisabled']) if (k in data) await api.storage.local.remove(k);
}

async function seedDefaults() {
  let defaults = [];
  try {
    const res = await fetch(api.runtime.getURL('defaults.json'));
    defaults = (await res.json()).blacklisted_sites || [];
  } catch (e) {
    console.warn('[dark] could not load default site list', e);
  }
  const data = await api.storage.local.get(Object.keys(DEFAULTS));
  const update = {};
  for (const [k, v] of Object.entries(DEFAULTS)) if (!(k in data)) update[k] = v;
  update.blacklist_sites = [...new Set([...defaults, ...(data.blacklist_sites || [])])];
  await api.storage.local.set(update);
}

/** Computes the registration for the early script, or null when it must not run anywhere. */
function earlyRegistration(settings) {
  const s = sanitize(settings);
  if (!s.enabled) return null;
  const toMatches = list => [...new Set(list.flatMap(toMatchPatterns))];
  const nativeExcludes = s.detectDark ? toMatches(s.nativeDarkHosts.filter(h => !s.forceDark_sites.includes(h))) : [];
  let matches, excludeMatches;
  if (s.listMode === 'whitelist') {
    matches = toMatches(s.whitelist_sites);
    if (!matches.length) return null;
    excludeMatches = nativeExcludes;
  } else {
    matches = ALL_URLS;
    excludeMatches = [...new Set([...toMatches(s.blacklist_sites), ...nativeExcludes])];
  }
  const reg = {
    id: EARLY_ID,
    js: ['engine.js', s.followSystem ? 'early-system.js' : 'early.js'],
    matches,
    runAt: 'document_start',
    allFrames: false,
  };
  if (excludeMatches.length) reg.excludeMatches = excludeMatches;
  return reg;
}

// Registration calls are serialised: overlapping register/unregister calls race on the id.
let chain = Promise.resolve();
function syncEarlyScript(opts) {
  const run = () => doSync(opts);
  chain = chain.then(run, run);
  return chain;
}

const sameList = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());

/** Whether a registered script already is `reg` (browser restart: persistAcrossSessions kept it). */
function sameRegistration(existing, reg) {
  return !!existing && sameList(existing.js, reg.js) && sameList(existing.matches, reg.matches)
    && sameList(existing.excludeMatches, reg.excludeMatches) && existing.runAt === reg.runAt && !existing.allFrames;
}

async function register(reg) {
  try {
    await api.scripting.registerContentScripts([{ ...reg, persistAcrossSessions: true }]);
  } catch {
    // Older Firefox versions reject persistAcrossSessions; onStartup re-registers anyway.
    await api.scripting.registerContentScripts([reg]);
  }
}

/**
 * The browser rejects a whole registration over one pattern it considers invalid. Find those by
 * registering each pattern on its own (a probe that is removed again), and keep everything else.
 */
async function dropInvalidPatterns(reg) {
  const probe = { id: `${EARLY_ID}-probe`, js: ['early.js'], runAt: 'document_start', persistAcrossSessions: false };
  const valid = async (key, p) => {
    try {
      await api.scripting.registerContentScripts([key === 'matches' ? { ...probe, matches: [p] } : { ...probe, matches: ALL_URLS, excludeMatches: [p] }]);
      await api.scripting.unregisterContentScripts({ ids: [probe.id] }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  };
  const out = { ...reg };
  for (const key of ['matches', 'excludeMatches']) {
    if (!reg[key] || reg[key] === ALL_URLS) continue;
    const keep = [];
    for (const p of reg[key]) {
      if (await valid(key, p)) keep.push(p);
      else console.warn('[dark] skipping a match pattern the browser rejects:', p);
    }
    out[key] = keep;
  }
  if (out.excludeMatches && !out.excludeMatches.length) delete out.excludeMatches;
  return out.matches.length ? out : null;
}

/**
 * Brings the registration in line with the settings. An existing registration is updated in place
 * (unregister + register would leave a window in which pages load without the early script).
 */
async function doSync({ startup = false } = {}) {
  const reg = earlyRegistration(await getSettings());
  const [existing] = await api.scripting.getRegisteredContentScripts({ ids: [EARLY_ID] }).catch(() => []);
  if (!reg) {
    if (existing) await api.scripting.unregisterContentScripts({ ids: [EARLY_ID] }).catch(() => {});
    return;
  }
  if (startup && sameRegistration(existing, reg)) return;
  const attempt = async r => {
    if (existing && api.scripting.updateContentScripts) {
      try {
        // An omitted excludeMatches would keep the old value: pass an empty list instead.
        await api.scripting.updateContentScripts([{ excludeMatches: [], ...r, persistAcrossSessions: true }]);
        return;
      } catch { /* fall back to a fresh registration */ }
      await api.scripting.unregisterContentScripts({ ids: [EARLY_ID] }).catch(() => {});
    }
    await register(r);
  };
  try {
    await attempt(reg);
  } catch (e) {
    console.warn('[dark] early script registration failed', e);
    const fixed = await dropInvalidPatterns(reg);
    const [still] = await api.scripting.getRegisteredContentScripts({ ids: [EARLY_ID] }).catch(() => []);
    if (still) await api.scripting.unregisterContentScripts({ ids: [EARLY_ID] }).catch(() => {});
    if (fixed) await register(fixed).catch(err => console.warn('[dark] fallback failed', err));
  }
}

/** Flips dark mode for the site shown in a tab. Exposed for the keyboard command and tests. */
async function toggleSiteForTab(tabId) {
  const tab = await api.tabs.get(tabId);
  if (!tab?.url || isRestrictedUrl(tab.url)) return { ok: false, reason: 'restricted' };
  const host = hostFromUrl(tab.url);
  if (!host) return { ok: false, reason: 'no-host' };
  // The page knows whether it ships its own dark theme (the cache only knows the host).
  let nativeDark;
  try {
    const state = await api.tabs.sendMessage(tabId, { type: 'get-state' }, { frameId: 0 });
    if (state && state.host === host && typeof state.nativeDark === 'boolean') nativeDark = state.nativeDark;
  } catch { /* no content script in the tab */ }
  const update = toggleSiteUpdate(await getSettings(), host, { nativeDark });
  await setSettings(update);
  return { ok: true, host, update };
}

api.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') await seedDefaults();
  else await migrateStorage();
  await syncEarlyScript();
});

api.runtime.onStartup.addListener(() => { syncEarlyScript({ startup: true }); });

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && REGISTRATION_KEYS.some(k => k in changes)) syncEarlyScript();
});

api.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-site') return;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) await toggleSiteForTab(tab.id);
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== api.runtime.id || !message || typeof message !== 'object') return false;
  if (message.type === 'toggle-site' && Number.isInteger(message.tabId)) {
    toggleSiteForTab(message.tabId).then(sendResponse, e => sendResponse({ ok: false, reason: String(e) }));
    return true;
  }
  return false;
});

Object.assign(globalThis, { toggleSiteForTab, migrateStorage, syncEarlyScript, earlyRegistration, dropInvalidPatterns });
