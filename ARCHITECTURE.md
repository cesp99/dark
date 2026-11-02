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
kept from v1 so existing users keep their lists (entries are normalised on update: `www.example.com` →
`example.com`). `forceDark_sites` holds hosts the user turned on although they look natively dark: detection
leaves them alone. Unicode (IDN) hosts are stored in punycode and shown in Unicode by the popup. Everything reacts to `storage.onChanged`; the popup and
the keyboard command only ever **write storage** — there is no tab messaging for state changes.

## Engine — hybrid filter

The engine does not repaint elements. It inverts the whole page once with a GPU filter on the root
element and re-inverts media so photos and video keep their real colours:

```
:root            { filter: invert(0.93) hue-rotate(180deg) [brightness/contrast/sepia] }
img, video, …    { filter: invert(1) hue-rotate(180deg) contrast(1.163) }   /* exact inverse */
photo bg images  { same }   /* selectors harvested from stylesheets + inline styles */
[data-dark-bg]   { same }   /* boxes found by the element walk (see below) */
nested media     { filter: none }   /* never invert twice */
```

The "never invert twice" guard is written as flat `:is(ancestors) target` selectors, one per target, so every
selector is bucketed by its subject and engines without CSS nesting apply it too.

An idle-time element walk (bounded per tick; attribute writes are batched after the reads) marks what CSS
alone cannot select: photo backgrounds from unreadable (cross-origin) stylesheets (`data-dark-bg=""`), boxes
covered by a photo or video with content drawn on top, such as hero banners (`data-dark-bg="cover"`: the box is
re-inverted, so overlaid text keeps its designed colours), and translucent black modal/consent backdrops
(`data-dark-scrim`: re-inverted so they dim the dark page instead of washing it out). It also styles open
shadow roots (at most 100 per tick; the engine only keeps weak references to them).

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
If the page's Content-Security-Policy blocks it (only possible for dark.js, which runs in the page world:
extension content-script styles are exempt), the engine falls back to a constructed stylesheet in
`adoptedStyleSheets`; if that is unavailable too, `isEnabled()` is false and `isBlocked()` true. `mount()`
removes engine styles left behind by a dead copy (Firefox keeps an updated extension's DOM changes).

## Flash-free loading

`content.js` must read storage asynchronously, which is too late to avoid a white flash. So the background
keeps a **dynamically registered** content script (`early.js`) whose `matches` / `excludeMatches` are derived
from the settings (`earlyRegistration()` in `background.js`):

* blacklist mode — matches `<all_urls>`, excludes blacklisted patterns and cached natively-dark hosts
* whitelist mode — matches only whitelisted patterns
* master switch off — not registered at all

The registration is updated in place (`scripting.updateContentScripts`), never unregistered and registered
again, so no page loads in a gap without it. Hosts that cannot be expressed as match patterns (`example.*`,
numeric hosts other than IPv4 addresses) are left to `content.js`; if the browser still rejects a pattern,
only that pattern is dropped.

`early.js` therefore runs only where the page should be dark and calls `DarkEngine.create().enable()`
synchronously. `content.js` then reconciles with the real settings (slider values, `example.*` patterns that
cannot be expressed as match patterns, native-dark detection).

## Content-script contract (src/content.js)

* runs on every page at `document_start`, top frame only
* reads settings → `DarkCore.decide(settings, host, {systemDark, nativeDark, localFile})` → enable/disable engine
* listens to `storage.onChanged` and `matchMedia('(prefers-color-scheme: dark)')` and re-decides live
* when `detectDark` is on and the engine detects a native dark theme: disable, and remember the host via
  `DarkCore.rememberNativeDarkUpdate` (so the next visit is excluded from the early script)
* the page's own detection beats the `nativeDarkHosts` cache, which is only a flash-avoidance hint: a light
  page on a cached host is darkened as soon as it is seen to be light, and other tabs caching the host do not
  affect it
* nothing is written to storage from private/incognito windows
* `file://` pages (no host) follow the list mode: dark in "everywhere, except" mode, light in "only on" mode
* answers `runtime.onMessage({type: 'get-state'})` with `{host, dark, reason, nativeDark}` for the popup and
  the keyboard command (the site switch on a natively dark page writes `forceDark_sites`)

## Popup contract (ids used by tests/e2e)

`#master-toggle` checkbox, `#current-host`, `#site-status`, `#site-toggle` checkbox (disabled on restricted
pages), `#mode-blacklist` / `#mode-whitelist` radios, `#brightness` / `#contrast` / `#sepia` ranges,
`#follow-system` / `#detect-dark` checkboxes, a `[data-tab="sites"]` tab, `#site-input`, `#site-add`,
`#site-error` (inline validation), `#site-note` (with `#site-undo`), `#grant-access` (shown when the
browser hides the tab because host access was revoked), `#site-list` containing `[data-site="<pattern>"]`
items each with a `button[data-remove]`. The site switch shows whether the site gets dark mode (a natively
dark site shows off; turning it on forces dark mode there). The popup targets the active tab, or `?tabId=<id>` when given (used by tests).

## Tests

* `npm run test:unit` — core logic (node:test)
* `npm run test:chrome` — Playwright + Chromium, loads `dist/chrome`
* `npm run test:firefox` — puppeteer-core + system Firefox over WebDriver BiDi, loads `dist/firefox`
* `--legacy` on either e2e suite runs the same assertions against the v1 extension from `main`
