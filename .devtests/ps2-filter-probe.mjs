/**
 * PS2 filter (key 9) + 512 px texture ceiling probe.
 *
 * Boots the real game in Chromium, drives it to the road, and checks:
 *  1. the 512 px ceiling actually reaches the GPU — every imported texture's
 *     uploaded image is <= 512 on both sides, and the quality tiers cannot
 *     lift it;
 *  2. the filter panel exists, key 9 opens it, and it is mutually exclusive
 *     with the debug menu;
 *  3. each of the three stages measurably changes the picture in the way it
 *     claims to: pixelation makes neighbouring pixels equal, quantization
 *     collapses the number of distinct values, dither brings some back, and
 *     grain moves pixels frame to frame while quantization alone does not;
 *  4. a switched-off filter is byte-neutral and releases the offscreen buffer.
 *
 * Run: node .devtests/ps2-filter-probe.mjs
 * Screenshots land in .devtests/shots/ (gitignored).
 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, '.devtests', 'shots');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.obj': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg',
};

const server = createServer(async (request, response) => {
  try {
    const urlPath = request.url.split('?')[0];
    const file = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
    const body = await readFile(join(ROOT, file));
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
// Split routing is mandatory: the game imports both `three` and
// `three/addons/utils/BufferGeometryUtils.js`. Serving the core build for the
// addon path kills mergeGeometries and the map never appears.
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const url = new URL(route.request().url());
  const addon = url.pathname.match(/\/examples\/jsm\/(.+)$/);
  const file = addon
    ? join(ROOT, 'node_modules', 'three', 'examples', 'jsm', addon[1])
    : join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(file) });
});

const page = await context.newPage();
const errors = [];
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
page.on('pageerror', (error) => errors.push(String(error)));
page.on('dialog', (dialog) => dialog.accept());

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} · ${name}${detail ? ` · ${detail}` : ''}`);
};

await mkdir(SHOTS, { recursive: true });
await page.goto(`http://127.0.0.1:${port}/`);
try {
  await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });
} catch (error) {
  // A boot failure is almost always a module/shader error, and the timeout
  // message alone says nothing about which. Print what the page reported.
  console.error('BOOT FAILED · page errors:\n' + (errors.join('\n') || '(none captured)'));
  throw error;
}
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 20000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 20000 });
await page.waitForTimeout(2500);

// ---- 1. The 512 px ceiling ----------------------------------------------
// Walk every material in every scene and measure the image that is actually
// uploaded (texture.image), not the source the editor imported.
const measureTextures = () => page.evaluate(() => {
  const seen = new Set();
  const sizes = [];
  const size = (image) => [
    image?.naturalWidth || image?.videoWidth || image?.width || 0,
    image?.naturalHeight || image?.videoHeight || image?.height || 0,
  ];
  for (const scene of [window.shutoko.roadScene, window.shutoko.garageScene, window.shutoko.paScene]) {
    scene?.traverse((object) => {
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        for (const slot of ['map', 'emissiveMap', 'roughnessMap', 'normalMap']) {
          const texture = material?.[slot];
          if (!texture?.image || seen.has(texture.uuid)) continue;
          seen.add(texture.uuid);
          const [width, height] = size(texture.image);
          const [sourceWidth, sourceHeight] = size(texture.userData?.hesiSourceImage);
          if (width && height) sizes.push({ name: texture.name || texture.image.src?.slice(-40) || slot, width, height, sourceWidth, sourceHeight });
        }
      }
    });
  }
  return sizes;
});

// The skybox is deliberately outside the ceiling: it is one equirectangular
// panorama covering 360°, so 512 px across the whole horizon is roughly 1.4 px
// per degree — a smear rather than a retro texture. It carries its own clamp in
// js/skybox.js and is excluded here on purpose, not by accident.
const textures = await measureTextures();
const capped = textures.filter((entry) => !/^Skybox/.test(entry.name));
const oversized = capped.filter((entry) => entry.width > 512 || entry.height > 512);
check('every uploaded texture is within 512×512',
  capped.length > 0 && oversized.length === 0,
  `${capped.length} textures · ${oversized.length} over · largest ${Math.max(0, ...capped.map((t) => Math.max(t.width, t.height)))} px`
    + (oversized.length ? ` · ${oversized.slice(0, 3).map((t) => `${t.name} ${t.width}×${t.height}`).join(', ')}` : ''));
// A downscale must preserve the aspect ratio, or a 1024×256 banner comes back
// as a square and every letter on it is stretched. The tolerance is relative:
// rounding a 1672×837 source to whole pixels can never land exactly on the
// source ratio, and the error scales with how elongated the image is.
const rescaled = capped.filter((entry) => entry.sourceWidth > 512 || entry.sourceHeight > 512);
const skewed = rescaled.filter((entry) => {
  const source = entry.sourceWidth / entry.sourceHeight;
  return Math.abs((entry.width / entry.height) - source) / source > 0.02;
});
check('downscaled imports keep their aspect ratio',
  skewed.length === 0,
  `${rescaled.length} downscaled · ${skewed.length} skewed`
    + (skewed.length ? ` · ${skewed.slice(0, 3).map((t) => `${t.name} ${t.sourceWidth}×${t.sourceHeight}→${t.width}×${t.height}`).join(', ')}` : ''));

const budgets = await page.evaluate(async () => {
  const game = window.shutoko;
  const out = {};
  for (const quality of ['low', 'medium', 'high']) {
    game.state.settings.quality = quality;
    game.resize({ force: true });
    await new Promise((done) => setTimeout(done, 250));
    const sizes = [];
    game.roadScene.traverse((object) => {
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        const image = material?.map?.image;
        if (image && !/^Skybox/.test(material.map.name || '')) sizes.push(Math.max(image.naturalWidth || image.width || 0, image.naturalHeight || image.height || 0));
      }
    });
    out[quality] = Math.max(0, ...sizes);
  }
  game.state.settings.quality = 'medium';
  game.resize({ force: true });
  return out;
});
check('no quality tier lifts the ceiling',
  Object.values(budgets).every((size) => size <= 512),
  JSON.stringify(budgets));

// ---- 2. The panel --------------------------------------------------------
await page.keyboard.press('Digit9');
await page.waitForTimeout(250);
const opened = await page.evaluate(() => ({
  filterOpen: window.shutoko.debug.filterOpen,
  menuOpen: window.shutoko.debug.menuOpen,
  visible: !document.getElementById('filter-menu')?.classList.contains('hidden'),
  sliders: document.querySelectorAll('#filter-menu input[type=range]').length,
  patterns: document.querySelectorAll('#filter-dither-pattern option').length,
}));
check('9 opens the filter panel with every dial built',
  opened.filterOpen === true && opened.visible === true && opened.sliders === 9 && opened.patterns === 3,
  JSON.stringify(opened));
check('the panel freezes the drive like the debug menu', opened.menuOpen === true);

const exclusive = await page.evaluate(() => {
  window.shutoko.toggleDebugMenu(true);
  return {
    filterOpen: window.shutoko.debug.filterOpen,
    debugOpen: window.shutoko.debug.debugOpen,
    filterHidden: document.getElementById('filter-menu')?.classList.contains('hidden'),
  };
});
check('opening the debug menu closes the filter panel',
  exclusive.filterOpen === false && exclusive.debugOpen === true && exclusive.filterHidden === true,
  JSON.stringify(exclusive));
await page.evaluate(() => window.shutoko.toggleDebugMenu(false));

// ---- 3. The picture ------------------------------------------------------
// One helper: read the presented canvas and report the statistics each stage
// is supposed to move.
const grabFrame = () => page.evaluate(() => new Promise((done) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const source = window.shutoko.renderer.domElement;
    const w = 320, h = 180;
    const scratch = document.createElement('canvas');
    scratch.width = w; scratch.height = h;
    const ctx = scratch.getContext('2d');
    ctx.drawImage(source, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const levels = new Set();
    let sum = 0, max = 0, equalNeighbours = 0, pairs = 0;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        sum += luma; if (luma > max) max = luma;
        levels.add(data[i]);
        if (x + 1 < w) {
          const j = i + 4;
          pairs += 1;
          if (data[i] === data[j] && data[i + 1] === data[j + 1] && data[i + 2] === data[j + 2]) equalNeighbours += 1;
        }
      }
    }
    done({
      mean: sum / (w * h), max, redLevels: levels.size,
      flatness: equalNeighbours / pairs, pixels: Array.from(data),
    });
  }));
}));

const meanDelta = (a, b) => {
  let diff = 0;
  for (let i = 0; i < a.pixels.length; i += 4) {
    diff += Math.abs(a.pixels[i] - b.pixels[i])
      + Math.abs(a.pixels[i + 1] - b.pixels[i + 1])
      + Math.abs(a.pixels[i + 2] - b.pixels[i + 2]);
  }
  return diff / (a.pixels.length / 4 * 3);
};

const setFilter = (patch) => page.evaluate((value) => {
  const game = window.shutoko;
  game.admin.ps2Filter = { ...game.admin.ps2Filter, ...value };
  game._applyFilterSettings(false);
}, patch);

// Baseline: filter off, tape off, nothing but the scene.
await page.evaluate(() => window.shutoko.changeSetting('vhs', false));
await setFilter({ enabled: false });
await page.waitForTimeout(600);
const clean = await grabFrame();
const cleanState = await page.evaluate(() => ({
  active: window.shutoko.vhs.active(), hasTarget: !!window.shutoko.vhs.target,
}));
check('a disabled filter releases the buffer and renders straight to the canvas',
  cleanState.active === false && cleanState.hasTarget === false, JSON.stringify(cleanState));
check('the clean frame is a real picture, not black',
  clean.mean > 2 && clean.max > 40, `mean ${clean.mean.toFixed(1)} max ${clean.max.toFixed(0)}`);

// Enabled but every dial neutral: the pass must be a pure passthrough. This is
// the guard against the offscreen buffer quietly changing the picture.
await setFilter({ enabled: true, pixelLines: 0, colorLevels: 0, dither: 0, grain: 0 });
await page.waitForTimeout(600);
const neutral = await grabFrame();
const neutralShift = Math.abs(neutral.mean - clean.mean) / Math.max(1, clean.mean);
check('a neutral filter changes nothing', neutralShift < 0.02,
  `${(neutralShift * 100).toFixed(2)}% · ${clean.mean.toFixed(2)} vs ${neutral.mean.toFixed(2)}`);

// Pixelation: neighbouring pixels become equal because they are one sample.
await setFilter({ enabled: true, pixelLines: 120, colorLevels: 0, dither: 0, grain: 0 });
await page.waitForTimeout(600);
const pixelated = await grabFrame();
await page.screenshot({ path: join(SHOTS, 'ps2-filter-pixelation.png') });
check('pixelation collapses neighbouring pixels into blocks',
  pixelated.flatness > clean.flatness + 0.2,
  `flat neighbours ${(clean.flatness * 100).toFixed(1)}% → ${(pixelated.flatness * 100).toFixed(1)}%`);
check('pixelation does not shift exposure',
  Math.abs(pixelated.mean - clean.mean) / Math.max(1, clean.mean) < 0.12,
  `${clean.mean.toFixed(1)} → ${pixelated.mean.toFixed(1)}`);

// Quantization: fewer distinct values. Dither then trades some of them back —
// the whole reason the two dials live together.
await setFilter({ enabled: true, pixelLines: 0, colorLevels: 4, dither: 0, grain: 0 });
await page.waitForTimeout(600);
const quantized = await grabFrame();
await page.screenshot({ path: join(SHOTS, 'ps2-filter-quantized.png') });
check('quantization collapses the number of distinct values',
  quantized.redLevels < clean.redLevels * 0.5,
  `${clean.redLevels} → ${quantized.redLevels} distinct red values`);

await setFilter({ enabled: true, pixelLines: 0, colorLevels: 4, dither: 1.2, grain: 0 });
await page.waitForTimeout(600);
const dithered = await grabFrame();
await page.screenshot({ path: join(SHOTS, 'ps2-filter-dithered.png') });
check('dither breaks up the bands quantization created',
  meanDelta(dithered, quantized) > 0.5 && dithered.flatness < quantized.flatness,
  `delta ${meanDelta(dithered, quantized).toFixed(2)}/255 · flat ${(quantized.flatness * 100).toFixed(1)}% → ${(dithered.flatness * 100).toFixed(1)}%`);

// Grain: moves frame to frame at a non-zero speed, and is frozen at 0 Hz.
await setFilter({ enabled: true, pixelLines: 0, colorLevels: 0, dither: 0, grain: 1.2, grainSpeed: 30, grainScale: 1 });
await page.waitForTimeout(600);
const grainA = await grabFrame();
await page.waitForTimeout(260);
const grainB = await grabFrame();
await page.screenshot({ path: join(SHOTS, 'ps2-filter-grain.png') });
check('grain visibly textures the picture',
  meanDelta(grainA, clean) > 1, `mean channel delta ${meanDelta(grainA, clean).toFixed(2)}/255`);
check('grain moves between frames at 30 Hz',
  meanDelta(grainA, grainB) > 0.5, `frame-to-frame delta ${meanDelta(grainA, grainB).toFixed(2)}/255`);

await setFilter({ enabled: true, grain: 1.2, grainSpeed: 0 });
await page.waitForTimeout(600);
const frozenA = await grabFrame();
await page.waitForTimeout(260);
const frozenB = await grabFrame();
check('grain at 0 Hz is frozen',
  meanDelta(frozenA, frozenB) < meanDelta(grainA, grainB) * 0.5,
  `still delta ${meanDelta(frozenA, frozenB).toFixed(3)} vs moving ${meanDelta(grainA, grainB).toFixed(3)}`);

// ---- 4. Panel plumbing ---------------------------------------------------
const wiring = await page.evaluate(() => {
  const game = window.shutoko;
  game.applyFilterPreset('ps1');
  const slider = document.getElementById('filter-pixelLines');
  const label = document.getElementById('filter-pixelLines-val');
  const before = { value: slider?.value, label: label?.textContent, uniform: game.vhs.uniforms.uPixelLines.value };
  game.setFilterEnabled(false);
  const off = { uniform: game.vhs.uniforms.uPixelLines.value, stored: game.admin.ps2Filter.pixelLines };
  game.setFilterEnabled(true);
  return { before, off, on: game.vhs.uniforms.uPixelLines.value, saved: JSON.parse(localStorage.getItem('shutoko-nights.runtime.v2')).admin.ps2Filter };
});
check('a preset drives the sliders, the labels and the shader',
  wiring.before.value === '240' && wiring.before.label === '240 righe' && wiring.before.uniform === 240,
  JSON.stringify(wiring.before));
check('the master switch zeroes the shader but keeps the dials',
  wiring.off.uniform === 0 && wiring.off.stored === 240 && wiring.on === 240,
  JSON.stringify(wiring.off));
check('the settings reach the save file',
  wiring.saved?.pixelLines === 240 && wiring.saved?.enabled === true, JSON.stringify(wiring.saved));

await page.evaluate(() => {
  window.shutoko.applyFilterPreset('ps2');
  window.shutoko.setFilterEnabled(true);
  window.shutoko.changeSetting('vhs', true);
});
await page.waitForTimeout(900);
await page.screenshot({ path: join(SHOTS, 'ps2-filter-ps2-preset.png') });
const combined = await grabFrame();
check('the PS2 preset and the VHS pass coexist without going black',
  combined.mean > 2 && combined.max > 40, `mean ${combined.mean.toFixed(1)} max ${combined.max.toFixed(0)}`);

check('no console errors during the run', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
await writeFile(join(SHOTS, 'ps2-filter-probe.json'), JSON.stringify(results.map(({ pixels, ...rest }) => rest), null, 2));
const failed = results.filter((entry) => !entry.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed · shots in .devtests/shots/`);
process.exit(failed.length ? 1 : 0);
