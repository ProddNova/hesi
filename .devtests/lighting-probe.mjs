/**
 * Screenshots the night lighting (lamp pools + traffic) from the driver view
 * so lighting changes can be compared before/after.
 * Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node .devtests/lighting-probe.mjs [tag]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = process.argv[2] || 'before';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const context = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1.5, hasTouch: true });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const url = new URL(route.request().url());
  const addonMarker = '/examples/jsm/';
  const addonIndex = url.pathname.indexOf(addonMarker);
  const file = addonIndex >= 0
    ? join(ROOT, 'node_modules/three/examples/jsm', decodeURIComponent(url.pathname.slice(addonIndex + addonMarker.length)))
    : join(ROOT, 'node_modules/three/build/three.module.js');
  const body = await readFile(file);
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
await page.goto(`http://127.0.0.1:${port}/`);
// The complete authored world can take over 30 s to construct under software
// rasterization on Windows; this probe measures lighting, not boot speed.
const bootTimeout = Number(process.env.PROBE_BOOT_TIMEOUT || 120000);
try {
  await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: bootTimeout });
} catch (error) {
  console.error('boot errors:', errors.length ? errors.slice(0, 8) : 'none captured');
  throw error;
}
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });

const spots = [
  { name: 'wangan-straight', route: 'wangan', frac: 0.2 },
  { name: 'tatsumi-underdeck', route: 'wangan_0', frac: 0.0303 },
  { name: 'k1-industrial', route: 'k1', frac: 0.5 },
  { name: 'c1-curve', route: 'c1', frac: 0.62 },
];

// let traffic populate
await page.evaluate(() => window.shutoko.traffic?.setDensity(2));
for (const spot of spots) {
  await page.evaluate((s) => {
    const g = window.shutoko;
    const route = g.map.getRoute(s.route);
    const d = route.length * s.frac;
    const lane = g.map.sampleLane(s.route, d, 0, 1);
    g.physics.setPosition(lane.position.x, lane.position.y + 0.6, lane.position.z, lane.heading);
    g.physics.setSpeed(0);
    g.snapDrivingCamera();
  }, spot);
  await page.waitForTimeout(2600);
  await page.screenshot({ path: join(OUT, `light-${TAG}-${spot.name}.png`) });
  if (spot.name === 'tatsumi-underdeck') {
    await page.evaluate(() => {
      window.shutoko.headlightsOn = false;
      window.shutoko._applyHeadlightState();
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, `light-${TAG}-${spot.name}-headlights-off.png`) });
    await page.evaluate(() => {
      window.shutoko.headlightsOn = true;
      window.shutoko._applyHeadlightState();
    });
  }
}
const metrics = await page.evaluate(() => {
  const game = window.shutoko;
  const lights = { point: 0, spot: 0, directional: 0, hemisphere: 0, ambient: 0 };
  game.roadScene.traverse((object) => {
    if (object.isPointLight) lights.point += 1;
    else if (object.isSpotLight) lights.spot += 1;
    else if (object.isDirectionalLight) lights.directional += 1;
    else if (object.isHemisphereLight) lights.hemisphere += 1;
    else if (object.isAmbientLight) lights.ambient += 1;
  });
  return {
    lights,
    calls: game.renderer.info.render.calls,
    triangles: game.renderer.info.render.triangles,
    programs: game.renderer.info.programs.length,
    underdeckPools: game.map._tatsumiUnderdeckPools?.count || 0,
  };
});
console.log('lighting metrics:', metrics);
console.log('page errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
server.close();
