/*
 * Dark by Eyed — early script. Registered dynamically by background.js (together with engine.js)
 * only for pages that should be dark, and injected at document_start: enabling synchronously here,
 * before the page paints, is what prevents the white flash. content.js reconciles afterwards.
 */
(function () {
  'use strict';
  if (window.top !== window || !globalThis.DarkEngine) return;
  try { globalThis.DarkEngine.create().enable(); } catch (e) { console.warn('[dark] early enable failed', e); }
})();
