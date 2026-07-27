/**
 * Deterministic shots of the holographic interaction points (js/hologram-marker.js):
 *  1. HOLO-garage  — the exit disc inside the workshop.
 *  2. HOLO-pa-gate — the car-scale disc on the Tatsumi PA gate forecourt.
 *  3. HOLO-pa-lot  — the exit disc inside the PA lot.
 *
 * Every camera is derived from the marker's own world position, so before/after
 * runs frame the same spot.
 *
 * Run: node .devtests/hologram-marker-shots.mjs  -> .devtests/shots/HOLO-*.png
 *
 * NOTE the SPLIT cdn routing below: the game imports both `three` and
 * `three/addons/...`, so a blanket jsdelivr route kills the page.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/json' };

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(ROOT, decodeURIComponent(file)));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, hasTouch: true });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
await context.route('https://cdn.jsdelivr.net/**/examples/jsm/**', async (route) => {
  const rest = route.request().url().split('/examples/jsm/')[1];
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(ROOT, 'node_modules/three/examples/jsm', rest)) });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 15000 });
await page.waitForTimeout(1500);

// 1. Garage: look at the exit disc from inside the room.
// The walk camera's forward is (-sin yaw, 0, -cos yaw): yaw = PI looks toward +z.
const garage = await page.evaluate(() => {
  const g = window.shutoko, gs = g.garage;
  const p = gs.exitMarkers.position;
  gs.position.set(p.x, gs.playerHeight, p.z - 5.5);
  gs.yaw = Math.PI; gs.pitch = -0.22;
  const core = gs.exitMarkers.userData.core;
  return { anchor: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)], discBase: +(p.y + core.position.y - core.scale.y / 2).toFixed(3), visible: gs.exitMarkers.visible };
});
await page.waitForTimeout(700);
await page.screenshot({ path: join(OUT, 'HOLO-garage.png') });
console.log('garage exit marker', JSON.stringify(garage));

// 2. Drive out and park on the PA gate forecourt.
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 10000 });
const gate = await page.evaluate(() => {
  const g = window.shutoko;
  const e = g.map.zoneEntrances[0];
  const t = e.tangent;
  // Both tangent directions are plausible; park on the side the marker's own
  // chunk is on and face the marker, so the shot always frames it.
  const heading = Math.atan2(t.x, t.z);
  const place = (sign) => {
    const h = sign > 0 ? heading : heading + Math.PI;
    g.placeVehicle({ x: e.position.x - Math.sin(h) * 12, y: e.position.y, z: e.position.z - Math.cos(h) * 12 }, h);
    g.snapDrivingCamera();
    const c = g.camera;
    const to = { x: e.position.x - c.position.x, z: e.position.z - c.position.z };
    const f = { x: Math.sin(h), z: Math.cos(h) };
    return (to.x * f.x + to.z * f.z) / Math.hypot(to.x, to.z);
  };
  const forward = place(1);
  if (forward < 0.9) place(-1);
  return { entrance: [+e.position.x.toFixed(1), +e.position.y.toFixed(1), +e.position.z.toFixed(1)], forward: +forward.toFixed(2) };
});
await page.waitForTimeout(1200);
await page.screenshot({ path: join(OUT, 'HOLO-pa-gate.png') });
console.log('pa gate', JSON.stringify(gate));
// 2b. Same marker from the drone, 9 m out and slightly above — proves the disc
// itself renders even when the gate wall hides it from the running lanes.
await page.evaluate(() => {
  const g = window.shutoko;
  const e = g.map.zoneEntrances[0];
  g.setNoclip(true);
  // Straight above and slightly off: the bay is walled on three sides, so any
  // ground-level angle risks putting concrete between the lens and the disc.
  const t = e.tangent, back = Math.atan2(t.x, t.z);
  g.debug.position.set(e.position.x - Math.sin(back) * 6, e.position.y + 6, e.position.z - Math.cos(back) * 6);
  g.debug.yaw = back;
  g.debug.pitch = -0.72;
});
await page.waitForTimeout(900);
await page.screenshot({ path: join(OUT, 'HOLO-pa-gate-drone.png') });
await page.screenshot({ path: join(OUT, 'HOLO-pa-gate-drone-crop.png'), clip: { x: 490, y: 260, width: 300, height: 200 } });
console.log('marker', JSON.stringify(await page.evaluate(() => {
  const g = window.shutoko;
  let found = null;
  g.map.group.traverse((o) => { if (o.name === 'Tatsumi PA entrance marker') found = o; });
  if (!found) return { found: false };
  const chain = []; let n = found;
  while (n) { chain.push(`${n.name || n.type}:${n.visible}`); n = n.parent; }
  const p = found.getWorldPosition(new (found.position.constructor)());
  return {
    found: true, chain,
    world: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)],
    camera: [+g.camera.position.x.toFixed(1), +g.camera.position.y.toFixed(1), +g.camera.position.z.toFixed(1)],
    distance: +g.camera.position.distanceTo(p).toFixed(1),
    suppressed: !!found.userData.tatsumiClearingSuppressed,
    core: (() => {
      const c = found.userData.core;
      const s = c.getWorldScale(new (found.position.constructor)());
      const cp = c.getWorldPosition(new (found.position.constructor)());
      return { scale: [+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)], y: +cp.y.toFixed(2), children: c.children.map((m) => `${m.geometry.type}/${m.material.type}/op${m.material.opacity.toFixed(2)}/vis${m.visible}`) };
    })(),
    ndc: (() => {
      const v = found.userData.core.getWorldPosition(new (found.position.constructor)());
      v.project(g.camera);
      return [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(3)];
    })(),
  };
})));

// 3. Inside the PA lot (drone off first — noclip owns the camera while it is on).
await page.evaluate(() => { window.shutoko.setNoclip(false); window.shutoko.enterTatsumiPa(); });
await page.waitForFunction(() => window.shutoko.mode === 'pa', null, { timeout: 10000 });
await page.evaluate(() => {
  const pa = window.shutoko.tatsumiPa;
  const p = pa.exitMarkers.position;
  pa.position.set(p.x, pa.playerHeight, p.z - 6);
  pa.yaw = Math.PI; pa.pitch = -0.2;
});
await page.waitForTimeout(900);
await page.screenshot({ path: join(OUT, 'HOLO-pa-lot.png') });

console.log(errors.length ? `ERRORS: ${errors.slice(0, 5).join(' | ')}` : 'no page errors');
await browser.close(); server.close();
