/**
 * Boots the real game in headless Chromium, forces traffic to spawn, and
 * verifies: only 3 classes render with sane dimensions, tir skew outward, the
 * dev-panel sliders exist and drive the live TrafficSystem. Screenshots the
 * road + the open debug panel.
 *
 * Run from repo root:  node .devtests/traffic-visual-probe.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('nope');
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

// Match .devtests/e2e.mjs: honour CHROMIUM_PATH, else use Playwright's default
// bundled browser (set CHROMIUM_PATH if the bundled build is missing).
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const url = new URL(route.request().url());
  const rel = url.pathname.replace(/^\/npm\/three@[^/]+\//, '');
  try {
    const body = await readFile(join(ROOT, 'node_modules/three', rel));
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  } catch { await route.fulfill({ status: 404, body: 'nope' }); }
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map && !!window.shutoko.traffic, null, { timeout: 30000 });
check('boots with a traffic system', true);

// Into driving.
await page.tap('#new-game-button').catch(() => page.click('#new-game-button'));
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 8000 });
// Put the car out on the Wangan mainline (not the spawn PA) so spawned traffic
// is in shot, then run a burst so the pool fills around the visible car.
await page.evaluate(() => window.shutoko.teleportToRoutePoint({ routeId: 'wangan', distance: 6000, lane: 1, direction: 1 }));
await page.waitForTimeout(200);
await page.evaluate(() => {
  const g = window.shutoko;
  for (let i = 0; i < 900; i += 1) {
    const s = g.getVehicleState();
    const road = g.map.getRoadInfo(s.position);
    g.traffic.update(1 / 60, g.getVehicleState(), { roadInfo: road });
  }
  g.renderRoad?.() ?? g.render?.();
});

const info = await page.evaluate(() => {
  const active = window.shutoko.traffic.getActiveVehicles();
  const byType = {};
  let visible = 0;
  for (const v of active) {
    byType[v.type.id] = (byType[v.type.id] || 0) + 1;
    if (v.mesh.visible) visible += 1;
  }
  const ids = new Set(active.map((v) => v.type.id));
  const dims = {};
  for (const v of active) if (!dims[v.type.id]) dims[v.type.id] = { w: +v.width.toFixed(2), l: +v.length.toFixed(2), h: +v.height.toFixed(2) };
  return { count: active.length, visible, byType, typeIds: [...ids], dims };
});
console.log('active traffic:', JSON.stringify(info, null, 1));
check('traffic spawned and is visible', info.count > 10 && info.visible === info.count, `count ${info.count}`);
check('only the 3 designed classes exist', info.typeIds.every((id) => ['car', 'van', 'truck'].includes(id)), info.typeIds.join(','));
check('dimensions are sane (tir long & tall, car small)',
  (!info.dims.truck || (info.dims.truck.l > 12 && info.dims.truck.h > 3)) && (!info.dims.car || (info.dims.car.l < 5 && info.dims.car.h < 1.8)),
  JSON.stringify(info.dims));
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, 'traffic-road.png') });

// Close inspection: teleport just behind a spawned tir (or the biggest thing
// available) for a beauty shot that shows the box silhouettes.
for (const wanted of ['truck', 'van', 'car']) {
  const target = await page.evaluate((id) => {
    const g = window.shutoko;
    const v = g.traffic.getActiveVehicles().find((x) => x.type.id === id && Number.isFinite(x.s) && x.laneRef?.routeId);
    return v ? { routeId: v.laneRef.routeId, s: v.s, lane: v.laneRef.laneIndex, direction: v.laneRef.direction, id } : null;
  }, wanted);
  if (!target) continue;
  await page.evaluate((t) => window.shutoko.teleportToRoutePoint({ routeId: t.routeId, distance: t.s - (t.id === 'truck' ? 26 : 16), lane: t.lane, direction: t.direction }), target);
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(OUT, `traffic-closeup-${wanted}.png`) });
  console.log('closeup captured:', wanted);
}

// Lane bias needs a moving player and a large sample (a static snapshot of a
// handful of tir is pure noise). Walk a fake player down the road and tally
// lane index per class over time — this mirrors real driving.
const laneAvg = await page.evaluate(() => {
  const g = window.shutoko;
  const s0 = g.getVehicleState();
  let pos = { x: s0.position.x, y: s0.position.y, z: s0.position.z };
  let heading = s0.heading || 0;
  const laneByType = { car: [], van: [], truck: [] };
  for (let i = 0; i < 2500; i += 1) {
    pos = { x: pos.x + Math.sin(heading) * (32 / 60), y: pos.y, z: pos.z + Math.cos(heading) * (32 / 60) };
    const road = g.map.getRoadInfo(pos);
    if (road && road.center) { pos = { x: road.center.x, y: road.center.y, z: road.center.z }; heading = road.heading ?? heading; }
    const player = { position: pos, velocity: { x: Math.sin(heading) * 32, y: 0, z: Math.cos(heading) * 32 }, heading, speed: 32, width: 1.8, length: 4.4, height: 1.3 };
    g.traffic.update(1 / 60, player, { roadInfo: road });
    if (i % 20 === 0) for (const v of g.traffic.getActiveVehicles()) if (Number.isFinite(v.laneRef?.laneIndex)) laneByType[v.type.id]?.push(v.laneRef.laneIndex);
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return { car: avg(laneByType.car), van: avg(laneByType.van), truck: avg(laneByType.truck), nCar: laneByType.car.length, nTruck: laneByType.truck.length };
});
console.log('lane averages (moving player):', JSON.stringify(laneAvg));
check('tir sit further out (higher lane index) than cars', laneAvg.truck != null && laneAvg.car != null && laneAvg.truck > laneAvg.car,
  `car ${laneAvg.car?.toFixed(2)} vs tir ${laneAvg.truck?.toFixed(2)} (n=${laneAvg.nTruck})`);

// --- Dev panel sliders ---
await page.evaluate(() => window.shutoko.toggleDebugMenu(true));
await page.waitForTimeout(150);
const panel = await page.evaluate(() => ({
  intensity: !!document.getElementById('debug-traffic-intensity'),
  truck: !!document.getElementById('debug-traffic-truck'),
  van: !!document.getElementById('debug-traffic-van'),
  lanechange: !!document.getElementById('debug-traffic-lanechange'),
  speed: !!document.getElementById('debug-traffic-speed'),
}));
check('all 5 traffic sliders exist in dev panel', Object.values(panel).every(Boolean), JSON.stringify(panel));
// Open the <details> so the sliders are visible for the screenshot.
await page.evaluate(() => { const d = document.querySelector('.debug-traffic-panel'); if (d) d.open = true; });
await page.waitForTimeout(100);
await page.screenshot({ path: join(OUT, 'traffic-devpanel.png') });

// Drive the truck slider to 30% and the intensity to 2.0, assert the live system reacts.
const reaction = await page.evaluate(() => {
  const drive = (id, value) => {
    const el = document.getElementById(id);
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  drive('debug-traffic-truck', 30);
  drive('debug-traffic-intensity', 2.0);
  drive('debug-traffic-lanechange', 0);
  drive('debug-traffic-speed', 130);
  const g = window.shutoko;
  return {
    truckWeight: g.traffic.typeWeights.truck,
    truckRatio: g.admin.trafficTruckRatio,
    density: g.traffic.density,
    laneChangeRate: g.traffic.laneChangeRate,
    speedFactor: g.traffic.speedFactor,
  };
});
console.log('slider reaction:', JSON.stringify(reaction));
check('truck slider updates class mix', Math.abs(reaction.truckWeight - 0.3) < 0.01 && Math.abs(reaction.truckRatio - 0.3) < 0.01);
check('intensity slider updates density', Math.abs(reaction.density - 2.0) < 0.01);
check('lane-change slider can disable lane changes (0)', reaction.laneChangeRate === 0);
check('speed slider scales flow (1.3x)', Math.abs(reaction.speedFactor - 1.3) < 0.01);

// Persistence round-trip: value survives reload.
await page.evaluate(() => window.shutoko.persist());
await page.reload();
await page.waitForFunction(() => window.shutoko && !!window.shutoko.traffic, null, { timeout: 30000 });
const persisted = await page.evaluate(() => ({ ratio: window.shutoko.admin.trafficTruckRatio, weight: window.shutoko.traffic.typeWeights.truck }));
check('slider settings persist across reload', Math.abs(persisted.ratio - 0.3) < 0.01 && Math.abs(persisted.weight - 0.3) < 0.01, JSON.stringify(persisted));

check('no console errors during whole probe', errors.length === 0, errors.slice(0, 4).join(' | '));

await browser.close();
server.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
