/**
 * End-to-end regression: boots the game in headless Chromium with an
 * generic mobile touch viewport, drives the core loop through both real touch
 * events and the exposed window.shutoko handle, and screenshots key states.
 *
 * Run from repo root:  node .devtests/e2e.mjs
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
    res.writeHead(404);
    res.end('nope');
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
// Serve the three.js CDN request from the local node_modules copy.
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
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 30000 });
await page.screenshot({ path: join(OUT, '01-boot.png') });
check('boots without console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

// --- New game -> garage ---
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.waitForTimeout(700);
await page.screenshot({ path: join(OUT, '02-garage.png') });
check('new game enters garage', true);
check('touch controls visible in garage', await page.evaluate(() => !document.getElementById('touch-controls').classList.contains('hidden') && document.body.dataset.gameMode === 'garage'));

// --- Phone + map app via real taps ---
await page.tap('.touch-utility button[data-action="phone"]');
await page.waitForTimeout(350);
check('phone opens from touch button', await page.evaluate(() => window.shutoko.ui.phoneOpen));
await page.tap('button[data-app="map"]');
await page.waitForTimeout(500);
const mapPixels = await page.evaluate(() => {
  const canvas = document.getElementById('phone-map-canvas');
  if (!canvas) return { found: false };
  const c = canvas.getContext('2d');
  const data = c.getImageData(0, 0, canvas.width, canvas.height).data;
  let lit = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 90) lit += 1;
  return { found: true, lit, total: data.length / 4 };
});
check('phone map draws route network (not black)', mapPixels.found && mapPixels.lit > 200, `lit pixels: ${mapPixels.lit}`);
await page.screenshot({ path: join(OUT, '03-phone-map.png') });
// pinch-ish: drag pan should not throw
await page.dispatchEvent('#phone-map-canvas', 'pointerdown', { pointerId: 9, clientX: 300, clientY: 200, isPrimary: true });
await page.dispatchEvent('#phone-map-canvas', 'pointermove', { pointerId: 9, clientX: 340, clientY: 230 });
await page.dispatchEvent('#phone-map-canvas', 'pointerup', { pointerId: 9, clientX: 340, clientY: 230 });
check('map pan drag works', await page.evaluate(() => window.shutoko.ui.mapView && window.shutoko.ui.mapView.followPlayer === false));
await page.tap('#phone-close');

// --- Settings render quality ---
await page.tap('.touch-utility button[data-action="phone"]');
await page.tap('button[data-app="settings"]');
await page.waitForTimeout(200);
await page.screenshot({ path: join(OUT, '04-settings.png') });
const beforeRes = await page.evaluate(() => document.getElementById('game-canvas').width);
await page.selectOption('#set-quality', 'high');
await page.waitForTimeout(150);
const afterRes = await page.evaluate(() => document.getElementById('game-canvas').width);
check('render quality changes internal resolution', afterRes > beforeRes, `${beforeRes} -> ${afterRes}`);
await page.selectOption('#set-quality', 'medium');
await page.tap('#phone-close');

// --- Exit garage to highway ---
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });
await page.waitForTimeout(600);
check('driving mode reached', true);
const resInfo = await page.evaluate(() => { const c = document.getElementById('game-canvas'); return `${c.width}x${c.height}`; });
console.log('   internal render resolution (medium):', resInfo);

// --- Mobile developer map entry + touch navigation ---
const devMapButtonState = await page.evaluate(() => {
  const button = document.querySelector('.touch-utility button[data-action="dev-map"]');
  return { exists: !!button, visible: !!button && getComputedStyle(button).display !== 'none' };
});
check('mobile DEV MAP button is visible', devMapButtonState.exists && devMapButtonState.visible);
await page.tap('.touch-utility button[data-action="dev-map"]');
await page.waitForFunction(() => window.shutoko.devMap.isOpen());
const mobileDevMapLayout = await page.evaluate(() => {
  const map = document.querySelector('.dev-map').getBoundingClientRect();
  const close = document.querySelector('.dev-map-close').getBoundingClientRect();
  return {
    open: window.shutoko.devMap.isOpen(),
    fillsViewport: map.left <= 0 && map.top <= 0 && map.right >= innerWidth && map.bottom >= innerHeight,
    closeVisible: close.left >= 0 && close.top >= 0 && close.right <= innerWidth && close.bottom <= innerHeight,
  };
});
check('mobile DEV MAP button opens the shared map', mobileDevMapLayout.open);
check('mobile developer map and close control fit the viewport', mobileDevMapLayout.fillsViewport && mobileDevMapLayout.closeVisible);
await page.tap('.dev-map-toolbar button[data-act="fit"]');
const scaleBeforePinch = await page.evaluate(() => window.shutoko.devMap.view.scale);
await page.dispatchEvent('.dev-map-canvas', 'pointerdown', { pointerId: 51, pointerType: 'touch', clientX: 382, clientY: 195, button: 0, buttons: 1, isPrimary: true });
await page.dispatchEvent('.dev-map-canvas', 'pointerdown', { pointerId: 52, pointerType: 'touch', clientX: 462, clientY: 195, button: 0, buttons: 1, isPrimary: false });
await page.dispatchEvent('.dev-map-canvas', 'pointermove', { pointerId: 51, pointerType: 'touch', clientX: 342, clientY: 195, button: 0, buttons: 1, isPrimary: true });
await page.dispatchEvent('.dev-map-canvas', 'pointermove', { pointerId: 52, pointerType: 'touch', clientX: 502, clientY: 195, button: 0, buttons: 1, isPrimary: false });
await page.dispatchEvent('.dev-map-canvas', 'pointerup', { pointerId: 51, pointerType: 'touch', clientX: 342, clientY: 195, button: 0, buttons: 0, isPrimary: true });
await page.dispatchEvent('.dev-map-canvas', 'pointerup', { pointerId: 52, pointerType: 'touch', clientX: 502, clientY: 195, button: 0, buttons: 0, isPrimary: false });
const pinchState = await page.evaluate(() => ({
  scale: window.shutoko.devMap.view.scale,
  touchCount: window.shutoko.devMap._touchPoints.size,
  pinching: !!window.shutoko.devMap._pinch,
}));
check('mobile developer map supports two-finger pinch zoom', pinchState.scale > scaleBeforePinch * 1.5 && pinchState.touchCount === 0 && !pinchState.pinching, `${scaleBeforePinch.toFixed(3)} -> ${pinchState.scale.toFixed(3)}`);
const panBefore = await page.evaluate(() => ({ x: window.shutoko.devMap.view.camX, z: window.shutoko.devMap.view.camZ, position: { ...window.shutoko.getVehicleState().position } }));
await page.dispatchEvent('.dev-map-canvas', 'pointerdown', { pointerId: 53, pointerType: 'touch', clientX: 420, clientY: 200, button: 0, buttons: 1, isPrimary: true });
await page.dispatchEvent('.dev-map-canvas', 'pointermove', { pointerId: 53, pointerType: 'touch', clientX: 480, clientY: 230, button: 0, buttons: 1, isPrimary: true });
await page.dispatchEvent('.dev-map-canvas', 'pointerup', { pointerId: 53, pointerType: 'touch', clientX: 480, clientY: 230, button: 0, buttons: 0, isPrimary: true });
const panState = await page.evaluate((before) => {
  const dm = window.shutoko.devMap;
  const position = window.shutoko.getVehicleState().position;
  return {
    movedView: Math.hypot(dm.view.camX - before.x, dm.view.camZ - before.z),
    movedCar: Math.hypot(position.x - before.position.x, position.z - before.position.z),
  };
}, panBefore);
check('mobile developer map supports one-finger pan without teleporting', panState.movedView > 10 && panState.movedCar < 0.05, `view ${panState.movedView.toFixed(1)}m, car ${panState.movedCar.toFixed(3)}m`);
await page.screenshot({ path: join(OUT, '04b-dev-map-mobile.png') });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(250);
const portraitDevMapLayout = await page.evaluate(() => {
  const controls = [...document.querySelectorAll('.dev-map-toolbar button')].map((button) => button.getBoundingClientRect());
  const info = document.querySelector('.dev-map-info').getBoundingClientRect();
  return {
    controlsInside: controls.every((rect) => rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight),
    infoInside: info.left >= 0 && info.top >= 0 && info.right <= innerWidth && info.bottom <= innerHeight,
  };
});
check('mobile developer map fits portrait devices', portraitDevMapLayout.controlsInside && portraitDevMapLayout.infoInside);
await page.screenshot({ path: join(OUT, '04c-dev-map-mobile-portrait.png') });
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(250);
await page.tap('.dev-map-close');
await page.waitForFunction(() => !window.shutoko.devMap.isOpen());
check('mobile developer map closes back to touch controls', await page.evaluate(() => !document.getElementById('touch-controls').classList.contains('hidden') && !document.body.classList.contains('dev-map-open')));

// --- Mobile debug menu + complete noclip controls ---
await page.tap('.touch-utility button[data-action="debug"]');
await page.waitForFunction(() => window.shutoko.debug.menuOpen);
const debugMenuState = await page.evaluate(() => {
  const menu = document.getElementById('debug-menu');
  const rect = menu.getBoundingClientRect();
  return {
    visible: !menu.classList.contains('hidden') && menu.getAttribute('aria-hidden') === 'false',
    insideViewport: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth,
  };
});
check('mobile DBG button opens debug menu', debugMenuState.visible);
check('debug menu fits mobile viewport', debugMenuState.insideViewport);
await page.tap('label.debug-toggle:has(#debug-noclip)');
await page.tap('#debug-close');
await page.waitForFunction(() => window.shutoko.debug.noclip && document.body.classList.contains('noclip-active'));
const noclipUI = await page.evaluate(() => ({
  move: getComputedStyle(document.querySelector('.touch-drone-move')).display !== 'none',
  look: getComputedStyle(document.getElementById('touch-drone-look')).display !== 'none',
  height: getComputedStyle(document.querySelector('.touch-drone-actions')).display !== 'none',
  normalDriveHidden: getComputedStyle(document.querySelector('.touch-pedals')).display === 'none',
}));
check('noclip exposes dedicated mobile controls', noclipUI.move && noclipUI.look && noclipUI.height && noclipUI.normalDriveHidden);

const droneStart = await page.evaluate(() => ({ ...window.shutoko.debug.position }));
await page.dispatchEvent('.touch-drone-move button[data-code="KeyW"]', 'pointerdown', { pointerId: 31, isPrimary: true });
await page.waitForTimeout(500);
await page.dispatchEvent('.touch-drone-move button[data-code="KeyW"]', 'pointerup', { pointerId: 31, isPrimary: true });
const droneForward = await page.evaluate(() => ({ ...window.shutoko.debug.position }));
check('noclip mobile D-pad moves forward', Math.hypot(droneForward.x - droneStart.x, droneForward.z - droneStart.z) > 1);

await page.dispatchEvent('.touch-drone-actions button[data-code="Space"]', 'pointerdown', { pointerId: 32, isPrimary: true });
await page.waitForTimeout(300);
await page.dispatchEvent('.touch-drone-actions button[data-code="Space"]', 'pointerup', { pointerId: 32, isPrimary: true });
const droneRaised = await page.evaluate(() => window.shutoko.debug.position.y);
check('noclip mobile height control moves up', droneRaised > droneForward.y + 1, `${(droneRaised - droneForward.y).toFixed(1)}m`);

const lookBefore = await page.evaluate(() => ({ yaw: window.shutoko.debug.yaw, pitch: window.shutoko.debug.pitch }));
await page.dispatchEvent('#touch-drone-look', 'pointerdown', { pointerId: 33, clientX: 500, clientY: 140, isPrimary: true });
await page.dispatchEvent('#touch-drone-look', 'pointermove', { pointerId: 33, clientX: 570, clientY: 180, isPrimary: true });
await page.dispatchEvent('#touch-drone-look', 'pointerup', { pointerId: 33, clientX: 570, clientY: 180, isPrimary: true });
const lookAfter = await page.evaluate(() => ({ yaw: window.shutoko.debug.yaw, pitch: window.shutoko.debug.pitch }));
check('noclip drag-to-look changes aim', Math.abs(lookAfter.yaw - lookBefore.yaw) > 0.1 && Math.abs(lookAfter.pitch - lookBefore.pitch) > 0.05);

const speedBefore = await page.evaluate(() => window.shutoko.debug.moveSpeed);
await page.tap('.touch-drone-speed-controls button[data-action="drone-faster"]');
const speedAfter = await page.evaluate(() => window.shutoko.debug.moveSpeed);
check('noclip mobile speed control works', speedAfter > speedBefore, `${speedBefore} -> ${speedAfter} m/s`);
await page.screenshot({ path: join(OUT, '05-noclip-mobile.png') });

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(250);
const portraitNoclipLayout = await page.evaluate(() => {
  const controls = [...document.querySelectorAll('.touch-controls button')]
    .filter((element) => getComputedStyle(element).display !== 'none')
    .map((element) => ({ name: element.getAttribute('aria-label'), rect: element.getBoundingClientRect() }));
  const overlaps = [];
  for (let i = 0; i < controls.length; i += 1) for (let j = i + 1; j < controls.length; j += 1) {
    const a = controls[i].rect; const b = controls[j].rect;
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ox > 6 && oy > 6) overlaps.push(`${controls[i].name}~${controls[j].name}`);
  }
  return overlaps;
});
check('noclip controls do not overlap in portrait', portraitNoclipLayout.length === 0, portraitNoclipLayout.join(', '));
await page.screenshot({ path: join(OUT, '05b-noclip-mobile-portrait.png') });
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(250);

await page.tap('.touch-utility button[data-action="debug"]');
await page.tap('label.debug-toggle:has(#debug-noclip)');
await page.tap('#debug-close');
await page.waitForFunction(() => !window.shutoko.debug.noclip && !document.body.classList.contains('noclip-active'));
check('mobile menu can disable noclip and restore driving controls', await page.evaluate(() => getComputedStyle(document.querySelector('.touch-pedals')).display !== 'none'));
// The drone intentionally respawns the car at its free-flight position. Put
// it back at a known road spawn before the existing handling regressions.
await page.evaluate(() => window.shutoko.recover());
await page.waitForTimeout(250);

// Headless SwiftShader renders slowly, so measure in simulated frames.
await page.evaluate(() => {
  window.__frames = 0;
  const g = window.shutoko;
  const original = g.updateDriving.bind(g);
  g.updateDriving = (dt) => { window.__frames += 1; return original(dt); };
});

// --- Touch throttle: hold GAS, expect speed ---
await page.dispatchEvent('.touch-throttle', 'pointerdown', { pointerId: 21, isPrimary: true });
await page.waitForFunction(() => window.__frames >= 120, null, { timeout: 120000 });
const speed1 = await page.evaluate(() => window.shutoko.getTelemetry().speedKmh);
check('held GAS accelerates the car', speed1 > 30, `speed ${speed1.toFixed(0)} km/h`);

// --- Simultaneous steer while throttle held: multi-touch ---
const heading0 = await page.evaluate(() => { window.__frames = 0; return window.shutoko.getVehicleState().heading; });
await page.dispatchEvent('.touch-steer button[data-code="KeyD"]', 'pointerdown', { pointerId: 22, isPrimary: false });
await page.waitForFunction(() => window.__frames >= 40, null, { timeout: 90000 });
const steerState = await page.evaluate(() => ({
  heading: window.shutoko.getVehicleState().heading,
  keyW: !!window.shutoko.keys.KeyW,
  keyD: !!window.shutoko.keys.KeyD,
}));
check('multi-touch: throttle + steer both held', steerState.keyW && steerState.keyD);
const turned = ((heading0 - steerState.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
check('right steer button turns screen-right (heading decreases)', turned > 0.015, `delta ${turned.toFixed(3)}`);
await page.dispatchEvent('.touch-steer button[data-code="KeyD"]', 'pointerup', { pointerId: 22 });
await page.waitForTimeout(800);
await page.screenshot({ path: join(OUT, '05-driving.png') });

// --- Phone while driving pauses on touch device ---
await page.dispatchEvent('.touch-throttle', 'pointerup', { pointerId: 21 });
await page.tap('.touch-utility button[data-action="phone"]');
await page.waitForTimeout(300);
const posA = await page.evaluate(() => ({ ...window.shutoko.getVehicleState().position }));
await page.waitForTimeout(800);
const posB = await page.evaluate(() => ({ ...window.shutoko.getVehicleState().position }));
const moved = Math.hypot(posB.x - posA.x, posB.z - posA.z);
check('phone open pauses driving on touch device', moved < 0.05, `moved ${moved.toFixed(3)}m`);
await page.tap('#phone-close');

// --- Near miss scoring + banking ---
await page.evaluate(() => { const g = window.shutoko; g.physics.setSpeed(40); g.nearMiss({ distance: 0.5, side: 'left' }); });
const runScore = await page.evaluate(() => window.shutoko.run.score);
check('near miss adds score', runScore > 0, `score ${Math.floor(runScore)}`);
const moneyBefore = await page.evaluate(() => window.shutoko.state.money);
// stop the car first so flow-scoring doesn't re-accrue between evaluates
const bank = await page.evaluate(() => { const g = window.shutoko; g.physics.setSpeed(0); const before = g.run.score; g.bankScore('TEST PA'); return { before, money: g.state.money, score: g.run.score }; });
check('banking converts score to money and zeroes it', bank.money > moneyBefore && bank.score < 1, `+¥${bank.money - moneyBefore}`);

// --- Wall crash: car must settle and stay driveable, R recovers ---
await page.evaluate(() => {
  window.__frames = 0;
  const g = window.shutoko;
  const s = g.getVehicleState();
  const road = g.map.getRoadInfo(s.position);
  // fling the car sideways off the lane toward the outer wall at ~50 km/h
  g.physics.velocity.copy(road.normal.clone().multiplyScalar(14)).add(road.tangent.clone().multiplyScalar(20));
});
await page.waitForFunction(() => window.__frames >= 90, null, { timeout: 120000 });
const afterCrash = await page.evaluate(() => {
  const g = window.shutoko;
  const s = g.getVehicleState();
  return { yaw: Math.abs(s.yawRate), finite: Number.isFinite(s.position.x + s.position.y + s.position.z), lives: g.run.lives };
});
check('after wall hit: no endless spin, state finite', afterCrash.yaw < 0.6 && afterCrash.finite, `yawRate ${afterCrash.yaw.toFixed(2)}, lives ${afterCrash.lives}`);
await page.evaluate(() => window.shutoko.recover());
await page.waitForTimeout(400);
const recovered = await page.evaluate(() => {
  const g = window.shutoko;
  const info = g.map.getRoadInfo(g.getVehicleState().position);
  return info && info.onRoad !== false;
});
check('R recover puts car back on the road', !!recovered);

// --- Garage -> PC -> buy part -> delivery -> install -> stats change ---
await page.evaluate(() => window.shutoko.enterGarage('service'));
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 5000 });
await page.waitForTimeout(600);
const powerBefore = await page.evaluate(() => window.shutoko.getEffectiveCar().power);
await page.evaluate(() => { const g = window.shutoko; g.state.money += 500000; g.ui.openPC(g.getPCContext()); });
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '06-pc-auction.png') });
await page.tap('.pc nav button[data-tab="parts"]');
await page.waitForTimeout(300);
await page.screenshot({ path: join(OUT, '07-pc-parts.png') });
await page.evaluate(() => window.shutoko.buyPart(0));
const delivered = await page.evaluate(async () => {
  const g = window.shutoko;
  g.admin.instantDelivery = true;
  g.state.deliveries.forEach((d) => { d.readyAt = 0; });
  g.deliverySignature = '';
  g.makeDeliveriesReady();
  return { deliveries: g.availableDeliveries().length, boxes: g.garage.deliveryMeshes.length };
});
check('part purchase creates delivery box in garage', delivered.deliveries === 1 && delivered.boxes === 1, JSON.stringify(delivered));
await page.evaluate(() => { const g = window.shutoko; g.finishInstall(g.availableDeliveries()[0]); });
const powerAfter = await page.evaluate(() => window.shutoko.getEffectiveCar().power);
check('installing part changes stats', powerAfter > powerBefore, `${powerBefore.toFixed(0)} -> ${powerAfter.toFixed(0)} hp`);
await page.evaluate(() => window.shutoko.ui.closePC());

// --- Auction purchase ---
const carBefore = await page.evaluate(() => window.shutoko.state.ownedCarId);
await page.evaluate(() => {
  const g = window.shutoko;
  g.state.money += 5000000;
  const index = g.state.auctions.findIndex((a) => a.carId !== g.state.ownedCarId);
  g.buyCar(index >= 0 ? index : 0);
});
const carAfter = await page.evaluate(() => window.shutoko.state.ownedCarId);
check('auction car purchase swaps owned car', carAfter !== carBefore, `${carBefore} -> ${carAfter}`);

// --- Refuel + tow ---
await page.evaluate(() => { const g = window.shutoko; g.setPhysicsFuel(3); g.autoRefuel(g.map.getServiceAreas()[0]); });
const fuel = await page.evaluate(() => window.shutoko.state.fuel);
check('service-area refuel fills tank', fuel > 30, `${fuel.toFixed(1)} L`);
await page.evaluate(() => { window.shutoko.exitGarage(); });
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });
await page.evaluate(() => window.shutoko.tow());
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 5000 });
check('tow truck returns to garage', true);

// --- Save round trip ---
const saved = await page.evaluate(() => { window.shutoko.persist(); return !!localStorage.getItem('shutoko-nights.runtime.v2'); });
check('save persists to localStorage', saved);
await page.reload();
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 30000 });
const reloaded = await page.evaluate(() => ({ car: window.shutoko.state.ownedCarId, parts: window.shutoko.state.installedParts.length, hadSave: window.shutoko.hadSave }));
check('save survives reload (car + parts)', reloaded.hadSave && reloaded.car === carAfter, JSON.stringify(reloaded));

// --- Portrait layout screenshot ---
await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => window.shutoko.start());
await page.waitForTimeout(900);
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForTimeout(900);
await page.screenshot({ path: join(OUT, '08-portrait-driving.png') });

// --- Layout overlap audit (landscape driving) ---
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(700);
const overlaps = await page.evaluate(() => {
  const rects = [];
  const grab = (sel, label) => document.querySelectorAll(sel).forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 4 && r.height > 4 && getComputedStyle(el).display !== 'none') rects.push({ label: label || sel, x: r.x, y: r.y, w: r.width, h: r.height });
  });
  grab('.touch-steer button', 'steer');
  grab('.touch-pedals button', 'pedal');
  grab('.touch-actions button', 'action');
  grab('.touch-utility button', 'utility');
  grab('.cluster', 'cluster');
  grab('.route-chip', 'route');
  grab('.bank', 'bank');
  grab('.lives', 'lives');
  const bad = [];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i]; const b = rects[j];
      if (a.label === b.label) continue;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 6 && oy > 6) bad.push(`${a.label}~${b.label}`);
    }
  }
  return bad;
});
check('no HUD/control overlaps in landscape', overlaps.length === 0, overlaps.join(', '));
await page.screenshot({ path: join(OUT, '09-landscape-final.png') });

check('no console errors across whole session', errors.length === 0, errors.slice(0, 5).join(' | '));

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
