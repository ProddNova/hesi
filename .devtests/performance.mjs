/**
 * Repeatable map/render performance foundation.
 *
 * Measures three pure-node map builds plus one mobile-viewport browser run.
 * Optional: --root=/path/to/checkout (measure another checkout/commit).
 * Run: node .devtests/performance.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const HARNESS_ROOT = fileURLToPath(new URL('..', import.meta.url));
const rootArg = process.argv.find((arg) => arg.startsWith('--root='))?.slice('--root='.length);
const ROOT = rootArg ? (isAbsolute(rootArg) ? rootArg : resolve(rootArg)) : HARNESS_ROOT;
const THREE_MODULE = join(HARNESS_ROOT, 'node_modules', 'three', 'build', 'three.module.js');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

const mapModuleUrl = `${pathToFileURL(join(ROOT, 'js', 'map.js')).href}?performance=${Date.now()}`;
const { HighwayMap } = await import(mapModuleUrl);
const buildTimes = [];
let scene = null;
for (let run = 0; run < 3; run += 1) {
  const started = performance.now();
  const map = new HighwayMap(null, {});
  buildTimes.push(performance.now() - started);
  if (run === 0) {
    let triangles = 0;
    let meshes = 0;
    const geometries = new Set();
    map.group.traverse((object) => {
      if (!object.isMesh || !object.geometry) return;
      meshes += 1;
      geometries.add(object.geometry);
      const index = object.geometry.getIndex();
      const positions = object.geometry.getAttribute('position');
      triangles += index ? index.count / 3 : (positions?.count || 0) / 3;
    });
    let storedTriangles = 0;
    for (const geometry of geometries) {
      const index = geometry.getIndex();
      const positions = geometry.getAttribute('position');
      storedTriangles += index ? index.count / 3 : (positions?.count || 0) / 3;
    }
    scene = {
      triangles: Math.round(triangles),
      storedTriangles: Math.round(storedTriangles),
      meshes,
      geometries: geometries.size,
    };
  }
  map.dispose();
}
const sortedBuilds = [...buildTimes].sort((a, b) => a - b);

const server = createServer(async (request, response) => {
  try {
    const urlPath = request.url.split('?')[0];
    const file = urlPath === '/' ? '/index.html' : urlPath;
    const body = await readFile(join(ROOT, file));
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
});
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const url = new URL(route.request().url());
  const addonMarker = '/examples/jsm/';
  const addonIndex = url.pathname.indexOf(addonMarker);
  const file = addonIndex >= 0
    ? join(HARNESS_ROOT, 'node_modules', 'three', 'examples', 'jsm',
      decodeURIComponent(url.pathname.slice(addonIndex + addonMarker.length)))
    : THREE_MODULE;
  const body = await readFile(file);
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
const errors = [];
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
page.on('pageerror', (error) => errors.push(String(error)));
page.on('dialog', (dialog) => dialog.accept());

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 120000 });
const bootToMapMs = await page.evaluate(() => performance.now());
const browserMapBuildMs = await page.evaluate(() => window.shutoko.performanceMetrics?.mapBuildMs ?? null);
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 10000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 10000 });
await page.evaluate(() => {
  const game = window.shutoko;
  // Match the established landmarks.mjs checkpoint scene so the historical
  // 167-call / 43.9k-triangle result remains directly comparable.
  const route = game.map.getRoute('k1');
  const lane = game.map.sampleLane(route.id, route.length * 0.5, 0, 1);
  game.physics.setPosition(lane.position.x, lane.position.y + 0.6, lane.position.z, lane.heading);
  game.physics.setSpeed(0);
  game.map.update(lane.position, performance.now() / 1000);
  game.snapDrivingCamera();
});
await page.waitForTimeout(2500);

const frameTiming = await page.evaluate(() => new Promise((resolveFrames) => {
  const deltas = [];
  let previous = null;
  const sample = (now) => {
    if (previous !== null) deltas.push(now - previous);
    previous = now;
    if (deltas.length >= 90) resolveFrames(deltas);
    else requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}));
frameTiming.sort((a, b) => a - b);
const percentile = (fraction) => frameTiming[Math.min(frameTiming.length - 1, Math.floor(frameTiming.length * fraction))];
const browserMetrics = await page.evaluate(() => {
  const game = window.shutoko;
  const info = game.renderer.info;
  const canvas = document.getElementById('game-canvas');
  return {
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    visibleChunks: [...game.map._chunks.values()].filter((chunk) => chunk.group.visible).length,
    totalChunks: game.map._chunks.size,
    activeTraffic: game.traffic?.activeCount ?? 0,
    quality: game.renderQuality(),
    internalResolution: `${canvas.width}x${canvas.height}`,
  };
});

await browser.close();
server.close();

const result = {
  targetRoot: ROOT,
  viewport: { width: 844, height: 390, deviceScaleFactor: 2, mobile: true },
  nodeMapBuildMs: {
    runs: buildTimes.map((value) => Number(value.toFixed(1))),
    median: Number(sortedBuilds[1].toFixed(1)),
  },
  browserMapBuildMs: browserMapBuildMs === null ? null : Number(browserMapBuildMs.toFixed(1)),
  bootToMapMs: Number(bootToMapMs.toFixed(1)),
  scene,
  renderer: browserMetrics,
  frameTimingMs: {
    samples: frameTiming.length,
    mean: Number((frameTiming.reduce((sum, value) => sum + value, 0) / frameTiming.length).toFixed(2)),
    p50: Number(percentile(0.5).toFixed(2)),
    p95: Number(percentile(0.95).toFixed(2)),
  },
  errors,
};
console.log(JSON.stringify(result, null, 2));
const regressions = [];
if (errors.length) regressions.push(`${errors.length} browser error(s)`);
if (result.renderer.drawCalls > 170) regressions.push(`${result.renderer.drawCalls} draw calls (limit 170)`);
if (result.renderer.triangles > 70000) regressions.push(`${result.renderer.triangles} visible triangles (limit 70000)`);
if (result.scene.storedTriangles > 2000000) regressions.push(`${result.scene.storedTriangles} stored triangles (limit 2000000)`);
if (result.nodeMapBuildMs.median > 4000) regressions.push(`${result.nodeMapBuildMs.median} ms map build (limit 4000)`);
if (result.frameTimingMs.p95 > 150) regressions.push(`${result.frameTimingMs.p95} ms frame p95 (limit 150)`);
if (regressions.length) {
  console.error(`PERFORMANCE REGRESSION: ${regressions.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log('PASS performance regression limits');
}
