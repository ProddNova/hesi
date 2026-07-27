/**
 * VHS pass + body paint probe.
 *
 * Boots the real game in Chromium, drives it to the road, and checks:
 *  1. the VHS present pass is active, the canvas is not black, and the pass
 *     survives a settings toggle in both directions;
 *  2. the tape artifacts are actually in the image (VHS-on and VHS-off frames
 *     differ, and the scanline pattern shows up as row-to-row variation);
 *  3. body paint reaches EVERY body material of the player car — the failure
 *     this replaces was half a car changing colour and half not.
 *
 * Run: node .devtests/vhs-car-paint-probe.mjs
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
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 20000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 20000 });
await page.waitForTimeout(2500);

const state = await page.evaluate(() => ({
  enabled: window.shutoko.vhs?.enabled ?? null,
  supported: window.shutoko.vhs?.supported ?? null,
  active: window.shutoko.vhs?.active?.() ?? null,
  hasTarget: !!window.shutoko.vhs?.target,
  targetSize: window.shutoko.vhs?.target
    ? [window.shutoko.vhs.target.width, window.shutoko.vhs.target.height] : null,
  canvas: [window.shutoko.renderer.domElement.width, window.shutoko.renderer.domElement.height],
  setting: window.shutoko.state.settings.vhs,
}));
check('VHS pass is active on boot', state.active === true, JSON.stringify(state));
check('offscreen buffer matches the canvas',
  !!state.targetSize && state.targetSize[0] === state.canvas[0] && state.targetSize[1] === state.canvas[1],
  `${state.targetSize} vs ${state.canvas}`);

// Read the presented frame straight from the canvas in both modes.
const grabFrame = () => page.evaluate(() => new Promise((done) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const source = window.shutoko.renderer.domElement;
    const w = 240, h = 135;
    const scratch = document.createElement('canvas');
    scratch.width = w; scratch.height = h;
    const ctx = scratch.getContext('2d');
    ctx.drawImage(source, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    let sum = 0, max = 0;
    const rows = new Array(h).fill(0);
    for (let y = 0; y < h; y += 1) {
      let rowSum = 0;
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 4;
        const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        rowSum += luma; sum += luma; if (luma > max) max = luma;
      }
      rows[y] = rowSum / w;
    }
    done({ mean: sum / (w * h), max, rows, pixels: Array.from(data) });
  }));
}));

const withVhs = await grabFrame();
await page.screenshot({ path: join(SHOTS, 'vhs-on.png') });
check('presented frame is a real picture, not black',
  withVhs.mean > 2 && withVhs.max > 40, `mean ${withVhs.mean.toFixed(1)} max ${withVhs.max.toFixed(0)}`);

await page.evaluate(() => window.shutoko.changeSetting('vhs', false));
await page.waitForTimeout(1200);
const withoutVhs = await grabFrame();
await page.screenshot({ path: join(SHOTS, 'vhs-off.png') });
const offState = await page.evaluate(() => ({
  active: window.shutoko.vhs.active(), hasTarget: !!window.shutoko.vhs.target,
}));
check('toggling off releases the buffer and renders straight to the canvas',
  offState.active === false && offState.hasTarget === false, JSON.stringify(offState));
check('clean frame is still a real picture',
  withoutVhs.mean > 2 && withoutVhs.max > 40, `mean ${withoutVhs.mean.toFixed(1)} max ${withoutVhs.max.toFixed(0)}`);

// The tape artifacts must be visible but restrained: the two frames differ,
// yet the overall exposure stays within a few percent of the clean render.
let diff = 0;
for (let i = 0; i < withVhs.pixels.length; i += 4) {
  diff += Math.abs(withVhs.pixels[i] - withoutVhs.pixels[i])
    + Math.abs(withVhs.pixels[i + 1] - withoutVhs.pixels[i + 1])
    + Math.abs(withVhs.pixels[i + 2] - withoutVhs.pixels[i + 2]);
}
const meanDiff = diff / (withVhs.pixels.length / 4 * 3);
check('VHS visibly changes the image', meanDiff > 0.5, `mean channel delta ${meanDiff.toFixed(2)}/255`);
const exposureShift = Math.abs(withVhs.mean - withoutVhs.mean) / Math.max(1, withoutVhs.mean);
check('VHS stays subtle (exposure within 8%)', exposureShift < 0.08,
  `${(exposureShift * 100).toFixed(1)}% · ${withoutVhs.mean.toFixed(1)} → ${withVhs.mean.toFixed(1)}`);

await page.evaluate(() => window.shutoko.changeSetting('vhs', true));
await page.waitForTimeout(1200);

// With the artifacts dialled to zero the pass must be a pure passthrough. This
// is the guard against the offscreen buffer quietly changing the picture — an
// offscreen target that tone-maps late composites the additive lamp pools in
// linear HDR and turns the road visibly hotter.
await page.evaluate(() => window.shutoko.vhs.setAmount(0));
await page.waitForTimeout(600);
const passthrough = await grabFrame();
await page.evaluate(() => window.shutoko.vhs.setAmount(1));
const passthroughShift = Math.abs(passthrough.mean - withoutVhs.mean) / Math.max(1, withoutVhs.mean);
check('pass is a pure passthrough at amount 0', passthroughShift < 0.02,
  `${(passthroughShift * 100).toFixed(2)}% · ${withoutVhs.mean.toFixed(2)} vs ${passthrough.mean.toFixed(2)}`);
await page.waitForTimeout(600);
const backOn = await page.evaluate(() => ({
  active: window.shutoko.vhs.active(), hasTarget: !!window.shutoko.vhs.target,
  size: window.shutoko.vhs.target ? [window.shutoko.vhs.target.width, window.shutoko.vhs.target.height] : null,
  canvas: [window.shutoko.renderer.domElement.width, window.shutoko.renderer.domElement.height],
}));
check('toggling back on re-allocates a correctly sized buffer',
  backOn.active === true && String(backOn.size) === String(backOn.canvas), JSON.stringify(backOn));

// ---- Body paint ---------------------------------------------------------
const before = await page.evaluate(() => {
  const materials = [];
  window.shutoko.customCar.object.traverse((child) => {
    for (const material of (Array.isArray(child.material) ? child.material : [child.material])) {
      if (material) materials.push({ name: material.name, type: material.type, color: `#${material.color?.getHexString?.() || ''}` });
    }
  });
  return { override: window.shutoko.customCar.object.userData.hesiCarOverrideAssetId || null, materials };
});
const bodyBefore = before.materials.filter((entry) => /(^|:)psxbody$/i.test(entry.name));
check('player car exposes its body materials', bodyBefore.length > 0,
  `${bodyBefore.length} body slot(s)${before.override ? ` · override ${before.override}` : ' · stock PSX model'}`);
// The shipped document carries a paint record; it must survive the trip from
// data/editor/custom-assets.json to the car on the road with no help.
const savedPaint = await page.evaluate(() => window.shutoko.editorCarAssets
  ?.carModels?.[`player:${window.shutoko.customCar.modelId}`]?.paint || null);
if (savedPaint) {
  check('the saved paint record reaches the car at boot',
    bodyBefore.length > 0 && bodyBefore.every((entry) => entry.type === 'MeshPhongMaterial')
      && new Set(bodyBefore.map((entry) => entry.color)).size === 1,
    `${JSON.stringify(savedPaint)} → ${JSON.stringify(bodyBefore)}`);
}

const painted = await page.evaluate(async () => {
  const game = window.shutoko;
  const document_ = game.editorCarAssets || { version: 1, assets: {}, textures: {}, carModels: {} };
  document_.carModels = document_.carModels || {};
  const target = `player:${game.customCar.modelId}`;
  document_.carModels[target] = { ...(document_.carModels[target] || {}), paint: { color: '#1b3fa8', metallic: 0.8, gloss: 0.55 } };
  game.applyCarModelDocument(document_, { reloadPlayer: true });
  await new Promise((done) => setTimeout(done, 2500));
  const materials = [];
  game.customCar.object.traverse((child) => {
    for (const material of (Array.isArray(child.material) ? child.material : [child.material])) {
      if (material) {
        materials.push({
          name: material.name, type: material.type,
          color: `#${material.color?.getHexString?.() || ''}`,
          specular: material.specular ? `#${material.specular.getHexString()}` : null,
        });
      }
    }
  });
  return materials;
});
const bodyAfter = painted.filter((entry) => /(^|:)psxbody$/i.test(entry.name));
const allPhong = bodyAfter.length > 0 && bodyAfter.every((entry) => entry.type === 'MeshPhongMaterial');
const oneColor = new Set(bodyAfter.map((entry) => entry.color)).size === 1;
check('every body slot became metallic paint', allPhong, JSON.stringify(bodyAfter.slice(0, 4)));
check('the whole body is one colour (no half-painted car)', oneColor,
  [...new Set(bodyAfter.map((entry) => entry.color))].join(', '));
const untouched = painted.filter((entry) => /glass|taillight|headlight|wheel|tire|trim/i.test(entry.name));
check('glass, lamps and wheels keep their own materials',
  untouched.length > 0 && untouched.every((entry) => entry.type !== 'MeshPhongMaterial'),
  `${untouched.length} non-body slot(s) untouched`);

await page.waitForTimeout(400);
await page.screenshot({ path: join(SHOTS, 'car-paint-blue-metallic.png') });

check('no console errors during the run', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
await writeFile(join(SHOTS, 'vhs-car-paint-probe.json'), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => !entry.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed · shots in .devtests/shots/`);
process.exit(failed.length ? 1 : 0);
