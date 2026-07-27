/**
 * Driving-camera probe.
 *
 * Three behaviours, all invisible to every other test:
 *  1. the chase camera keeps the same car-relative distance while the car
 *     translates, instead of accumulating world-space smoothing lag;
 *  2. the chase FOV grows only slightly with speed, so motion does not visually
 *     zoom the car away;
 *  3. the camera shake — nothing at a standstill, something while driving hard,
 *     and in the chase view a gentler, slower version of the cockpit's.
 *
 * The camera is driven directly with synthetic telemetry so the measurements
 * are deterministic rather than "however fast the car happened to be going".
 *
 * Run: node .devtests/driving-camera-probe.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.obj': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg',
};

const server = createServer(async (request, response) => {
  try {
    const urlPath = request.url.split('?')[0];
    const file = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
    const body = await readFile(join(ROOT, file));
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
// Split routing is mandatory — see the note in vhs-car-paint-probe.mjs.
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const url = new URL(route.request().url());
  const addon = url.pathname.match(/\/examples\/jsm\/(.+)$/);
  const file = addon
    ? join(ROOT, 'node_modules', 'three', 'examples', 'jsm', addon[1])
    : join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(file) });
});

const page = await context.newPage();
const errors = [];
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
page.on('pageerror', (error) => errors.push(String(error)));
page.on('dialog', (dialog) => dialog.accept());

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} · ${name}${detail ? ` · ${detail}` : ''}`);
};

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 20000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 20000 });
await page.waitForTimeout(2000);

/**
 * Settles the camera on one telemetry snapshot, then samples it for a while.
 * The settle pass is what makes the numbers repeatable: both the position and
 * the shake amplitude are smoothed toward their targets.
 */
const sample = await page.evaluate(() => {
  const game = window.shutoko;
  const telemetry = (speedKmh, throttle = 0, slip = 0) => ({
    speedKmh, throttle, slip, speedMS: speedKmh / 3.6, rpm: 4000, gear: 4,
  });
  const run = (mode, t, { settle = 240, frames = 90 } = {}) => {
    game.cameraMode = mode;
    game.lastDriveInput = { throttle: t.throttle, brake: 0, steer: 0, handbrake: 0 };
    game.snapDrivingCamera();
    game.camShake = 0;
    for (let i = 0; i < settle; i += 1) game.updateCamera(1 / 60, t);
    const car = game.getVehicleState();
    const origin = car.position || car;
    const samples = [];
    for (let i = 0; i < frames; i += 1) {
      game.updateCamera(1 / 60, t);
      samples.push([game.camera.position.x, game.camera.position.y, game.camera.position.z]);
    }
    // Distance from the car, and how much the eye moves frame to frame.
    const distance = Math.hypot(
      samples.at(-1)[0] - origin.x, samples.at(-1)[1] - origin.y, samples.at(-1)[2] - origin.z,
    );
    const horizontalDistance = Math.hypot(
      samples.at(-1)[0] - origin.x, samples.at(-1)[2] - origin.z,
    );
    let jitter = 0;
    for (let i = 1; i < samples.length; i += 1) {
      jitter = Math.max(jitter, Math.hypot(
        samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1], samples[i][2] - samples[i - 1][2],
      ));
    }
    return { distance, horizontalDistance, jitter, shake: game.camShake, fov: game.camera.fov };
  };
  const runMoving = (speedKmh, frames = 180) => {
    const originalState = game.getVehicleState.bind(game);
    const originalTelemetry = game.getTelemetry.bind(game);
    const state = originalState();
    const position = (state.position || state).clone();
    const heading = state.heading ?? state.yaw ?? 0;
    const t = telemetry(speedKmh, 1);
    game.cameraMode = 'chase';
    game.getVehicleState = () => ({ ...state, position, heading });
    game.getTelemetry = () => t;
    game.lastDriveInput = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
    game.snapDrivingCamera();
    const startDistance = game.camPos.distanceTo(position);
    for (let i = 0; i < frames; i += 1) {
      position.x += Math.sin(heading) * t.speedMS / 60;
      position.z += Math.cos(heading) * t.speedMS / 60;
      game.updateCamera(1 / 60, t);
    }
    const endDistance = game.camPos.distanceTo(position);
    const out = { startDistance, endDistance, fov: game.camera.fov };
    game.getVehicleState = originalState;
    game.getTelemetry = originalTelemetry;
    game.snapDrivingCamera();
    return out;
  };
  const hard = telemetry(200, 1, 0.2);
  const out = {
    chaseStopped: run('chase', telemetry(0)),
    chaseFast: run('chase', telemetry(220, 1)),
    chaseHard: run('chase', hard),
    chaseMoving: runMoving(220),
    cockpitStopped: run('cockpit', telemetry(0)),
    cockpitHard: run('cockpit', hard),
    hoodHard: run('hood', telemetry(200, 1, 0.2)),
  };
  // The dev-panel dials, through the real setter the sliders call.
  game.setVisualParam('shake', 0, false);
  out.shakeOff = run('cockpit', hard);
  game.setVisualParam('shake', 200, false);
  out.shakeDouble = run('cockpit', hard);
  game.setVisualParam('shake', 100, false);
  game.setVisualParam('shakePace', 300, false);
  out.paceTriple = run('cockpit', hard);
  game.setVisualParam('shakePace', 100, false);
  return out;
});

// ---------------------------------------------------------------- chase cam
// Static telemetry must not alter physical distance: speed is communicated by
// a restrained FOV gain instead. More importantly, translating at 220 km/h
// must not add the old 2.6 m world-space smoothing lag.
const growth = sample.chaseFast.distance - sample.chaseStopped.distance;
check('the resting chase camera uses the closer framing',
  sample.chaseStopped.horizontalDistance > 5.75 && sample.chaseStopped.horizontalDistance < 5.85,
  `${sample.chaseStopped.horizontalDistance.toFixed(2)} m behind the car (was 6.20 m)`);
check('speed does not change the chase camera distance', Math.abs(growth) < 0.01,
  `${growth >= 0 ? '+' : ''}${growth.toFixed(3)} m at 220 km/h`);
check('movement does not leave the chase camera behind',
  Math.abs(sample.chaseMoving.endDistance - sample.chaseMoving.startDistance) < 0.02,
  `${sample.chaseMoving.startDistance.toFixed(2)} m -> ${sample.chaseMoving.endDistance.toFixed(2)} m at 220 km/h`);
check('the chase speed FOV remains restrained',
  sample.chaseMoving.fov > 60 && sample.chaseMoving.fov < 65,
  `${sample.chaseMoving.fov.toFixed(1)}° at 220 km/h (the old gain reached 72.5°)`);

// ------------------------------------------------------------------- shake
check('the chase view is dead steady at a standstill', sample.chaseStopped.jitter < 1e-6,
  `${sample.chaseStopped.jitter.toExponential(1)} m/frame · shake ${sample.chaseStopped.shake.toFixed(4)}`);
check('the cockpit is dead steady at a standstill', sample.cockpitStopped.jitter < 1e-6,
  `${sample.cockpitStopped.jitter.toExponential(1)} m/frame · shake ${sample.cockpitStopped.shake.toFixed(4)}`);
check('the cockpit shakes when driving hard', sample.cockpitHard.jitter > 1e-4,
  `${(sample.cockpitHard.jitter * 1000).toFixed(2)} mm/frame · shake ${sample.cockpitHard.shake.toFixed(3)}`);
check('the shake stays small enough to read the road', sample.cockpitHard.jitter < 0.02,
  `${(sample.cockpitHard.jitter * 1000).toFixed(2)} mm/frame`);
// SHAKE_PACE: the amplitude is unchanged, the carrier is slower, so the eye
// moves the same distance over more frames. 18.3 mm/frame was the buzz.
check('and it moves as a stroke rather than a buzz', sample.cockpitHard.jitter < 0.014,
  `${(sample.cockpitHard.jitter * 1000).toFixed(2)} mm/frame (was 18.3 at the old pace)`);
check('the hood camera shakes less than the cockpit',
  sample.hoodHard.shake > 0 && sample.hoodHard.shake < sample.cockpitHard.shake,
  `hood ${sample.hoodHard.shake.toFixed(3)} vs cockpit ${sample.cockpitHard.shake.toFixed(3)}`);
// Same telemetry as cockpitHard, so amplitude and pace compare directly. The
// jitter figure is the largest frame-to-frame eye movement, which carries both:
// the chase view must move both less far and less often.
check('the chase view shakes when driving hard', sample.chaseHard.shake > 0,
  `shake ${sample.chaseHard.shake.toFixed(3)} · ${(sample.chaseHard.jitter * 1000).toFixed(2)} mm/frame`);
check('the chase shake is gentler than the cockpit', sample.chaseHard.shake < sample.cockpitHard.shake,
  `chase ${sample.chaseHard.shake.toFixed(3)} vs cockpit ${sample.cockpitHard.shake.toFixed(3)}`);
check('and moves the eye more slowly', sample.chaseHard.jitter < sample.cockpitHard.jitter * 0.5,
  `chase ${(sample.chaseHard.jitter * 1000).toFixed(2)} vs cockpit ${(sample.cockpitHard.jitter * 1000).toFixed(2)} mm/frame`);

// ------------------------------------------------------------ shake sliders
// Amplitude and pace are separate dials, so each must move its own axis: the
// amplitude one changes how far the eye goes (and can switch the shake off
// outright), the pace one changes how often WITHOUT touching the amplitude.
check('the shake slider can switch the shake off', sample.shakeOff.shake === 0 && sample.shakeOff.jitter < 1e-6,
  `shake ${sample.shakeOff.shake} · ${sample.shakeOff.jitter.toExponential(1)} m/frame`);
check('and doubling it doubles the amplitude', Math.abs(sample.shakeDouble.shake / sample.cockpitHard.shake - 2) < 0.05,
  `${sample.shakeDouble.shake.toFixed(3)} vs ${sample.cockpitHard.shake.toFixed(3)}`);
check('the pace slider speeds the eye up without growing the amplitude',
  sample.paceTriple.jitter > sample.cockpitHard.jitter * 1.8
  && Math.abs(sample.paceTriple.shake - sample.cockpitHard.shake) < 0.01,
  `${(sample.paceTriple.jitter * 1000).toFixed(2)} vs ${(sample.cockpitHard.jitter * 1000).toFixed(2)} mm/frame · shake ${sample.paceTriple.shake.toFixed(3)}`);

check('no console errors during the run', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exitCode = passed === results.length ? 0 : 1;
