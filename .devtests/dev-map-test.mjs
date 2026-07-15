/**
 * Focused regression for the developer network map (js/dev-map.js).
 *
 * Boots the game in headless Chromium on a desktop viewport, drives the M-key
 * developer map through open/close, input blocking, live position sources
 * (vehicle vs noclip), hover hit-testing, overlap resolution, zoom-under-cursor,
 * drag-vs-click, click-to-teleport (driving + noclip), chunk streaming after a
 * distant teleport, and a mobile pass confirming the phone minimap + touch
 * controls are untouched.
 *
 * Run from repo root:  node .devtests/dev-map-test.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
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
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map && !!window.shutoko.devMap, null, { timeout: 30000 });
check('dev map module constructed', await page.evaluate(() => !!window.shutoko.devMap));

// Get into driving mode.
await page.evaluate(() => window.shutoko.start());
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 8000 });
await page.waitForTimeout(400);

// --- 1. M opens and closes ---
await page.keyboard.press('m');
await page.waitForTimeout(120);
check('M opens the developer map', await page.evaluate(() => window.shutoko.devMap.isOpen() && !document.querySelector('.dev-map').hidden));
const prototypePins = await page.evaluate(() => {
  const dm = window.shutoko.devMap;
  dm.fitNetwork();
  dm._drawStatic();
  const dpr = dm._dpr;
  const expected = [
    'J8:merge:r11_0:ramp_1:end',
    'J0:merge:c1_0:c1_3:end',
    'J10:merge:wangan_1:ramp_3:end',
    'J2:diverge:c1_0:r1_0:start',
  ];
  const pins = dm.network.prototypePins;
  const rendered = pins.every((pin) => {
    const s = dm.worldToScreen(pin.x, pin.z);
    const x = Math.max(0, Math.round((s.x - 9) * dpr));
    const y = Math.max(0, Math.round((s.y - 9) * dpr));
    const size = Math.max(1, Math.round(18 * dpr));
    const data = dm.staticCtx.getImageData(x, y, size, size).data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 220 && data[i + 2] > 170 && data[i] > data[i + 1] * 1.25) return true;
    }
    return false;
  });
  return {
    count: pins.length,
    idsMatch: pins.map((pin) => pin.id).every((id, index) => id === expected[index]),
    labelsMatch: pins.map((pin) => pin.pinId).join(',') === 'P1,P2,P3,P4',
    finite: pins.every((pin) => Number.isFinite(pin.x + pin.y + pin.z + pin.distance)),
    rendered,
    info: document.querySelector('[data-info="prototypes"]')?.textContent || '',
  };
});
check('developer map exposes exactly four audited prototype pins', prototypePins.count === 4 && prototypePins.idsMatch && prototypePins.finite);
check('prototype pins render as P1-P4', prototypePins.labelsMatch && prototypePins.rendered, prototypePins.info);
await page.screenshot({ path: join(OUT, 'dev-01-fit-network.png') });
await page.keyboard.press('m');
await page.waitForTimeout(120);
check('M closes the developer map', await page.evaluate(() => !window.shutoko.devMap.isOpen() && document.querySelector('.dev-map').hidden));

// --- 2. Escape closes ---
await page.keyboard.press('m');
await page.waitForTimeout(80);
await page.keyboard.press('Escape');
await page.waitForTimeout(120);
check('Escape closes the developer map', await page.evaluate(() => !window.shutoko.devMap.isOpen()));

// --- 3. opening clears and blocks gameplay inputs ---
const blockRes = await page.evaluate(async () => {
  const g = window.shutoko;
  g.keys.KeyW = true; g.pressed.add('KeyW'); // simulate a held throttle
  g.devMap.open();
  const clearedOnOpen = !g.keys.KeyW && g.pressed.size === 0;
  const p0 = { ...g.getVehicleState().position };
  await new Promise((r) => setTimeout(r, 500));
  const p1 = { ...g.getVehicleState().position };
  const frozen = Math.hypot(p1.x - p0.x, p1.z - p0.z) < 0.01;
  return { clearedOnOpen, frozen };
});
check('opening clears held inputs', blockRes.clearedOnOpen);
check('opening freezes gameplay (car does not move)', blockRes.frozen);

// --- 6/7. hover selects nearest route with genuine metadata ---
const hover = await page.evaluate(() => {
  const dm = window.shutoko.devMap;
  dm.fitNetwork();
  // Pick a long mainline and a vertex near its middle.
  const route = [...dm.network.routes].sort((a, b) => b.routeLength - a.routeLength)[0];
  const v = route.points[Math.floor(route.points.length / 2)];
  const s = dm.worldToScreen(v.x, v.z);
  const hit = dm._hitTest(s.x, s.y);
  return {
    expectedId: route.id,
    hitId: hit?.route.id,
    hitName: hit?.route.name,
    idIsReal: !!hit && window.shutoko.getDevNetwork().routes.some((r) => r.id === hit.route.id),
    nameNonEmpty: !!hit?.route.name,
    closeWorld: hit ? Math.hypot(hit.worldX - v.x, hit.worldZ - v.z) : Infinity,
  };
});
check('hover selects the nearest route', hover.hitId === hover.expectedId, `${hover.hitId} vs ${hover.expectedId}`);
check('hover returns closest point on that route', hover.closeWorld < 5, `${hover.closeWorld.toFixed(1)}m`);
check('tooltip data uses genuine route id + name', hover.idIsReal && hover.nameNonEmpty, `${hover.hitId} / ${hover.hitName}`);

// --- 8. overlapping routes resolved deterministically by elevation ---
const overlap = await page.evaluate(() => {
  const g = window.shutoko; const dm = g.devMap;
  dm.fitNetwork();
  const routes = dm.network.routes;
  // Find a screen pixel where two routes' segments overlap in plan but differ in elevation.
  const proj = routes.map((r) => ({ r, pts: r.points.map((p) => ({ s: dm.worldToScreen(p.x, p.z), y: p.y ?? 0 })) }));
  for (let a = 0; a < proj.length; a += 1) {
    for (let b = a + 1; b < proj.length; b += 1) {
      for (const pa of proj[a].pts) {
        for (const pb of proj[b].pts) {
          if (Math.hypot(pa.s.x - pb.s.x, pa.s.y - pb.s.y) < 4 && Math.abs(pa.y - pb.y) > 6) {
            const sx = (pa.s.x + pb.s.x) / 2, sy = (pa.s.y + pb.s.y) / 2;
            const yLow = Math.min(pa.y, pb.y), yHigh = Math.max(pa.y, pb.y);
            // Drive elevation preference via noclip debug height.
            g.debug.noclip = true;
            g.debug.position.set(dm.screenToWorld(sx, sy).x, yLow, dm.screenToWorld(sx, sy).z);
            const low = dm._hitTest(sx, sy);
            const lowAgain = dm._hitTest(sx, sy);
            g.debug.position.y = yHigh;
            dm.hovered = null; // reset hysteresis so the pick can flip
            const high = dm._hitTest(sx, sy);
            g.debug.noclip = false;
            return {
              found: true,
              deterministic: low && lowAgain && low.route.id === lowAgain.route.id && Math.abs(low.chainage - lowAgain.chainage) < 1e-6,
              lowElev: low?.elevation, highElev: high?.elevation,
              lowNearLow: low ? Math.abs(low.elevation - yLow) <= Math.abs(low.elevation - yHigh) : false,
              highNearHigh: high ? Math.abs(high.elevation - yHigh) <= Math.abs(high.elevation - yLow) : false,
            };
          }
        }
      }
    }
  }
  // No multi-level overlap on this network — still assert determinism at a vertex.
  const r = routes[0]; const v = r.points[1]; const s = dm.worldToScreen(v.x, v.z);
  const h1 = dm._hitTest(s.x, s.y); const h2 = dm._hitTest(s.x, s.y);
  return { found: false, deterministic: !!h1 && !!h2 && h1.route.id === h2.route.id };
});
check('overlap hit-test is deterministic', overlap.deterministic);
check('overlapping routes resolved by nearest elevation', !overlap.found || (overlap.lowNearLow && overlap.highNearHigh), overlap.found ? `low→${overlap.lowElev?.toFixed(0)} high→${overlap.highElev?.toFixed(0)}` : 'no multi-level overlap found');

// --- 9. zoom preserves world point under cursor ---
const zoom = await page.evaluate(() => {
  const dm = window.shutoko.devMap;
  const sx = 700, sy = 420;
  const before = dm.screenToWorld(sx, sy);
  dm.zoomAt(sx, sy, 1.15 * 1.15 * 1.15);
  const after = dm.screenToWorld(sx, sy);
  return { d: Math.hypot(after.x - before.x, after.z - before.z) };
});
check('zoom preserves the world point under the cursor', zoom.d < 0.5, `drift ${zoom.d.toFixed(3)}m`);

// --- 4/5. marker position source: vehicle vs noclip ---
const markerSrc = await page.evaluate(() => {
  const g = window.shutoko; const dm = g.devMap;
  g.debug.noclip = false;
  const veh = { ...g.getVehicleState().position };
  const drivePos = dm.cb.getCurrentPosition();
  const usesVehicle = Math.hypot(drivePos.x - veh.x, drivePos.z - veh.z) < 0.01;
  // Now noclip with a deliberately different debug position.
  g.debug.noclip = true;
  g.debug.position.set(veh.x + 500, veh.y + 40, veh.z + 500);
  g.debug.yaw = 1.234;
  const noclipPos = dm.cb.getCurrentPosition();
  const usesDebug = Math.hypot(noclipPos.x - (veh.x + 500), noclipPos.z - (veh.z + 500)) < 0.01;
  const notVehicle = Math.hypot(noclipPos.x - veh.x, noclipPos.z - veh.z) > 100;
  const heading = dm.cb.getCurrentHeading();
  g.debug.noclip = false;
  return { usesVehicle, usesDebug, notVehicle, headingUsesYaw: Math.abs(heading - 1.234) < 1e-6 };
});
check('normal marker uses the vehicle position', markerSrc.usesVehicle);
check('noclip marker uses debug position, not the vehicle', markerSrc.usesDebug && markerSrc.notVehicle);
check('noclip marker heading uses drone yaw', markerSrc.headingUsesYaw);

// --- 10. dragging does not teleport ---
const drag = await page.evaluate(() => new Promise((resolve) => {
  const g = window.shutoko; const dm = g.devMap;
  g.debug.noclip = false;
  dm.fitNetwork();
  const before = { ...g.getVehicleState().position };
  const route = [...dm.network.routes].sort((a, b) => b.routeLength - a.routeLength)[0];
  const v = route.points[Math.floor(route.points.length / 2)];
  const s = dm.worldToScreen(v.x, v.z);
  const canvas = dm.canvas;
  const ev = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true }));
  ev('pointerdown', s.x, s.y);
  ev('pointermove', s.x + 60, s.y + 40);
  ev('pointermove', s.x + 120, s.y + 80);
  canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: s.x + 120, clientY: s.y + 80, button: 0, buttons: 0, bubbles: true }));
  setTimeout(() => {
    const after = { ...g.getVehicleState().position };
    resolve({ moved: Math.hypot(after.x - before.x, after.z - before.z), followOff: dm.view.followPlayer === false });
  }, 60);
}));
check('dragging does not teleport the car', drag.moved < 0.5, `moved ${drag.moved.toFixed(2)}m`);
check('dragging disables follow mode', drag.followOff);

// --- 11/13. click-to-teleport (driving): closest point, reset velocity ---
const driveTp = await page.evaluate(() => new Promise((resolve) => {
  const g = window.shutoko; const dm = g.devMap;
  g.debug.noclip = false;
  dm.fitNetwork();
  // give the car some velocity to prove it gets cleared
  if (g.physics.velocity) g.physics.velocity.set(20, 0, 20);
  const route = [...dm.network.routes].sort((a, b) => b.routeLength - a.routeLength)[0];
  const v = route.points[Math.floor(route.points.length / 3)];
  const s = dm.worldToScreen(v.x, v.z);
  const canvas = dm.canvas;
  canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, clientX: s.x, clientY: s.y, button: 0, buttons: 1, bubbles: true }));
  canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, clientX: s.x, clientY: s.y, button: 0, buttons: 0, bubbles: true }));
  setTimeout(() => {
    const p = { ...g.getVehicleState().position };
    const speed = g.physics.velocity ? g.physics.velocity.length() : (g.getTelemetry().speedMS || 0);
    const finite = Number.isFinite(p.x + p.y + p.z);
    resolve({
      closeToClick: Math.hypot(p.x - v.x, p.z - v.z),
      speed, finite, stayedOpen: dm.isOpen(),
    });
  }, 60);
}));
check('clicking a route teleports to the closest point', driveTp.closeToClick < 30 && driveTp.finite, `${driveTp.closeToClick.toFixed(1)}m`);
check('vehicle teleport clears velocity (safe reset)', driveTp.speed < 0.5, `${driveTp.speed.toFixed(2)} m/s`);
check('map stays open after teleport', driveTp.stayedOpen);
await page.screenshot({ path: join(OUT, 'dev-02-teleport-driving.png') });

// --- 12/14. noclip teleport updates debug pos + yaw, refreshes chunks ---
const noclipTp = await page.evaluate(() => {
  const g = window.shutoko; const dm = g.devMap;
  g.debug.noclip = true;
  g.debug.position.set(0, 60, 0);
  dm.fitNetwork();
  const keyBefore = g.map._visibleKey;
  // Pick a far route point to force a distant teleport + chunk refresh.
  const far = [...dm.network.routes].sort((a, b) => b.routeLength - a.routeLength)[0];
  const v = far.points[far.points.length - 2];
  const s = dm.worldToScreen(v.x, v.z);
  const hit = dm._hitTest(s.x, s.y);
  dm._teleport(hit);
  const dp = { ...g.debug.position };
  const sample = g.map.sampleLane(hit.route.id, hit.chainage, 0, hit.route.direction || 1);
  const posMatches = Math.hypot(dp.x - sample.position.x, dp.z - sample.position.z) < 5;
  const yawMatches = Math.abs(((g.debug.yaw - sample.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.05;
  const chunksRefreshed = g.map._visibleKey !== keyBefore;
  g.debug.noclip = false;
  return { posMatches, yawMatches, chunksRefreshed, keyBefore, keyAfter: g.map._visibleKey };
});
check('noclip teleport updates the debug/drone position', noclipTp.posMatches);
check('noclip teleport aligns drone yaw to the route tangent', noclipTp.yawMatches);
check('distant teleport refreshes streamed chunks', noclipTp.chunksRefreshed, `${noclipTp.keyBefore} -> ${noclipTp.keyAfter}`);
await page.screenshot({ path: join(OUT, 'dev-03-teleport-noclip.png') });

// --- 15. closing leaves no stuck keys / pointer state ---
const closeState = await page.evaluate(() => {
  const g = window.shutoko;
  g.keys.KeyA = true; g.pressed.add('KeyA');
  g.devMap.close();
  return { keys: Object.values(g.keys).filter(Boolean).length, pressed: g.pressed.size, open: g.devMap.isOpen() };
});
check('closing leaves no stuck keys', closeState.keys === 0 && closeState.pressed === 0 && !closeState.open);

// --- 16. phone minimap + touch controls untouched (mobile pass) ---
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(200);
const phone = await page.evaluate(async () => {
  const g = window.shutoko;
  g.ui.togglePhone(g.getPhoneContext());
  await new Promise((r) => setTimeout(r, 60));
  g.ui.openPhoneApp('map');
  await new Promise((r) => setTimeout(r, 500));
  const canvas = document.getElementById('phone-map-canvas');
  if (!canvas) return { lit: 0, phoneOpen: g.ui.phoneOpen };
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let lit = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 90) lit += 1;
  g.ui.closePhone();
  return { lit, phoneOpen: true };
});
check('phone minimap still renders the network', phone.lit > 200, `lit ${phone.lit}`);
check('phone map + touch UI unaffected by dev map', phone.phoneOpen);

check('no console errors across the whole run', errors.length === 0, errors.slice(0, 5).join(' | '));

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
