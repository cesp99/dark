/*
 * Dark by Eyed — early script used when "follow system theme" is on: like early.js, but only
 * enables while the OS is in dark mode. content.js keeps following the OS afterwards.
 */
(function () {
  'use strict';
  if (window.top !== window || !globalThis.DarkEngine) return;
  try {
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) globalThis.DarkEngine.create().enable();
  } catch (e) { console.warn('[dark] early enable failed', e); }
})();
