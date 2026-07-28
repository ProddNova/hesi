/**
 * Road "confetti" — depth-precision hypothesis, RULED OUT.
 *
 * The specks only ever show inside the sodium light pools, so coplanar layers
 * were a suspect: the lane markings sit 0.055 m above the deck and the
 * additive pool quads ride on polygonOffset, both far below what a
 * low-precision depth buffer resolves at 50-300 m.
 *
 * This probe degrades depth precision on the desktop path by dropping the near
 * plane (the resolvable step at range scales with z^2 / near) and shoots the
 * same lit stretch. At near = 0.01 — thirty times worse than shipped — the
 * road stays clean, so z-fighting is NOT the mechanism. Kept as the record of
 * that, and because it also prints the framebuffer's real depth/stencil/sample
 * counts and the road's live anisotropy and mip bias.
 *
 * Run: node .devtests/confetti-depth-probe.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const url = new URL(route.request().url());
  const addon = url.pathname.match(/examples\/jsm\/(.+)$/);
  const file = addon ? `node_modules/three/examples/jsm/${addon[1]}` : 'node_modules/three/build/three.module.js';
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(ROOT, file)) });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => console.error('pageerror:', String(e)));
await page.goto(`http://127.0.0.1:${port}/${process.env.DIAG ? `?diag=${process.env.DIAG}` : ''}`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 120000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko?.mode === 'garage', null, { timeout: 20000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko?.mode === 'driving', null, { timeout: 20000 });
await page.waitForTimeout(3000);
await page.addStyleTag({ content: '#game-shell > :not(#game-canvas) { visibility: hidden !important; }' });

const depth = await page.evaluate(() => {
  const gl = window.shutoko.renderer.getContext();
  return {
    depthBits: gl.getParameter(gl.DEPTH_BITS),
    stencilBits: gl.getParameter(gl.STENCIL_BITS),
    antialias: gl.getContextAttributes().antialias,
    samples: gl.getParameter(gl.SAMPLES),
  };
});
console.log('default framebuffer:', JSON.stringify(depth));

// A lit straight with lamps overhead, camera low and looking far down the
// road — the geometry the report shows.
const biasReport = await page.evaluate(() => {
  const game = window.shutoko;
  const road = game.map.materials.road;
  const seen = [];
  game.roadScene.traverse((o) => {
    if (!o.material) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (m === road && m.map) seen.push(m.map.anisotropy);
    }
  });
  return {
    mipBias: game.map._surfaceMipBias.value,
    roadAnisotropy: [...new Set(seen)],
    maxAnisotropy: game.renderer.capabilities.getMaxAnisotropy(),
    canvas: game.canvas.width,
    cssPixels: Math.round(game.canvas.clientWidth * Math.min(window.devicePixelRatio || 1, 3)),
  };
});
console.log('mip bias:', JSON.stringify(biasReport));

// Does the mip bias actually move pixels? If forcing it to 4 renders the same
// image as 0, the shader injection is a no-op and the "fix" never reached the
// sampler at all.
{
  await page.evaluate(() => {
    const game = window.shutoko;
    const map = game.map;
    const route = map.getRoute('wangan_1');
    const lane = map.sampleLane(route.id, route.length * 0.35, 0, 1);
    if (game.debug.noclip) game.setNoclip(false);
    game.traffic?.setDensity?.(0);
    game.physics.setPosition(lane.position.x, lane.position.y + 0.6, lane.position.z, lane.heading);
    game.physics.setSpeed(0);
    map._visibleKey = null;
    map.update(lane.position, performance.now() / 1000);
    game.snapDrivingCamera();
    if (game.customCar?.object) game.customCar.object.visible = false;
  });
  await page.waitForTimeout(600);
  const shoot = async (bias) => {
    await page.evaluate((b) => { window.shutoko.map._surfaceMipBias.value = b; }, bias);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    return page.screenshot({ path: join(OUT, `confetti-bias-${bias}.png`) });
  };
  const flat = await shoot(0);
  const blurred = await shoot(4);
  console.log('MIP BIAS 0 vs 4 — identical image:', Buffer.compare(flat, blurred) === 0);
}

for (const near of [0.3, 0.05, 0.01]) {
  await page.evaluate((nearPlane) => {
    const game = window.shutoko;
    game.traffic?.setDensity?.(0);
    game.traffic?.vehicles?.forEach?.((vehicle) => { if (vehicle.mesh) vehicle.mesh.visible = false; });
    const map = game.map;
    const route = map.getRoute('wangan_1');
    const distance = route.length * 0.35;
    const lane = map.sampleLane(route.id, distance, 0, 1);
    if (game.debug.noclip) game.setNoclip(false);
    game.physics.setPosition(lane.position.x, lane.position.y + 0.6, lane.position.z, lane.heading);
    game.physics.setSpeed(0);
    map._visibleKey = null;
    map.update(lane.position, performance.now() / 1000);
    game.snapDrivingCamera();
    if (game.customCar?.object) game.customCar.object.visible = false;
    // Degrading the near plane is the same lever as losing depth bits: the
    // resolvable depth step at range scales with z^2 / near.
    game.camera.near = nearPlane;
    game.camera.updateProjectionMatrix();
    game._frozenNear = nearPlane;
  }, near);
  // applyRenderResolution() rewrites camera.far every resize; re-pin near on
  // each frame so the render loop cannot restore it before the screenshot.
  await page.evaluate(() => new Promise((resolve) => {
    let frames = 0;
    const pin = () => {
      window.shutoko.camera.near = window.shutoko._frozenNear;
      window.shutoko.camera.updateProjectionMatrix();
      frames += 1;
      if (frames > 30) resolve(); else requestAnimationFrame(pin);
    };
    requestAnimationFrame(pin);
  }));
  const name = `confetti-depth-near${String(near).replace('.', 'p')}.png`;
  await page.screenshot({ path: join(OUT, name) });
  console.log(`shot ${name}`);
}

await browser.close();
server.close();
