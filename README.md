<div align="center">
  <img src="dark-chrome/icons/256.png" alt="Dark by Eyed™ Logo" width="256">
  <h1>Dark by Eyed™</h1>
  <p>Enjoy the web better by having dark mode everywhere.</p>
  <p>
    <img src="https://img.shields.io/badge/version-v2.0.0-blue.svg" alt="Version">
    <img src="https://img.shields.io/badge/license-GPL%203.0-green.svg" alt="License">
  </p>
</div>

## Overview

Dark by Eyed™ is a powerful browser extension that enables dark mode on any website. 
It provides a seamless dark mode experience with customizable blacklist and whitelist options to control which sites should have dark mode enabled.

## Features

- 🌙 Instant dark mode on any website, with no white flash while pages load
- 🖼️ Photos, videos and photo backgrounds keep their real colours; coloured UI keeps its hue
- 🧠 Skips sites that already have their own dark theme (you can still force it per site)
- 🎚️ Brightness, contrast and sepia sliders, applied live to every tab
- 🖥️ Optional: only darken while your OS is in dark mode
- 📋 "Everywhere, except…" or "Only on…" site lists, with `*.example.com` and `example.*` patterns
- ⌨️ `Alt+Shift+D` toggles the current site
- ⚡ One GPU filter instead of repainting every element (~550 ms → ~30 ms style work on a 4000-row page)
- 🔒 Privacy-focused: no data collection, no remote resources, nothing stored from private windows

## Installation

### Firefox

Option 1: Install Dark by Eyed™ directly from the Firefox Add-ons Store:
[Get it for Firefox](https://addons.mozilla.org/firefox/addon/dark-by-eyed)

Option 2: Download the latest release from our [GitHub Releases](https://github.com/cesp99/dark/releases) page and install it manually.

### Chrome

Option 1: Install Dark by Eyed™ from the Chrome Web Store:
[Get it for Chrome](https://chrome.google.com/webstore/detail/ngfmjecoakeejfpmcnjcefkdckbhaeda)

Option 2: Download the latest release from our [GitHub Releases](https://github.com/cesp99/dark/releases) page and install it manually.

## Usage

1. Click on the Dark by Eyed™ icon in your browser toolbar
2. Toggle dark mode for the current site
3. Choose between blacklist or whitelist mode
4. Manage your site lists through the extension popup

## Contributing

We welcome contributions to Dark! Here's how you can help:

1. Fork the repository
2. Create a new branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Commit your changes (`git commit -m 'Add some amazing feature'`)
5. Push to the branch (`git push origin feature/amazing-feature`)
6. Open a Pull Request

Please run `npm test` and update tests as appropriate.

## Development

Both browser packages are built from one source tree in `src/` (see [ARCHITECTURE.md](ARCHITECTURE.md)).

```bash
git clone https://github.com/cesp99/dark.git && cd dark
npm install
npm run build          # -> dist/chrome and dist/firefox (add -- --zip for store packages)
```

Load the extension:

- **Chrome:** open `chrome://extensions`, enable Developer mode, "Load unpacked", select `dist/chrome`
- **Firefox:** open `about:debugging`, "This Firefox", "Load Temporary Add-on", select `dist/firefox/manifest.json`

Tests:

```bash
npm run test:unit      # core logic
npm run test:chrome    # Playwright + Chromium end-to-end (screenshots in tests/e2e/artifacts)
npm run test:firefox   # system Firefox over WebDriver BiDi
node tests/e2e/engine.mjs [--firefox]   # engine rendering/performance cases
npm run test:legacy    # same Chromium suite against the v1 extension from main
npm run lint:firefox
npm run screenshots    # store screenshots on medium.com -> store/screenshots/ (needs a display)
```

The rendering engine (`src/engine.js`) is shared verbatim with [dark.js](https://github.com/cesp99/dark.js).

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.

## Support

If you encounter any issues or have questions, please:

1. Check the [Issues](https://github.com/cesp99/dark/issues) page
2. Create a new issue if your problem isn't already listed
3. Provide as much detail as possible about your problem

---

<div align="center">
Made with ❤️ by Carlo Esposito
</div>