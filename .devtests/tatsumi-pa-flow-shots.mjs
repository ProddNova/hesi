/**
 * Deterministic screenshots for the refined Tatsumi PA (compact empty deck,
 * end-gate entry + exit onto ramp_8, left-hand traffic, denser dashes).
 * All cameras derive from the runtime service-area record and the fitted
 * centrelines, so before/after runs frame identical spots.
 *
 *  1. top-down          — plan view: the shortened deck between the ramps.
 *  2. spawn-chase       — the real chase camera right after exitGarage().
 *  3. entrance          — the entry lane: diverge, descent and end gate.
 *  4. exit              — the exit lane: end gate, descent and merge.
 *  5. side-elevation    — broadside: Wangan under the elevated deck.
 *  6. drive-entry       — chase camera mid-way down the entry transition.
 *  7. drive-exit        — chase camera mid-way down the exit transition.
 *  8. markings-chase    — wangan_0 dashes at chase distance (compare with
 *                         the `before` suffix from an older tree).
 *  9. traffic-directions— both Wangan carriageways with live traffic.
 *
 * Run: CHROMIUM_PATH=... node .devtests/tatsumi-pa-flow-shots.mjs [suffix] [--case=name]
 * Writes .devtests/shots/FLOW-<case>[-suffix].png
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const suffixArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const SUFFIX = suffixArg ? `-${suffixArg}` : '';
const onlyArg = process.argv.slice(2).find((arg) => arg.startsWith('--case='));
const ONLY = onlyArg ? onlyArg.slice(7) : null;
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (error) => console.error('pageerror:', String(error)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });

const shoot = async (name) => {
  await page.screenshot({ path: join(OUT, `FLOW-${name}${SUFFIX}.png`) });
  console.log(`shot FLOW-${name}${SUFFIX}.png`);
};
const want = (name) => !ONLY || ONLY === name;

// --- 2. the real chase camera right after leaving the garage -----------------
if (want('spawn-chase')) {
  await page.waitForTimeout(900);
  await shoot('spawn-chase');
}

// --- drive-throughs: the actual car rolling down each transition -------------
const driveShot = async (name, routeKey, fraction) => {
  await page.evaluate(({ key, f }) => {
    const g = window.shutoko;
    if (g.debug?.noclip) g.setNoclip(false);
    const map = g.map;
    const area = map.serviceAreas.find((a) => a.id === 'tatsumi_pa');
    const route = map.routes.get(key === 'entry' ? area.entryRouteId : area.exitRouteId);
    const s = route.length * f;
    const c = map._sampleCenter(route, s, 1);
    const heading = Math.atan2(c.tangent.x, c.tangent.z);
    g.physics.setPosition(c.position.x, c.position.y + 0.45, c.position.z, heading);
    g.physics.setSpeed?.(9);
  }, { key: routeKey, f: fraction });
  await page.waitForTimeout(900);
  await shoot(name);
};
if (want('drive-entry')) await driveShot('drive-entry', 'entry', 0.72);
if (want('drive-exit')) await driveShot('drive-exit', 'exit', 0.30);

// Hide traffic for the geometry shots.
await page.evaluate(() => {
  const g = window.shutoko;
  (g.traffic?.pool || []).forEach((v) => { if (v.mesh) v.mesh.visible = false; });
});

const place = async (setup, pitch) => {
  await page.evaluate(({ s, p }) => {
    const g = window.shutoko;
    if (!g.debug.noclip) g.setNoclip(true);
    g.debug.position.set(s.position.x, s.position.y, s.position.z);
    g.debug.yaw = s.yaw;
    g.debug.pitch = p;
  }, { s: setup, p: pitch });
  await page.waitForTimeout(900);
};

const deckCamera = async (spec) => page.evaluate((s) => {
  const map = window.shutoko.map;
  const area = (map.serviceAreas || []).find((candidate) => candidate.id === 'tatsumi_pa');
  if (!area) return { missing: 'tatsumi area' };
  const heading = Math.atan2(area.tangent.x, area.tangent.z);
  const position = area.center.clone()
    .addScaledVector(area.tangent, s.along || 0)
    .addScaledVector(area.normal, s.across || 0);
  position.y = area.elevation + (s.up || 0);
  const yaw = s.yawFrom === 'normal' ? Math.atan2(area.normal.x, area.normal.z)
    : s.yaw !== undefined ? heading + s.yaw
      : heading;
  return { position: { x: position.x, y: position.y, z: position.z }, yaw };
}, spec);

// --- 1. top-down ---------------------------------------------------------------
if (want('top-down')) {
  await place(await deckCamera({ up: 320 }), -1.55);
  await shoot('top-down');
}

// --- 3/4. entrance and exit transitions from a low 3/4 view ----------------------
const connectorCamera = async (routeKey, fraction, back, up) => page.evaluate((s) => {
  const map = window.shutoko.map;
  const area = map.serviceAreas.find((candidate) => candidate.id === 'tatsumi_pa');
  const route = map.routes.get(s.routeKey === 'entry' ? area.entryRouteId : area.exitRouteId);
  if (!route) return { missing: s.routeKey };
  const at = route.length * s.fraction;
  const c = map._sampleCenter(route, at, 1);
  const eye = c.position.clone().addScaledVector(c.tangent, -s.back);
  eye.y = c.position.y + s.up;
  return {
    position: { x: eye.x, y: eye.y, z: eye.z },
    yaw: Math.atan2(c.tangent.x, c.tangent.z),
  };
}, { routeKey, fraction, back, up });
if (want('entrance')) {
  await place(await connectorCamera('entry', 0.62, 46, 14), -0.3);
  await shoot('entrance');
}
if (want('exit')) {
  await place(await connectorCamera('exit', 0.28, 52, 16), -0.3);
  await shoot('exit');
}

// --- 5. side elevation: Wangan under the deck --------------------------------------
if (want('side-elevation')) {
  await place(await deckCamera({ across: -120, up: 10, yawFrom: 'normal' }), -0.06);
  await shoot('side-elevation');
}

// --- 8. dashed markings at chase distance -------------------------------------------
if (want('markings-chase')) {
  const setup = await page.evaluate(() => {
    const map = window.shutoko.map;
    const wangan = map.routes.get('wangan_0');
    const sample = map._sampleCenter(wangan, 8000, 1);
    const eye = sample.position.clone().addScaledVector(sample.tangent, -6);
    eye.y = sample.position.y + 2.6;
    return {
      position: { x: eye.x, y: eye.y, z: eye.z },
      yaw: Math.atan2(sample.tangent.x, sample.tangent.z),
    };
  });
  await place(setup, -0.16);
  await shoot('markings-chase');
}

// --- 9. traffic direction on both carriageways ---------------------------------------
if (want('traffic-directions')) {
  await page.evaluate(() => {
    const g = window.shutoko;
    const map = g.map;
    if (g.debug?.noclip) g.setNoclip(false);
    const lane = map.sampleLane('wangan_0', 6000, 1, 1);
    const heading = Math.atan2(lane.tangent.x, lane.tangent.z);
    g.physics.setPosition
      ? g.physics.setPosition(lane.position.x, lane.position.y + 0.4, lane.position.z, heading)
      : g.physics.reset?.(lane.position, heading);
    (g.traffic?.pool || []).forEach((v) => { if (v.mesh) v.mesh.visible = true; });
  });
  await page.waitForTimeout(12000);
  const setup = await page.evaluate(() => {
    const g = window.shutoko;
    const map = g.map;
    const wangan = map.routes.get('wangan_0');
    const stations = (g.traffic?.active || g.traffic?.pool || [])
      .filter((v) => v.active && /^wangan_[01]$/.test(v.laneRef?.routeId || ''))
      .map((v) => map._projectToRoute(wangan, v.mesh?.position || v.position).distance)
      .filter((s) => Number.isFinite(s) && Math.abs(s - 6000) < 900)
      .sort((a, b) => a - b);
    const focus = stations.length ? stations[Math.floor(stations.length / 2)] : 5950;
    const sample = map._sampleCenter(wangan, focus - 60, 1);
    const eye = sample.position.clone().addScaledVector(sample.normal, 9);
    eye.y = sample.position.y + 22;
    return {
      position: { x: eye.x, y: eye.y, z: eye.z },
      yaw: Math.atan2(sample.tangent.x, sample.tangent.z),
      count: stations.length,
    };
  });
  console.log(`wangan traffic in window: ${setup.count}`);
  await place(setup, -0.42);
  await shoot('traffic-directions');
}

await browser.close();
server.close();
