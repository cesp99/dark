import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadScript } from './load.mjs';
import { ROOT } from '../e2e/lib.mjs';

const ctx = loadScript('src/engine.js', { performance });
const E = ctx.DarkEngine;
const U = E.util;

test('engine.js is guarded against double loading', () => {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/engine.js'), 'utf8'), ctx);
  assert.equal(ctx.DarkEngine, E);
});

test('rootFilter: neutral parameters keep the filter compact', () => {
  assert.equal(U.rootFilter(U.clampParams({})), 'invert(0.93) hue-rotate(180deg)');
  assert.equal(U.rootFilter(U.clampParams({ brightness: 80, contrast: 110, sepia: 25 })),
    'invert(0.93) hue-rotate(180deg) brightness(0.8) contrast(1.1) sepia(0.25)');
});

test('clampParams: fills defaults, clamps and ignores junk', () => {
  assert.deepEqual({ ...U.clampParams({ brightness: 'x', contrast: 999, sepia: -5 }) }, { brightness: 100, contrast: 300, sepia: 0 });
});

test('splitSelectors respects parentheses, attribute values and strings', () => {
  assert.deepEqual([...U.splitSelectors('.a, .b:is(.c, .d), [data-x="1,2"], .e')], ['.a', '.b:is(.c, .d)', '[data-x="1,2"]', '.e']);
});

test('subjectCompound picks the part after the last combinator', () => {
  assert.equal(U.subjectCompound('.a > .b .c:hover'), '.c:hover');
  assert.equal(U.subjectCompound('body.home'), 'body.home');
  assert.equal(U.subjectCompound('.x [data-a="b c"]'), '[data-a="b c"]');
});

test('usableSelector never re-inverts the page root, body or everything', () => {
  for (const s of ['html', 'body', ':root', 'body.home', 'html.js body', '.theme body', '*', '.a *', '::-webkit-scrollbar-thumb', '& .x']) {
    assert.equal(U.usableSelector(s), false, s);
  }
  for (const s of ['.hero', '#banner', '.card .thumb', 'body .hero', '.hero::before', 'div[data-bg]']) {
    assert.equal(U.usableSelector(s), true, s);
  }
});

test('isPhotoBackground: photos keep colours, icons/patterns/gradients follow the page', () => {
  const photo = (image, size = '', repeat = '', box) => U.isPhotoBackground({ image, size, repeat }, box);
  assert.ok(photo('url("a.png")', 'cover'));
  assert.ok(photo('url("a.png")', '100% auto'));
  assert.ok(photo('url("photo.jpg")'));
  assert.ok(photo('url("data:image/webp;base64,AAA")'));
  assert.ok(photo('url("data:image/svg+xml,<svg/>")', 'cover')); // a vector hero sized to cover
  assert.ok(photo('url("x")', '', 'no-repeat', { w: 300, h: 200 }));
  assert.ok(!photo('linear-gradient(red, blue)', 'cover'));
  assert.ok(!photo('url("icon.svg")', 'contain', '', { w: 23, h: 13 }));
  assert.ok(!photo('url("sprite.png")', '16px 16px'));
  assert.ok(!photo('url("tile.png")', '', 'repeat', { w: 800, h: 600 }));
  assert.ok(!photo('url("x")', '', 'no-repeat', { w: 24, h: 24 }));
});

test('parseColor handles the serialisations browsers produce', () => {
  assert.deepEqual([...U.parseColor('rgb(1, 2, 3)')], [1, 2, 3, 1]);
  assert.deepEqual([...U.parseColor('rgba(0, 0, 0, 0)')], [0, 0, 0, 0]);
  assert.deepEqual([...U.parseColor('rgb(10 20 30 / 50%)')], [10, 20, 30, 0.5]);
  assert.deepEqual([...U.parseColor('#fff')], [255, 255, 255, 1]);
  assert.deepEqual([...U.parseColor('transparent')], [0, 0, 0, 0]);
  assert.equal(U.parseColor('oklch(0.5 0.1 200)'), null); // resolved via canvas at runtime
});

test('media list re-inverts leaf media but not <picture> or SVG images', () => {
  const list = U.MEDIA.join(',');
  assert.match(list, /(^|,)img:not\(\[src\$="\.svg" i\]\)/);
  assert.match(list, /(^|,)video(,|$)/);
  assert.ok(!/(^|,)picture(,|$)/.test(list));
});
