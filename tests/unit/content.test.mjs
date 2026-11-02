// content.js against a fake browser: real DarkCore, fake engine / storage / DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from '../e2e/lib.mjs';

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tick = () => new Promise(r => setTimeout(r, 0));

function setup({ stored = {}, url = 'https://light.test/page', earlyEnabled = false, nativeDark = false, readyState = 'complete' } = {}) {
  const data = { ...stored };
  const writes = [];
  const storageListeners = [], messageListeners = [], mqlListeners = [];
  const engineCalls = [];
  const engine = {
    on: earlyEnabled, params: null, native: nativeDark,
    isEnabled() { return this.on; },
    enable(o) { engineCalls.push('enable'); this.on = true; this.params = o; return this; },
    update(o) { engineCalls.push('update'); this.params = o; return this; },
    disable() { engineCalls.push('disable'); this.on = false; return this; },
    detectNativeDark() { return this.native; },
  };
  const api = {
    runtime: { id: 'ext', onMessage: { addListener: f => messageListeners.push(f) } },
    storage: {
      onChanged: { addListener: f => storageListeners.push(f) },
      local: {
        async get(keys) { return Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]])); },
        async set(obj) {
          writes.push(obj);
          const changes = {};
          for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: data[k], newValue: v }; data[k] = v; }
          for (const f of storageListeners) f(changes, 'local');
        },
      },
    },
  };
  const docListeners = {};
  const document = {
    readyState, body: {}, documentElement: {},
    addEventListener(t, f) { (docListeners[t] ||= []).push(f); },
  };
  const window = {
    matchMedia: () => ({ matches: false, addEventListener: (t, f) => mqlListeners.push(f) }),
    addEventListener() {},
  };
  window.top = window;
  const ctx = vm.createContext({
    URL, console, setTimeout, clearTimeout, chrome: api, window, document, location: { href: url },
    MutationObserver: class { observe() {} disconnect() {} },
  });
  ctx.globalThis = ctx;
  Object.assign(ctx, { matchMedia: window.matchMedia });
  vm.runInContext(read('src/shared/core.js'), ctx);
  ctx.DarkEngine = { create: () => engine };
  vm.runInContext(read('src/content.js'), ctx);
  const ask = msg => new Promise(resolve => {
    const keep = messageListeners[0](msg, { id: 'ext' }, resolve);
    if (!keep) resolve(undefined);
  });
  return { engine, engineCalls, data, writes, ask, setStorage: o => api.storage.local.set(o) };
}

test('light page: engine enabled with the stored parameters', async () => {
  const t = setup({ stored: { brightness: 80 } });
  await tick(); await tick();
  assert.equal(t.engine.on, true);
  assert.equal(t.engine.params.brightness, 80);
  const state = await t.ask({ type: 'get-state' });
  assert.deepEqual({ ...state }, { host: 'light.test', dark: true, reason: 'on' });
});

test('early script already enabled: parameters are updated in place (no disable/enable)', async () => {
  const t = setup({ earlyEnabled: true, stored: { contrast: 120 } });
  await tick(); await tick();
  assert.deepEqual([...t.engineCalls], ['update']);
  await t.setStorage({ brightness: 70 });
  assert.deepEqual([...t.engineCalls], ['update', 'update']);
  assert.equal(t.engine.params.brightness, 70);
});

test('storage changes apply live: blacklisting the host disables the engine', async () => {
  const t = setup();
  await tick(); await tick();
  await t.setStorage({ blacklist_sites: ['light.test'] });
  assert.equal(t.engine.on, false);
  assert.equal((await t.ask({ type: 'get-state' })).reason, 'listed-off');
});

test('natively dark page: engine disabled and host remembered once', async () => {
  const t = setup({ nativeDark: true, earlyEnabled: true });
  await tick(); await tick(); await tick();
  assert.equal(t.engine.on, false);
  const state = await t.ask({ type: 'get-state' });
  assert.equal(state.reason, 'native-dark');
  assert.deepEqual(t.writes.map(w => Object.keys(w)), [['nativeDarkHosts']]);
  assert.deepEqual([...t.data.nativeDarkHosts], ['light.test']);
});

test('detectDark off: natively dark pages are still darkened and nothing is written', async () => {
  const t = setup({ nativeDark: true, stored: { detectDark: false } });
  await tick(); await tick(); await tick();
  assert.equal(t.engine.on, true);
  assert.equal(t.writes.length, 0);
});

test('restricted pages are never darkened', async () => {
  const t = setup({ url: 'https://chromewebstore.google.com/detail/x', earlyEnabled: true });
  await tick(); await tick();
  assert.equal(t.engine.on, false);
  assert.equal((await t.ask({ type: 'get-state' })).reason, 'no-host');
});

test('ignores unrelated runtime messages', async () => {
  const t = setup();
  assert.equal(await t.ask({ type: 'something-else' }), undefined);
});
