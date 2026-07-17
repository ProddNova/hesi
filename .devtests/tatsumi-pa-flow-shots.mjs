/**
 * Deterministic screenshots for the Tatsumi PA continuation checkpoint
 * (garage spawn on the deck, ramp_8 exit, left-hand traffic, denser dashes).
 * All cameras derive from the runtime service-area record and the fitted
 * centrelines, so before/after runs frame identical spots.
 *
 *  1. top-down        — plan view: deck between ramp_8 and ramp_9.
 *  2. spawn-chase     — the real chase camera right after exitGarage().
 *  3. exit-inside     — from the deck aisle, looking through the fence
 *                       opening onto the ramp_8 connector.
 *  4. exit-from-ramp  — driver height on ramp_8 upstream of the glue,
 *                       looking downstream at the joining connector.
 *  5. side-elevation  — broadside: Wangan carriageways under the deck.
 *  6. markings-chase  — wangan_0 dashes at chase-camera distance
 *                       (run with `before` suffix on the old tree to compare).
 *  7. traffic-directions — both Wangan carriageways with live traffic:
 *                       own carriageway shows taillights, opposing shows
 *                       headlights on the driver's right.
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
  await place(await deckCamera({ up: 290 }), -1.55);
  await shoot('top-down');
}

// --- 3. the exit seen from inside the PA ----------------------------------------
if (want('exit-inside')) {
  // stand on the aisle just behind the spawn, look toward the fence opening
  const setup = await page.evaluate(() => {
    const map = window.shutoko.map;
    const area = map.serviceAreas.find((candidate) => candidate.id === 'tatsumi_pa');
    const opening = area.fenceOpenings?.[0];
    if (!opening) return { missing: 'fence opening' };
    const eye = area.center.clone()
      .addScaledVector(area.tangent, opening.from - 55)
      .addScaledVector(area.normal, opening.side * -2);
    eye.y = area.elevation + 2.6;
    const target = area.center.clone()
      .addScaledVector(area.tangent, (opening.from + opening.to) * 0.5)
      .addScaledVector(area.normal, opening.side * (area.width * 0.5 + 6));
    target.y = area.elevation + 0.4;
    const d = target.clone().sub(eye);
    return {
      position: { x: eye.x, y: eye.y, z: eye.z },
      yaw: Math.atan2(d.x, d.z),
    };
  });
  await place(setup, -0.05);
  await shoot('exit-inside');
}

// --- 4. the connector seen from ramp_8 -------------------------------------------
if (want('exit-from-ramp')) {
  const setup = await page.evaluate(() => {
    const map = window.shutoko.map;
    const zone = map.junctionZones.find((candidate) => candidate.branch?.id === 'tatsumi_pa_exit');
    if (!zone) return { missing: 'exit zone' };
    const station = Math.max(0, zone.hostSpan[0] - 110);
    const sample = map._sampleCenter(zone.host, station, 1);
    return {
      position: { x: sample.position.x, y: sample.position.y + 2.4, z: sample.position.z },
      yaw: Math.atan2(sample.tangent.x, sample.tangent.z),
    };
  });
  await place(setup, -0.04);
  await shoot('exit-from-ramp');
}

// --- 5. side elevation: Wangan under the deck --------------------------------------
if (want('side-elevation')) {
  await place(await deckCamera({ across: -120, up: 10, yawFrom: 'normal' }), -0.06);
  await shoot('side-elevation');
}

// --- 6. dashed markings at chase distance -------------------------------------------
if (want('markings-chase')) {
  const setup = await page.evaluate(() => {
    const map = window.shutoko.map;
    const wangan = map.routes.get('wangan_0');
    const sample = map._sampleCenter(wangan, 8000, 1);
    // chase-camera geometry: ~6 m back, ~2.6 m up from a lane position
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

// --- 7. traffic direction on both carriageways ---------------------------------------
if (want('traffic-directions')) {
  // Park the car on wangan_0 near Tatsumi so traffic populates both
  // carriageways, then hover behind it over the median.
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
    // Frame the densest cluster of live wangan traffic near the car.
    const stations = (g.traffic?.active || g.traffic?.pool || [])
      .filter((v) => v.active && /^wangan_[01]$/.test(v.laneRef?.routeId || ''))
      .map((v) => map._projectToRoute(wangan, v.mesh?.position || v.position).distance)
      .filter((s) => Number.isFinite(s) && Math.abs(s - 6000) < 900)
      .sort((a, b) => a - b);
    const focus = stations.length ? stations[Math.floor(stations.length / 2)] : 5950;
    const sample = map._sampleCenter(wangan, focus - 60, 1);
    // over the gap between the carriageways (opposing sits on the right)
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
