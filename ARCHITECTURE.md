# Architecture

One source tree (`src/`) builds both browser packages (`npm run build` → `dist/chrome`, `dist/firefox`,
both Manifest V3). Every runtime file is a **classic script** (no ES modules, no bundler) so the same file
can be a content script, a popup script, a Firefox background script and a Chrome `importScripts` target.

```
src/
  shared/core.js     DarkCore: settings schema, host/pattern matching, decide(), toggle helpers
  engine.js          DarkEngine: the rendering engine (shared verbatim with the dark.js library)
  early.js           dynamically-registered document_start script: enables the engine synchronously
  early-system.js    same, but only if the OS is in dark mode (used when followSystem is on)
  content.js         static content script: authoritative settings, live sync, native-dark detection
  background.js      install/migration, early-script registration, Alt+Shift+D command
  popup/             popup.html, popup.css, popup.js
  defaults.json      default site list seeded on first install
  icons/
```

## Settings (`chrome.storage.local`)

See `DEFAULTS` in `src/shared/core.js`. Key names `listMode`, `blacklist_sites`, `whitelist_sites` are
kept from v1 so existing users keep their lists. Everything reacts to `storage.onChanged`; the popup and
the keyboard command only ever **write storage** — there is no tab messaging for state changes.

## Engine — hybrid filter

The engine does not repaint elements. It inverts the whole page once with a GPU filter on the root
element and re-inverts media so photos and video keep their real colours:

```
:root            { filter: invert(0.93) hue-rotate(180deg) [brightness/contrast/sepia] }
img, video, …    { filter: invert(1) hue-rotate(180deg) contrast(1.163) }   /* exact inverse */
photo bg images  { same }   /* selectors harvested from stylesheets + inline styles */
nested media     { filter: none }   /* never invert twice */
```

`invert(0.93)` maps white to #121212 and black to #ededed (softer than pure black, and leaves headroom for
the brightness slider); media gets the mathematical inverse so mid-tones are exact. SVG `<img>`s follow
the page (they are almost always dark-ink logos/icons). See the header comment of `src/engine.js` for
browser-specific notes (canvas background, top layer, WebKit SVG).

Cost is a single compositing filter instead of style recalculation over every element (legacy: a
universal `*{…!important}` rule, ~550 ms RecalcStyle on a 4000-row page).

### `DarkEngine` API (src/engine.js)

`globalThis.DarkEngine` — guarded so loading the file twice is harmless.

| member | |
|---|---|
| `DarkEngine.create(opts?)` | returns the singleton engine for the document (`opts.doc`, `opts.win`) |
| `engine.enable(options?)` | inject/refresh the style; `options = {brightness, contrast, sepia}` in percent |
| `engine.update(options)` | change filter parameters without re-enabling |
| `engine.disable()` | remove everything the engine added |
| `engine.isEnabled()` | |
| `engine.detectNativeDark()` | `true` if the page ships its own dark theme (reads computed colours, which the filter does not change) |

The style element is appended to `document.documentElement` (it exists at `document_start`; `head` may not).

## Flash-free loading

`content.js` must read storage asynchronously, which is too late to avoid a white flash. So the background
keeps a **dynamically registered** content script (`early.js`) whose `matches` / `excludeMatches` are derived
from the settings (`earlyRegistration()` in `background.js`):

* blacklist mode — matches `<all_urls>`, excludes blacklisted patterns and cached natively-dark hosts
* whitelist mode — matches only whitelisted patterns
* master switch off — not registered at all

`early.js` therefore runs only where the page should be dark and calls `DarkEngine.create().enable()`
synchronously. `content.js` then reconciles with the real settings (slider values, `example.*` patterns that
cannot be expressed as match patterns, native-dark detection).

## Content-script contract (src/content.js)

* runs on every page at `document_start`, top frame only
* reads settings → `DarkCore.decide(settings, host, {systemDark, nativeDark})` → enable/disable engine
* listens to `storage.onChanged` and `matchMedia('(prefers-color-scheme: dark)')` and re-decides live
* when `detectDark` is on and the engine detects a native dark theme: disable, and remember the host via
  `DarkCore.rememberNativeDarkUpdate` (so the next visit is excluded from the early script)
* answers `runtime.onMessage({type: 'get-state'})` with `{host, dark, reason}` for the popup

## Popup contract (ids used by tests/e2e)

`#master-toggle` checkbox, `#current-host`, `#site-status`, `#site-toggle` checkbox (disabled on restricted
pages), `#mode-blacklist` / `#mode-whitelist` radios, `#brightness` / `#contrast` / `#sepia` ranges,
`#follow-system` / `#detect-dark` checkboxes, a `[data-tab="sites"]` tab, `#site-input`, `#site-add`,
`#site-error` (inline validation), `#site-list` containing `[data-site="<pattern>"]` items each with a
`button[data-remove]`. The popup targets the active tab, or `?tabId=<id>` when given (used by tests).

## Tests

* `npm run test:unit` — core logic (node:test)
* `npm run test:chrome` — Playwright + Chromium, loads `dist/chrome`
* `npm run test:firefox` — puppeteer-core + system Firefox over WebDriver BiDi, loads `dist/firefox`
* `--legacy` on either e2e suite runs the same assertions against the v1 extension from `main`
