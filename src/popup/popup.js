/*
 * Dark by Eyed — popup.
 * The popup only ever writes storage; the background and content scripts react to
 * storage.onChanged. It reads the content script's state for the status line.
 */
'use strict';

(function () {
  // Errors during load are also exposed to the e2e harness through this buffer.
  const errors = (globalThis.__errors = globalThis.__errors || []);
  addEventListener('error', e => errors.push(String(e.message)));
  addEventListener('unhandledrejection', e => errors.push(String(e.reason?.message || e.reason)));

  const {
    api, DEFAULTS, LIMITS, sanitize, getSettings, setSettings, siteStatus, decide,
    toggleSiteUpdate, parseSiteInput, matchPattern, matchingPatterns, listKey, isRestrictedUrl, hostFromUrl,
    normalizeHost, siteOn, isForced, toUnicodeHost,
  } = globalThis.DarkCore;

  const $ = id => document.getElementById(id);
  const el = {
    body: document.body,
    master: $('master-toggle'), masterState: $('master-state'),
    card: $('site-card'), thumbPage: $('thumb-page'), host: $('current-host'),
    status: $('site-status'), siteToggle: $('site-toggle'), rule: $('site-rule'), grant: $('grant-access'),
    modeBlack: $('mode-blacklist'), modeWhite: $('mode-whitelist'), modeHint: $('mode-hint'),
    reset: $('reset-adjust'),
    followSystem: $('follow-system'), detectDark: $('detect-dark'),
    tabs: [...document.querySelectorAll('[role="tab"]')],
    count: $('site-count'), listTitle: $('list-title'), listHint: $('list-hint'),
    form: $('site-form'), input: $('site-input'), error: $('site-error'),
    note: $('site-note'), noteText: $('site-note-text'), undo: $('site-undo'),
    list: $('site-list'), empty: $('site-empty'), noMatch: $('site-nomatch'),
    quickAdd: $('site-add-current'), quickHost: $('quick-host'),
    keys: $('shortcut-keys'), shortcutText: $('shortcut-text'),
  };
  const SLIDERS = ['brightness', 'contrast', 'sepia'].map(key => ({
    key, input: $(key), output: $(`${key}-value`),
  }));
  const FALLBACK_SHORTCUT = 'Alt+Shift+D';
  const FILTER_THRESHOLD = 6; // the add field also filters the list once it is this long
  const systemDark = matchMedia('(prefers-color-scheme: dark)');

  let settings = sanitize({});
  /** What the popup is pointed at: {tabId, url, host, restricted, label} */
  let target = { tabId: null, url: '', host: '', restricted: true, label: '', needsAccess: false };
  /** Reply from the content script, or null when there is none (yet). */
  let pageState = null;
  let pageStateSeq = 0;
  let pageStateKnown = false;
  let pageStateTimer = null;

  // ------------------------------------------------------------------ target tab

  async function resolveTab() {
    const param = new URLSearchParams(location.search).get('tabId');
    try {
      if (param && /^\d+$/.test(param)) return await api.tabs.get(Number(param));
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      return tab || null;
    } catch {
      return null;
    }
  }

  function describeTarget(tab) {
    const url = tab?.url || tab?.pendingUrl || '';
    const t = { tabId: tab?.id ?? null, url, host: '', restricted: true, label: '' };
    if (!tab) { t.label = 'No page'; return t; }
    // Without a URL the page is one the browser hides from extensions (chrome://, about:…).
    if (!url) { t.label = 'Browser page'; t.url = 'about:'; return t; }
    t.restricted = isRestrictedUrl(url);
    t.host = t.restricted ? '' : hostFromUrl(url);
    if (t.host) { t.label = toUnicodeHost(t.host); return t; }
    try {
      const u = new URL(url);
      if (u.protocol === 'file:') t.label = 'Local file';
      else if (/^(moz|chrome)-extension:$/.test(u.protocol)) t.label = 'Extension page';
      else if (u.protocol === 'http:' || u.protocol === 'https:') t.label = toUnicodeHost(normalizeHost(u.hostname));
      else t.label = `${u.protocol}${u.host ? '//' + u.host : u.pathname}`;
    } catch {
      t.label = 'This page';
    }
    return t;
  }

  /**
   * Without host access (Firefox lets users revoke it; Chrome has "on click" site access) the tab's URL is
   * hidden, which looks like a browser page. Find out, so the popup can offer to grant access instead.
   */
  async function checkAccess() {
    if (target.tabId == null || target.url !== 'about:' || !api.permissions?.contains) return;
    try {
      target.needsAccess = !(await api.permissions.contains({ origins: ['<all_urls>'] }));
    } catch {
      target.needsAccess = false;
    }
    if (target.needsAccess) target.label = 'This site';
  }

  // ------------------------------------------------------------------ page state

  async function refreshPageState() {
    const seq = ++pageStateSeq;
    let reply = null;
    if (target.tabId != null && !target.restricted && target.host) {
      try {
        reply = await api.tabs.sendMessage(target.tabId, { type: 'get-state' });
      } catch {
        reply = null; // no content script in this tab (e.g. opened before install)
      }
    }
    if (seq !== pageStateSeq) return;
    pageState = reply && typeof reply === 'object' && reply.host === target.host ? reply : null;
    pageStateKnown = true;
    renderSite();
  }

  function schedulePageState(delay = 250) {
    clearTimeout(pageStateTimer);
    pageStateTimer = setTimeout(refreshPageState, delay);
  }

  // ------------------------------------------------------------------ rendering

  const STATUS = {
    on: 'Dark mode is on.',
    disabled: 'Dark by Eyed is off everywhere.',
    'system-light': 'Waits for your system to turn dark.',
    'listed-off': 'Kept light as an exception.',
    'not-listed': 'Not on your list, so it stays light.',
    'native-dark': 'Uses its own dark theme.',
    'no-host': 'Nothing to darken on this page.',
    forced: 'Dark mode is on, over the site’s own dark theme.',
  };
  const LOCAL_FILE = {
    on: 'Local files are darkened in “Everywhere, except…” mode.',
    'not-listed': 'Local files are only darkened in “Everywhere, except…” mode.',
  };

  /** The page's own native-dark detection, when its content script told us (else the cache decides). */
  const pageEnv = () => ({
    systemDark: systemDark.matches,
    nativeDark: typeof pageState?.nativeDark === 'boolean' ? pageState.nativeDark : pageState ? pageState.reason === 'native-dark' : undefined,
  });

  function filterFor(s) {
    return `invert(1) hue-rotate(180deg) brightness(${s.brightness / 100}) contrast(${s.contrast / 100}) sepia(${s.sepia / 100})`;
  }

  function renderSite() {
    el.host.textContent = target.label || '…';
    el.host.title = target.url && target.host ? target.host : '';

    let state, dark = false, checked = false, text;
    if (target.restricted || !target.host) {
      state = 'restricted';
      if (target.url.startsWith('file:')) {
        // Local files have no host to list: they follow the list mode.
        const d = decide(settings, '', { systemDark: systemDark.matches, localFile: true });
        dark = d.dark;
        text = `${LOCAL_FILE[d.reason] || STATUS[d.reason] || ''} They can’t be added to your lists.`;
      } else {
        text = target.tabId == null
          ? 'Open a website to control dark mode here.'
          : target.needsAccess
            ? 'Dark by Eyed needs access to websites to darken this page.'
            : 'Browsers don’t let extensions change this page.';
      }
    } else {
      const env = pageEnv();
      const d = decide(settings, target.host, env);
      state = d.reason;
      dark = d.dark;
      checked = siteOn(settings, target.host, env);
      text = STATUS[d.reason] || '';
      if (d.dark && isForced(settings, target.host) && env.nativeDark) text = STATUS.forced;
      // The tab was open before the extension could reach it: say so instead of claiming "on".
      if (d.dark && pageStateKnown && !pageState) {
        text = 'Reload the tab to darken it.';
      }
    }

    el.card.dataset.state = state;
    el.card.dataset.dark = String(dark || state === 'native-dark');
    el.thumbPage.style.filter = dark ? filterFor(settings) : state === 'native-dark' ? 'invert(1) hue-rotate(180deg)' : 'none';
    el.status.textContent = text;
    el.siteToggle.disabled = state === 'restricted';
    el.siteToggle.checked = checked;
    el.grant.hidden = !(state === 'restricted' && target.needsAccess);

    renderRuleNote();
  }

  function renderRuleNote() {
    el.rule.replaceChildren();
    const host = target.host;
    if (target.restricted || !host) { el.rule.hidden = true; return; }
    const rules = siteStatus(settings, host).listedBy.filter(p => normalizeHost(p) !== host);
    if (!rules.length) { el.rule.hidden = true; return; }
    const black = settings.listMode === 'blacklist';
    el.rule.append('Via ');
    rules.forEach((p, i) => {
      if (i) el.rule.append(', ');
      const code = document.createElement('code');
      code.textContent = toUnicodeHost(p);
      code.title = p;
      el.rule.append(code);
    });
    el.rule.append(`. Turning ${black ? 'on' : 'off'} removes ${rules.length > 1 ? 'those rules' : 'that rule'}.`);
    el.rule.hidden = false;
  }

  function renderGlobal() {
    el.master.checked = settings.enabled;
    el.masterState.textContent = settings.enabled ? 'On' : 'Off';

    const black = settings.listMode === 'blacklist';
    el.modeBlack.checked = black;
    el.modeWhite.checked = !black;
    el.modeHint.textContent = black
      ? 'Every site is dark unless you list it under Sites.'
      : 'Only the sites you list under Sites are dark.';

    el.followSystem.checked = settings.followSystem;
    el.detectDark.checked = settings.detectDark;
  }

  // A slider the user is dragging is not overwritten by (possibly stale) storage echoes.
  let activeSlider = null;
  let activeSliderAt = 0;
  const isDragging = key => activeSlider === key && performance.now() - activeSliderAt < 600;

  function renderSliders() {
    let allDefault = true;
    for (const { key, input } of SLIDERS) {
      const [lo, hi] = LIMITS[key];
      if (input.min !== String(lo)) { input.min = lo; input.max = hi; }
      if (!isDragging(key)) input.value = settings[key];
      paintSlider(key);
      if (Number(input.value) !== DEFAULTS[key]) allDefault = false;
    }
    setResetEnabled(!allDefault);
  }

  // aria-disabled instead of disabled: disabling the focused button would drop focus to <body>.
  function setResetEnabled(on) {
    el.reset.setAttribute('aria-disabled', String(!on));
  }

  function paintSlider(key) {
    const { input, output } = SLIDERS.find(s => s.key === key);
    const [lo, hi] = LIMITS[key];
    const v = Number(input.value);
    input.style.setProperty('--pct', `${((v - lo) / (hi - lo)) * 100}%`);
    output.textContent = `${v}%`;
    input.setAttribute('aria-valuetext', `${v}%`);
    output.classList.toggle('changed', v !== DEFAULTS[key]);
  }

  // ------------------------------------------------------------------ site list

  function sortKey(p) { return p.replace(/^\*\./, ''); }

  function renderList() {
    const black = settings.listMode === 'blacklist';
    const list = settings[listKey(settings)];
    el.count.textContent = list.length ? String(list.length) : '';
    el.listTitle.textContent = black ? 'Kept light' : 'Darkened';
    el.listHint.textContent = black
      ? 'Dark mode skips these sites.'
      : 'Dark mode runs only on these sites.';

    const filtering = list.length > FILTER_THRESHOLD;
    el.input.setAttribute('aria-controls', 'site-list');
    $('site-input-label').textContent = filtering ? 'Add or find a site' : 'Add a site';
    const q = filtering ? el.input.value.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '') : '';

    const items = list.slice().sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
      .filter(p => !q || p.includes(q));

    // Keep keyboard focus on the same item across re-renders.
    const focused = el.list.contains(document.activeElement) ? document.activeElement.closest('li')?.dataset.site : null;
    const frag = document.createDocumentFragment();
    for (const pattern of items) frag.append(listItem(pattern));
    el.list.replaceChildren(frag);
    if (focused) {
      const li = [...el.list.children].find(x => x.dataset.site === focused);
      (li ? li.querySelector('[data-remove]') : el.input).focus();
    }

    el.empty.hidden = list.length > 0;
    el.empty.textContent = black
      ? 'No exceptions yet. Every site gets dark mode.'
      : 'No sites yet. Add one above to darken it.';
    el.noMatch.hidden = !(list.length && !items.length);

    // One-click add for the current site when the list doesn't cover it yet.
    const canQuickAdd = !!target.host && !target.restricted && !el.input.value.trim()
      && !matchingPatterns(list, target.host).length;
    el.quickHost.textContent = toUnicodeHost(target.host);
    el.quickAdd.title = target.host;
    el.quickAdd.hidden = !canQuickAdd;
  }

  function listItem(pattern) {
    const li = document.createElement('li');
    li.dataset.site = pattern;

    const name = document.createElement('span');
    name.className = 'pattern';
    name.title = pattern;
    const shown = toUnicodeHost(pattern);
    if (pattern.startsWith('*.')) {
      name.append(wild('*.'), shown.slice(2));
    } else if (pattern.endsWith('.*')) {
      name.append(shown.slice(0, -2), wild('.*'));
    } else {
      name.textContent = shown;
    }
    li.append(name);

    let tag = '';
    let here = false;
    if (target.host && matchPattern(pattern, target.host)) { tag = 'this site'; here = true; }
    else if (pattern.startsWith('*.')) tag = 'and subdomains';
    else if (pattern.endsWith('.*')) tag = 'any ending';
    if (tag) {
      const t = document.createElement('span');
      t.className = here ? 'tag here' : 'tag';
      t.textContent = tag;
      li.append(t);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'remove';
    btn.dataset.remove = '';
    btn.setAttribute('aria-label', `Remove ${shown}`);
    btn.title = 'Remove';
    btn.append(crossIcon());
    li.append(btn);
    return li;
  }

  function wild(text) {
    const s = document.createElement('span');
    s.className = 'wild';
    s.textContent = text;
    return s;
  }

  function crossIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('viewBox', '0 0 12 12');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M2.5 2.5l7 7M9.5 2.5l-7 7');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    svg.append(path);
    return svg;
  }

  function flashItem(pattern) {
    const li = [...el.list.children].find(x => x.dataset.site === pattern);
    if (!li) return;
    li.classList.remove('flash');
    void li.offsetWidth;
    li.classList.add('flash');
    li.scrollIntoView({ block: 'nearest' });
  }

  let noteTimer = null;
  let noteDelay = 0;
  let undoAction = null;
  function showNote(parts, undo) {
    clearTimeout(noteTimer);
    el.noteText.replaceChildren(...parts.map(p => {
      if (typeof p === 'string') return p;
      const c = document.createElement('code');
      c.textContent = toUnicodeHost(p.code);
      c.title = p.code;
      return c;
    }));
    undoAction = undo || null;
    el.undo.hidden = !undo;
    el.note.hidden = false;
    noteDelay = undo ? 7000 : 3500;
    armNote();
    describeInput();
  }
  /** The note stays while it has focus or the pointer (WCAG 2.2.1); the timer restarts afterwards. */
  function armNote() {
    clearTimeout(noteTimer);
    if (el.note.hidden || el.note.matches(':hover') || el.note.contains(document.activeElement)) return;
    noteTimer = setTimeout(hideNote, noteDelay);
  }
  function hideNote() {
    clearTimeout(noteTimer);
    const hadFocus = el.note.contains(document.activeElement);
    el.note.hidden = true;
    el.noteText.replaceChildren();
    el.undo.hidden = true;
    undoAction = null;
    describeInput();
    if (hadFocus) el.input.focus();
  }

  /** The input is described only by messages that are visible (hidden text would still be read). */
  function describeInput() {
    const ids = [];
    if (!el.error.hidden) ids.push('site-error');
    if (!el.note.hidden) ids.push('site-note');
    if (ids.length) el.input.setAttribute('aria-describedby', ids.join(' '));
    else el.input.removeAttribute('aria-describedby');
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.hidden = false;
    el.input.setAttribute('aria-invalid', 'true');
    describeInput();
  }
  function clearError() {
    if (el.error.hidden) return;
    el.error.hidden = true;
    el.error.textContent = '';
    el.input.removeAttribute('aria-invalid');
    describeInput();
  }

  async function writeList(key, list) {
    settings = sanitize({ ...settings, [key]: list });
    renderAll();
    await setSettings({ [key]: list });
  }

  /**
   * With a long list the field also filters it. Enter on a bare word that matches listed sites is a
   * search, not a new site ("goog" while looking for *.google.com); the Add button still adds it.
   */
  function isSearchTerm() {
    const list = settings[listKey(settings)];
    const q = el.input.value.trim().toLowerCase();
    return list.length > FILTER_THRESHOLD && /^[^.*:/]+$/.test(q) && list.some(p => p.includes(q) && p !== q);
  }

  async function addSite() {
    const r = parseSiteInput(el.input.value);
    if (!r.ok) { hideNote(); showError(r.error); el.input.focus(); return; }
    clearError();
    const key = listKey(settings);
    const list = settings[key];
    if (list.includes(r.value)) {
      el.input.value = '';
      renderList();
      showNote([{ code: r.value }, ' is already on the list.']);
      flashItem(r.value);
      return;
    }
    const cover = r.value.includes('*') ? null : list.find(p => matchPattern(p, r.value));
    if (cover) {
      el.input.value = '';
      renderList();
      showNote([{ code: r.value }, ' is already covered by ', { code: cover }, '.']);
      flashItem(cover);
      return;
    }
    el.input.value = '';
    await writeList(key, list.concat(r.value));
    showNote(['Added ', { code: r.value }, '.']);
    flashItem(r.value);
  }

  async function removeSite(pattern, button) {
    const key = listKey(settings);
    const list = settings[key];
    if (!list.includes(pattern)) return;
    // Keep keyboard focus in the list: move it to the next (or previous) remove button.
    const li = button.closest('li');
    const neighbour = (li.nextElementSibling || li.previousElementSibling)?.dataset.site;
    await writeList(key, list.filter(p => p !== pattern));
    const next = neighbour && [...el.list.children].find(x => x.dataset.site === neighbour);
    (next ? next.querySelector('[data-remove]') : el.input).focus();
    showNote(['Removed ', { code: pattern }, '.'], async () => {
      const current = settings[key];
      if (!current.includes(pattern)) await writeList(key, current.concat(pattern));
      showNote(['Restored ', { code: pattern }, '.']);
      flashItem(pattern);
    });
  }

  // ------------------------------------------------------------------ all

  function renderAll() {
    renderGlobal();
    renderSliders();
    renderSite();
    renderList();
  }

  // ------------------------------------------------------------------ writes

  function save(update) {
    settings = sanitize({ ...settings, ...update });
    renderAll();
    return setSettings(update).catch(e => console.error('[dark] could not save settings', e));
  }

  // Slider writes are throttled so pages update live without flooding storage.
  const pendingSliders = {};
  let sliderTimer = null;
  let lastSliderWrite = 0;
  function queueSlider(key, value) {
    pendingSliders[key] = value;
    if (sliderTimer) return;
    const wait = Math.max(0, 50 - (performance.now() - lastSliderWrite));
    sliderTimer = setTimeout(flushSliders, wait);
  }
  function flushSliders() {
    clearTimeout(sliderTimer);
    sliderTimer = null;
    const update = { ...pendingSliders };
    for (const k of Object.keys(pendingSliders)) delete pendingSliders[k];
    if (!Object.keys(update).length) return;
    lastSliderWrite = performance.now();
    setSettings(update).catch(e => console.error('[dark] could not save settings', e));
  }

  // ------------------------------------------------------------------ tabs

  function selectTab(tab, focus) {
    for (const t of el.tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = $(t.getAttribute('aria-controls'));
      panel.hidden = !on;
      panel.tabIndex = on ? 0 : -1;
    }
    if (focus) tab.focus();
  }

  // ------------------------------------------------------------------ shortcut

  async function renderShortcut() {
    let shortcut = FALLBACK_SHORTCUT;
    try {
      const cmds = await api.commands.getAll();
      const cmd = cmds.find(c => c.name === 'toggle-site');
      if (cmd) shortcut = cmd.shortcut || '';
    } catch { /* keep the fallback */ }
    if (!shortcut) {
      el.keys.replaceChildren();
      el.shortcutText.textContent = 'No shortcut set for toggling a site';
      return;
    }
    const parts = shortcut.includes('+') ? shortcut.split('+') : [...shortcut];
    el.keys.replaceChildren(...parts.map(p => {
      const k = document.createElement('kbd');
      k.textContent = p.trim();
      return k;
    }));
    el.keys.setAttribute('aria-label', shortcut);
    el.shortcutText.textContent = 'toggles the current site';
  }

  // ------------------------------------------------------------------ events

  function wire() {
    el.master.addEventListener('change', () => save({ enabled: el.master.checked }));

    el.siteToggle.addEventListener('change', () => {
      if (target.restricted || !target.host) { renderSite(); return; }
      const want = el.siteToggle.checked;
      const env = pageEnv();
      if (siteOn(settings, target.host, env) === want) return;
      save(toggleSiteUpdate(settings, target.host, env));
      schedulePageState(400);
    });

    for (const radio of [el.modeBlack, el.modeWhite]) {
      radio.addEventListener('change', () => {
        if (radio.checked && settings.listMode !== radio.value) {
          hideNote();
          clearError();
          save({ listMode: radio.value });
          schedulePageState(400);
        }
      });
    }

    for (const { key, input } of SLIDERS) {
      input.addEventListener('input', () => {
        activeSlider = key;
        activeSliderAt = performance.now();
        const v = Number(input.value);
        settings = sanitize({ ...settings, [key]: v });
        paintSlider(key);
        setResetEnabled(!SLIDERS.every(s => Number(s.input.value) === DEFAULTS[s.key]));
        renderSite();
        queueSlider(key, v);
      });
      input.addEventListener('change', () => {
        const v = Number(input.value);
        settings = sanitize({ ...settings, [key]: v });
        pendingSliders[key] = v;
        flushSliders();
        activeSlider = null;
        renderSliders();
        renderSite();
      });
    }

    el.reset.addEventListener('click', () => {
      if (el.reset.getAttribute('aria-disabled') === 'true') return;
      activeSlider = null;
      save({ brightness: DEFAULTS.brightness, contrast: DEFAULTS.contrast, sepia: DEFAULTS.sepia });
    });

    el.followSystem.addEventListener('change', () => save({ followSystem: el.followSystem.checked }));
    el.detectDark.addEventListener('change', () => save({ detectDark: el.detectDark.checked }));

    // tabs: click + roving arrow keys (automatic activation)
    for (const tab of el.tabs) tab.addEventListener('click', () => selectTab(tab, false));
    document.querySelector('[role="tablist"]').addEventListener('keydown', e => {
      const i = el.tabs.indexOf(document.activeElement);
      if (i < 0) return;
      let next = null;
      if (e.key === 'ArrowRight') next = el.tabs[(i + 1) % el.tabs.length];
      else if (e.key === 'ArrowLeft') next = el.tabs[(i - 1 + el.tabs.length) % el.tabs.length];
      else if (e.key === 'Home') next = el.tabs[0];
      else if (e.key === 'End') next = el.tabs[el.tabs.length - 1];
      if (next) { e.preventDefault(); selectTab(next, true); }
    });

    el.form.addEventListener('submit', e => { e.preventDefault(); addSite().catch(err => console.error('[dark]', err)); });
    el.input.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || !isSearchTerm()) return;
      e.preventDefault();
      clearError();
      showNote(['Showing matches. Press Add to add ', { code: el.input.value.trim().toLowerCase() }, ' as a site.']);
    });
    el.grant.addEventListener('click', () => {
      // Must be called straight from the click (user gesture).
      api.permissions.request({ origins: ['<all_urls>'] }).then(granted => {
        if (!granted) return;
        if (target.tabId != null) api.tabs.reload(target.tabId).catch(() => {});
        location.reload();
      }, err => console.error('[dark] permission request failed', err));
    });
    for (const ev of ['focusin', 'focusout', 'pointerenter', 'pointerleave']) {
      el.note.addEventListener(ev, () => setTimeout(armNote, 0));
    }
    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && undoAction
        && document.activeElement !== el.input) {
        e.preventDefault();
        el.undo.click();
      }
    });
    el.input.addEventListener('input', () => {
      clearError();
      const filtering = settings[listKey(settings)].length > FILTER_THRESHOLD;
      if (filtering || el.input.value.trim().length <= 1) renderList();
    });
    el.input.addEventListener('keydown', e => {
      if (e.key === 'Escape' && el.input.value) { e.preventDefault(); el.input.value = ''; clearError(); renderList(); }
    });

    el.list.addEventListener('click', e => {
      const btn = e.target.closest('button[data-remove]');
      if (!btn) return;
      removeSite(btn.closest('li').dataset.site, btn).catch(err => console.error('[dark]', err));
    });
    el.quickAdd.addEventListener('click', () => {
      if (!target.host) return;
      const key = listKey(settings);
      const host = target.host;
      if (matchingPatterns(settings[key], host).length) return;
      clearError();
      writeList(key, settings[key].concat(host)).then(() => {
        showNote(['Added ', { code: host }, '.']);
        flashItem(host);
        el.input.focus();
      }, err => console.error('[dark]', err));
    });
    el.undo.addEventListener('click', () => { const a = undoAction; if (a) a().catch(err => console.error('[dark]', err)); });

    systemDark.addEventListener('change', renderSite);

    api.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const next = { ...settings };
      const keys = [];
      for (const [k, { newValue }] of Object.entries(changes)) {
        if (!(k in DEFAULTS) || isDragging(k)) continue;
        next[k] = newValue;
        keys.push(k);
      }
      if (!keys.length) return;
      const before = settings;
      settings = sanitize(next);
      renderGlobal();
      renderSliders();
      renderSite();
      // Rebuilding the list moves focus and resets hover: only when the visible list changed.
      const key = listKey(settings);
      if (keys.includes('listMode') || JSON.stringify(before[key]) !== JSON.stringify(settings[key])) renderList();
      schedulePageState();
    });
  }

  async function init() {
    wire();
    const [s, tab] = await Promise.all([getSettings(), resolveTab()]);
    settings = s;
    target = describeTarget(tab);
    await checkAccess();
    renderAll();
    renderShortcut();
    await refreshPageState();
  }

  init().catch(e => console.error('[dark] popup failed to start', e));
})();
