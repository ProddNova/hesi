/**
 * The Tatsumi PA zone, end to end in the real game: park in the square-ended
 * lay-by, take the gate, stand in the lot beside your own car, walk out.
 *
 * Checks the whole chain rather than any one link — the map publishes the
 * entrance, the driving loop offers it, the transition swaps scenes, the PA
 * scene is enclosed and holds the player, and the exit puts the car back where
 * it was parked (NOT at the boot spawn, which is what the garage does).
 *
 * Run: node .devtests/tatsumi-pa-zone-probe.mjs   -> .devtests/shots/PAZONE-*.png
 *
 * NOTE the SPLIT cdn routing below: the game imports both `three` and
 * `three/addons/utils/BufferGeometryUtils.js`, so a blanket jsdelivr route
 * hands the addon path the core bundle and the page dies on mergeGeometries.
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
const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1.5, hasTouch: true });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
await context.route('https://cdn.jsdelivr.net/**/examples/jsm/**', async (route) => {
  const rest = route.request().url().split('/examples/jsm/')[1];
  const body = await readFile(join(ROOT, 'node_modules/three/examples/jsm', rest));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const failures = [];
const notes = [];
const check = (ok, label) => { (ok ? notes : failures).push(`${ok ? 'PASS' : 'FAIL'} ${label}`); return ok; };

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 15000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 10000 });

// ------------------------------------------------------------------ entrance
const entrance = await page.evaluate(() => {
  const e = window.shutoko.map.zoneEntrances?.[0];
  return e ? { id: e.zoneId, x: e.position.x, y: e.position.y, z: e.position.z, radius: e.radius } : null;
});
if (!check(entrance?.id === 'tatsumi_pa', `the map publishes a tatsumi_pa entrance (${JSON.stringify(entrance)})`)) {
  console.log(failures.join('\n'));
  await browser.close(); server.close(); process.exit(1);
}

// Park on the gate forecourt, stopped, facing the gate.
await page.evaluate((e) => {
  const g = window.shutoko;
  const projection = g.map.getRoadInfo(new THREE.Vector3(e.x, e.y, e.z));
  const heading = projection?.heading ?? 0;
  g.physics.setPosition(e.x, e.y + 0.6, e.z, heading);
  g.physics.setSpeed(0);
  g.snapDrivingCamera();
}, entrance).catch(async () => {
  // THREE is not exposed globally; fall back to the map's own sampler.
  await page.evaluate((e) => {
    const g = window.shutoko;
    const sample = g.map.sampleLane('ramp_8', 691, 0, 1);
    g.physics.setPosition(e.x, e.y + 0.6, e.z, sample.heading);
    g.physics.setSpeed(0);
    g.snapDrivingCamera();
  }, entrance);
});
await page.waitForTimeout(900);

const prompt = await page.evaluate(() => document.getElementById('interaction-prompt')?.textContent || '');
check(/TATSUMI PA/i.test(prompt), `the parked car is offered the gate ("${prompt.trim()}")`);
await page.screenshot({ path: join(OUT, 'PAZONE-gate-approach.png') });

// Looking BACK up the bay from inside it: the square nose the driver has just
// passed, the gate standing in it, and the forecourt in front. A true plan view
// reads as black at night, which is why this is shot from the deck's own band.
await page.evaluate(() => {
  const g = window.shutoko;
  const sample = g.map.sampleLane('ramp_8', 592, 0, 1);
  g.setNoclip(true);
  const position = sample.position.clone().addScaledVector(sample.normal, 8);
  g.debug.position.set(position.x, position.y + 12, position.z);
  g.debug.yaw = sample.heading + Math.PI;
  g.debug.pitch = -0.2;
});
await page.waitForTimeout(1500);
await page.screenshot({ path: join(OUT, 'PAZONE-bay-from-inside.png') });
// …and forward from the nose, down the bay to the flare that opens it again.
await page.evaluate(() => {
  const g = window.shutoko;
  const sample = g.map.sampleLane('ramp_8', 556, 0, 1);
  const position = sample.position.clone().addScaledVector(sample.normal, 8);
  g.debug.position.set(position.x, position.y + 10, position.z);
  g.debug.yaw = sample.heading;
  g.debug.pitch = -0.16;
});
await page.waitForTimeout(1200);
await page.screenshot({ path: join(OUT, 'PAZONE-bay-oblique.png') });
await page.evaluate(() => window.shutoko.setNoclip(false));

// ------------------------------------------------------------------ transition
await page.evaluate(() => window.shutoko.enterTatsumiPa());
await page.waitForFunction(() => window.shutoko.mode === 'pa', null, { timeout: 15000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: join(OUT, 'PAZONE-lot.png') });

// Wide look across the lot from one corner: deck, both wall runs, lamp masts.
await page.evaluate(() => {
  const pa = window.shutoko.tatsumiPa;
  pa.position.set(-18, pa.playerHeight, 12);
  pa.yaw = -0.951; pa.pitch = -0.05;
  pa.updateCamera();
});
await page.waitForTimeout(700);
await page.screenshot({ path: join(OUT, 'PAZONE-lot-wide.png') });
await page.evaluate(() => { const pa = window.shutoko.tatsumiPa; pa.enter(); });
await page.waitForTimeout(400);

const lot = await page.evaluate(() => {
  const pa = window.shutoko.tatsumiPa;
  return {
    visible: pa.root.visible,
    colliders: pa.colliders.length,
    carAttached: window.shutoko.customCar?.object?.parent === pa.carDisplay,
    spawnToCar: Math.hypot(pa.position.x - pa.carDisplay.position.x, pa.position.z - pa.carDisplay.position.z),
    cameraInPaScene: window.shutoko.camera.parent === window.shutoko.paScene,
  };
});
check(lot.visible && lot.cameraInPaScene, 'the PA lot is the rendered scene');
check(lot.carAttached, 'the player\'s own car is the car parked in the lot');
check(lot.spawnToCar > 1.5 && lot.spawnToCar < 8, `the player spawns next to it (${lot.spawnToCar.toFixed(1)} m)`);
check(lot.colliders >= 4, `the perimeter wall is collidable (${lot.colliders} boxes)`);

// The wall must hold: walk hard into it for a second and stay inside.
const contained = await page.evaluate(async () => {
  const pa = window.shutoko.tatsumiPa;
  pa.yaw = 0; // forward = -z
  for (let i = 0; i < 240; i += 1) pa.update(1 / 60, { forward: true, sprint: true });
  return { x: pa.position.x, z: pa.position.z };
});
check(Math.abs(contained.z) < 15 && Math.abs(contained.x) < 23,
  `4 s of sprinting into the wall leaves the player inside the lot (x=${contained.x.toFixed(1)}, z=${contained.z.toFixed(1)})`);

// ------------------------------------------------------------------ exit
const before = await page.evaluate(() => {
  const s = window.shutoko.paReturn;
  return { x: s.position.x, z: s.position.z };
});
await page.evaluate(() => window.shutoko.exitTatsumiPa());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 15000 });
await page.waitForTimeout(600);
const after = await page.evaluate(() => {
  const s = window.shutoko.getVehicleState();
  const p = s.position || s;
  return { x: p.x, z: p.z, carOnPlayer: window.shutoko.customCar?.object?.parent === window.shutoko.playerMesh };
});
check(Math.hypot(after.x - before.x, after.z - before.z) < 3,
  `leaving the PA puts the car back where it was parked (${Math.hypot(after.x - before.x, after.z - before.z).toFixed(2)} m away)`);
check(after.carOnPlayer, 'the car visual is back on the road anchor');
await page.screenshot({ path: join(OUT, 'PAZONE-back-on-road.png') });

check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ') || 'none'})`);

console.log([...notes, ...failures].join('\n'));
console.log(`\n${notes.length}/${notes.length + failures.length} checks passed`);
await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);
