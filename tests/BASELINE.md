# Legacy baseline (v1.0, `main` branch)

Results of the e2e suites run against the pre-revamp extension
(`npm run test:legacy`, `node tests/e2e/firefox.mjs --legacy`) on 2026-11-02.

## Chromium (MV3) — 10/16 passed

| Test | Result | Detail |
|---|---|---|
| light page is darkened | ✓ | bg rgb(18,18,18) |
| text block becomes light-on-dark | ✓ | |
| `<img>` keeps its original colours | ✓ | |
| CSS background-image keeps its original colours | ✓ | |
| coloured UI keeps its hue | ✗ | blue panel flattened to rgb(23,22,22) — universal `*` rule paints everything #121212 |
| no flash of light content | ✗ | styles only injected after async storage read, into `document.head` |
| short page: canvas below content is dark | ✓ | |
| default list: aploi.de left alone | ✓ | |
| `*.eyed.to` matches mail.eyed.to / eyed.to | ✓ | |
| `*.eyed.to` does NOT match noteyed.to | ✗ | `endsWith` without a dot boundary |
| natively dark site stays dark | ✓ | (by accident: everything is repainted #121212) |
| color-scheme dark site stays dark | ✓ | |
| performance: 4000-row page | ✗ | **RecalcStyle 553 ms** |
| popup opens without errors | ✗ | `popup.js:101` — `getElementById("addSite")` is null (ids are `addSiteBtn`/`siteInput`) |
| popup: add a site | ✗ | same crash, Chrome users could never add sites |

## Firefox (MV2) — 8/11 passed

Fails: blue panel flattened, flash of light content, `notgoogle.com` matched by `*.google.com`.
