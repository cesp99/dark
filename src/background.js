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
  hostFromUrl, isRestrictedUrl } = globalThis.DarkCore;

const EARLY_ID = 'dark-early';
const ALL_URLS = ['<all_urls>'];
const REGISTRATION_KEYS = ['enabled', 'listMode', 'blacklist_sites', 'whitelist_sites', 'nativeDarkHosts', 'detectDark', 'followSystem'];

/** Merges the v1 "blacklisted_sites" key (written by the old background script) into blacklist_sites. */
async function migrateStorage() {
  const data = await api.storage.local.get(null);
  if (Array.isArray(data.blacklisted_sites)) {
    const merged = [...new Set([...(data.blacklist_sites || []), ...data.blacklisted_sites])];
    await api.storage.local.set({ blacklist_sites: merged });
    await api.storage.local.remove('blacklisted_sites');
  }
  for (const k of ['tempDisabled']) if (k in data) await api.storage.local.remove(k);
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
  const nativeExcludes = s.detectDark ? toMatches(s.nativeDarkHosts) : [];
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
function syncEarlyScript() {
  chain = chain.then(doSync, doSync);
  return chain;
}

async function doSync() {
  const reg = earlyRegistration(await getSettings());
  const existing = await api.scripting.getRegisteredContentScripts({ ids: [EARLY_ID] }).catch(() => []);
  if (existing.length) await api.scripting.unregisterContentScripts({ ids: [EARLY_ID] }).catch(() => {});
  if (!reg) return;
  try {
    await api.scripting.registerContentScripts([{ ...reg, persistAcrossSessions: true }]);
  } catch (e) {
    try {
      // Older Firefox versions reject persistAcrossSessions; onStartup re-registers anyway.
      await api.scripting.registerContentScripts([reg]);
    } catch (e2) {
      // A single malformed pattern rejects the whole call; fall back to no excludes rather than nothing.
      console.warn('[dark] early script registration failed', e2);
      if (reg.excludeMatches) {
        delete reg.excludeMatches;
        await api.scripting.registerContentScripts([reg]).catch(err => console.warn('[dark] fallback failed', err));
      }
    }
  }
}

/** Flips dark mode for the site shown in a tab. Exposed for the keyboard command and tests. */
async function toggleSiteForTab(tabId) {
  const tab = await api.tabs.get(tabId);
  if (!tab?.url || isRestrictedUrl(tab.url)) return { ok: false, reason: 'restricted' };
  const host = hostFromUrl(tab.url);
  if (!host) return { ok: false, reason: 'no-host' };
  const update = toggleSiteUpdate(await getSettings(), host);
  await setSettings(update);
  return { ok: true, host, update };
}

api.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') await seedDefaults();
  else await migrateStorage();
  await syncEarlyScript();
});

api.runtime.onStartup.addListener(() => { syncEarlyScript(); });

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

Object.assign(globalThis, { toggleSiteForTab, migrateStorage, syncEarlyScript, earlyRegistration });
