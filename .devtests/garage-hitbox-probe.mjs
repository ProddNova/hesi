/**
 * Garage remodel regression: boots the game headless, enters the garage and
 * verifies the editor-remodelled room — dynamic wall/object/car hitboxes,
 * the Toyota Chaser GLB showroom car, the PS2-style exit prisms at the moved
 * shutter, and the relocated PC / delivery-zone interactions.
 *
 * Run from repo root:  node .devtests/garage-hitbox-probe.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('nope');
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
// Serve the three.js CDN requests from the local node_modules copy (core
// build + examples/jsm addons like GLTFLoader).
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const url = new URL(route.request().url());
  const rel = url.pathname.replace(/^\/npm\/three@[^/]+\//, '');
  try {
    const body = await readFile(join(ROOT, 'node_modules/three', rel));
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  } catch {
    await route.fulfill({ status: 404, body: 'nope' });
  }
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 30000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
// Editor build + GLB showroom car must both be in before probing hitboxes.
await page.waitForFunction(() => window.shutoko.customCar.status === 'ready' && window.shutoko.garage.colliders.length > 10, null, { timeout: 20000 });
await page.waitForTimeout(500);
check('boots into garage without console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

const state = await page.evaluate(() => {
  const g = window.shutoko.garage;
  const car = window.shutoko.customCar.object;
  return {
    colliders: g.colliders.length,
    carParent: car?.parent === g.carDisplay,
    carVisible: !!car?.visible,
    carInGarageScene: (() => { let n = car; while (n) { if (n === g.root) return true; n = n.parent; } return false; })(),
    markerColor: g.exitMarkers?.userData.core?.material.color.getHex() ?? null,
    markerSats: g.exitMarkers?.userData.sats?.length ?? 0,
    markerX: g.exitMarkers?.position.x ?? null,
    pcMarkerColor: g.pcMarkers?.userData.core?.material.color.getHex() ?? null,
    pcMarkerSats: g.pcMarkers?.userData.sats?.length ?? 0,
    pcMarkerPos: g.pcMarkers ? [g.pcMarkers.position.x, g.pcMarkers.position.z] : null,
    doorX: g.shutter?.position.x ?? null,
    exitPoint: g.exitPoint ? [g.exitPoint.x, g.exitPoint.z] : null,
    pcPoint: g.pcPoint ? [g.pcPoint.x, g.pcPoint.z] : null,
    parkedGroupHidden: g.parkedGroup.visible === false,
  };
});
check('editor build hitboxes collected', state.colliders > 10, `colliders: ${state.colliders}`);
check('Chaser GLB parked in garage and visible', state.carParent && state.carVisible && state.carInGarageScene);
check('procedural old car stays hidden', state.parkedGroupHidden);
const R = (c) => (c >> 16) & 0xff, Gc = (c) => (c >> 8) & 0xff, B = (c) => c & 0xff;
const isBlue = state.markerColor !== null && B(state.markerColor) > 0x80 && B(state.markerColor) > R(state.markerColor) && B(state.markerColor) > Gc(state.markerColor);
check('blue crystal beacon (core + 4 satellites) at the moved shutter', isBlue && state.markerSats === 4 && Math.abs(state.markerX - state.doorX) < 0.01 && Math.abs(state.doorX - 5.7) < 0.2, `color: #${(state.markerColor ?? 0).toString(16)}, sats: ${state.markerSats}, doorX: ${state.doorX}, markerX: ${state.markerX}`);
const isYellow = state.pcMarkerColor !== null && R(state.pcMarkerColor) > 0x80 && Gc(state.pcMarkerColor) > 0x80 && B(state.pcMarkerColor) < 0x80;
check('yellow crystal beacon (core + 4 satellites) over the market PC', isYellow && state.pcMarkerSats === 4 && state.pcMarkerPos && Math.abs(state.pcMarkerPos[0] - state.pcPoint[0]) < 0.01 && Math.abs(state.pcMarkerPos[1] - state.pcPoint[1]) < 0.01, `color: #${(state.pcMarkerColor ?? 0).toString(16)}, sats: ${state.pcMarkerSats}, pos: ${JSON.stringify(state.pcMarkerPos)}`);
check('exit interaction moved to the door', state.exitPoint && Math.abs(state.exitPoint[0] - state.doorX) < 0.01, `exit: ${JSON.stringify(state.exitPoint)}`);
check('PC interaction anchored to the game table', state.pcPoint && Math.abs(state.pcPoint[0] - -1) < 0.3 && Math.abs(state.pcPoint[1] - 6) < 0.3, `pc: ${JSON.stringify(state.pcPoint)}`);

// Deterministic walk: place the walker, aim, and step update() manually.
const walk = (x, z, yaw, frames = 240) => page.evaluate(([x, z, yaw, frames]) => {
  const g = window.shutoko.garage;
  g.position.set(x, g.playerHeight, z); g.velocity.set(0, 0, 0); g.yaw = yaw; g.pitch = 0;
  for (let i = 0; i < frames; i++) g.update(1 / 60, { forward: true }, {});
  return { x: g.position.x, z: g.position.z };
}, [x, z, yaw, frames]);

const leftWall = await walk(-3, 4, Math.PI / 2);   // toward the moved left wall (inner face x=-4.825)
check('left wall (moved by editor) blocks the walker', leftWall.x > -4.6 && leftWall.x < -4.2, `stopped at x=${leftWall.x.toFixed(2)}`);
const backWall = await walk(3.5, 1, 0);             // toward the moved back wall (inner face z=-2.795); yaw 0 faces -z
check('back wall (moved by editor) blocks the walker', backWall.z > -2.6 && backWall.z < -2.2, `stopped at z=${backWall.z.toFixed(2)}`);
const carSide = await walk(0, 4, 0);                // straight into the parked Chaser
check('Chaser GLB has a hitbox', carSide.z > 0.55 && carSide.z < 2.5, `stopped at z=${carSide.z.toFixed(2)}`);
const lockers = await walk(7, 0.8, -Math.PI / 2);   // toward the lockers on the right wall
check('placed objects (lockers) have hitboxes', lockers.x < 10.0, `stopped at x=${lockers.x.toFixed(2)}`);
const front = await walk(2, 11, Math.PI);           // yaw PI faces +z, into the front wall
check('front wall blocks the walker', front.z < 13.6, `stopped at z=${front.z.toFixed(2)}`);

// Interactions: door exit and market PC prompts resolve at their new anchors.
const prompts = await page.evaluate(() => {
  const g = window.shutoko.garage;
  const probe = (x, z, yaw) => { g.position.set(x, g.playerHeight, z); g.velocity.set(0, 0, 0); g.yaw = yaw; return g.findInteraction({})?.type || null; };
  return {
    exit: probe(g.exitPoint.x, g.exitPoint.z - 0.6, Math.PI),
    pc: probe(g.pcPoint.x + 1.2, g.pcPoint.z + 1.2, Math.PI * 0.75),
    awayFromOldPc: probe(3.5, -1.5, 0),
  };
});
check('door exit prompt appears at the moved shutter', prompts.exit === 'exit', `got: ${prompts.exit}`);
check('market PC prompt appears at the game table', prompts.pc === 'pc', `got: ${prompts.pc}`);
check('no stray PC prompt at the old desk area', prompts.awayFromOldPc !== 'pc', `got: ${prompts.awayFromOldPc}`);

// Delivery boxes spawn inside the moved yellow zone outline.
const delivery = await page.evaluate(() => {
  const g = window.shutoko.garage;
  g.syncDeliveries([{ id: 'probe-part', name: 'Probe Part' }]);
  const mesh = g.deliveryMeshes[0];
  const zone = g.deliveryEdge.position;
  const out = { box: [mesh.position.x, mesh.position.z], zone: [zone.x, zone.z] };
  g.syncDeliveries([]);
  return out;
});
check('delivery boxes spawn in the moved delivery zone', Math.abs(delivery.box[0] - delivery.zone[0]) < 2.2 && Math.abs(delivery.box[1] - delivery.zone[1]) < 2, `box: ${JSON.stringify(delivery.box)}`);

// Screenshots: showroom car, blue door beacon, yellow PC beacon.
// A few frames of update() let the crystals spin/orbit into place first.
const settle = () => page.evaluate(() => { for (let i = 0; i < 30; i++) window.shutoko.garage.update(1 / 60, {}, {}); });
await settle();
await page.evaluate(() => { const g = window.shutoko.garage; g.position.set(-2.8, g.playerHeight, 5.8); g.velocity.set(0, 0, 0); g.yaw = -0.45; g.pitch = -0.16; g.updateCamera(); });
await page.waitForTimeout(250);
await page.screenshot({ path: join(OUT, 'garage-01-car.png') });
await page.evaluate(() => { const g = window.shutoko.garage; g.position.set(g.exitPoint.x + 1.6, g.playerHeight, 9.4); g.velocity.set(0, 0, 0); const dx = g.exitMarkers.position.x - g.position.x, dz = 12.4 - g.position.z; g.yaw = Math.atan2(-dx, -dz); g.pitch = -0.04; g.updateCamera(); });
await settle();
await page.waitForTimeout(150);
await page.screenshot({ path: join(OUT, 'garage-02-exit-beacon.png') });
await page.evaluate(() => { const g = window.shutoko.garage; g.position.set(g.pcPoint.x + 2.4, g.playerHeight, g.pcPoint.z + 3.4); g.velocity.set(0, 0, 0); const dx = g.pcPoint.x - g.position.x, dz = g.pcPoint.z - g.position.z; g.yaw = Math.atan2(-dx, -dz); g.pitch = -0.06; g.updateCamera(); });
await settle();
await page.waitForTimeout(150);
await page.screenshot({ path: join(OUT, 'garage-03-pc-beacon.png') });

check('no console errors after probes', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
process.exit(failed.length ? 1 : 0);
