/**
 * Screenshots the bay-facing horizon so the skybox panorama (city + its
 * reflection on the water) can be compared against the land slabs that sit
 * in front of it.
 * Run: node .devtests/skybox-horizon-probe.mjs [tag]
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
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary' };

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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1.5, hasTouch: true });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 15000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 10000 });

const stats = await page.evaluate(() => {
  const map = window.shutoko.map;
  const out = { slabs: [], water: null, skybox: null, fog: null };
  window.shutoko.roadScene.traverse((o) => {
    if (o.name === 'Tokyo Bay') out.water = { name: o.name, y: o.position.y, visible: o.visible };
    if (o.userData?.skybox) out.skybox = { visible: o.visible, scale: o.scale.x };
  });
  out.fog = window.shutoko.roadScene.fog ? { color: window.shutoko.roadScene.fog.color.getHexString(), density: window.shutoko.roadScene.fog.density } : null;
  const names = new Set((map._terrainSlabs || []).map((s) => s.name));
  window.shutoko.roadScene.traverse((o) => {
    if (!names.has(o.name) || !o.geometry) return;
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox;
    out.slabs.push({
      name: o.name,
      tris: (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3,
      verts: o.geometry.attributes.position.count,
      visible: o.visible,
      spanX: Math.round(b.max.x - b.min.x),
      spanZ: Math.round(b.max.z - b.min.z),
    });
  });
  out.waterVisible = out.water ? undefined : null;
  const cam = window.shutoko.camera || window.shutoko.drivingCamera;
  out.camera = cam ? { far: cam.far, near: cam.near, fov: cam.fov } : null;
  return out;
});
console.log(JSON.stringify(stats, null, 1).slice(0, 3000));

// Viewpoints that should look out over open water toward the panorama.
const spots = [
  { name: 'rainbow-bridge', route: 'r11', frac: 0.36 },
  { name: 'wangan-bay', route: 'wangan', frac: 0.30 },
  { name: 'daikoku', route: 'wangan', frac: 0.86 },
  { name: 'c1-city', route: 'c1', frac: 0.5 },
  { name: 'k1-industrial', route: 'k1', frac: 0.5 },
];

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
  await page.waitForTimeout(2200);
  await page.screenshot({ path: join(OUT, `skyhorizon-${TAG}-${spot.name}.png`) });
}
console.log('page errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
server.close();
