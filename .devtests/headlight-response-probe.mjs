/**
 * Headlight-response probe.
 *
 * The reported bug: lowering the player headlight brightness did not change how
 * brightly the traffic ahead was lit — the cars read as "lit by a powerful
 * light" at every setting. The cause is exposure, not the traffic system. The
 * beam is aimed as a nearly horizontal pencil (lamp 0.6 m up, aimed at 0.1 m
 * thirty metres out), so it barely grazes the road but lands square on whatever
 * is in the lane ahead; at the authored 650 cd that surface receives several
 * times the night scene's white point, clips, and the dial can then only move a
 * part of the range that is already off the top of the picture. game.js scales
 * the beam back into the exposed range (HEADLIGHT_BEAM_CALIBRATION) and exposes
 * a live multiplier in the dev panel.
 *
 * The measurement is a car-rear stand-in: a Lambert panel with the traffic
 * body's own colour and emissive floor, parked nine metres up the lane and
 * facing the player. Real traffic is frozen out of the way, because "whatever
 * happened to drive past" is not a measurement.
 *
 * Run: node .devtests/headlight-response-probe.mjs
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, '.devtests', 'shots');
await mkdir(SHOTS, { recursive: true });
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.obj': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg',
};
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.166.1/build/three.module.js';

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
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 45000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 45000 });
await page.evaluate(() => {
  window.shutoko.setTrafficDisabled(true);
  // The adaptive render-scale governor reallocates the drawing buffer, which
  // clears the canvas � a read landing on that frame comes back black.
  window.shutoko.performanceProfile.adaptiveResolution = false;
  window.shutoko.headlightsOn = true;
  window.shutoko._applyHeadlightState();
  // Tape grain would add noise to a luma measurement.
  window.shutoko.changeSetting('vhs', false);
});
await page.waitForTimeout(2500);

// The stand-in car rear, plus the screen rectangle it occupies.
await page.evaluate(async ({ threeUrl }) => {
  const THREE = await import(threeUrl);
  const game = window.shutoko;
  const state = game.getVehicleState();
  const p = state.position || state;
  const heading = state.heading ?? 0;
  const ahead = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
  const centre = new THREE.Vector3(p.x, p.y + 0.75, p.z).addScaledVector(ahead, 9);
  // Same paint and emissive floor as js/traffic.js makeTrafficMesh.
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(1.8, 1.3),
    new THREE.MeshLambertMaterial({
      color: 0xb9c0c9, emissive: 0xb9c0c9, emissiveIntensity: 0.18, flatShading: true,
    }),
  );
  panel.name = 'probe-car-rear';
  panel.position.copy(centre);
  panel.lookAt(p.x, p.y + 0.75, p.z);
  panel.frustumCulled = false;
  // roadScene runs with matrixWorldAutoUpdate off; stamp the matrix once.
  panel.updateMatrixWorld(true);
  game.roadScene.add(panel);
  window.__probePanel = panel;
  // An idling automatic creeps, which would move the panel across the frame and
  // change its distance between readings. Stopping the clock (timeScale is
  // multiplied into dt, and 0 would be read as "unset") freezes the car, the
  // camera and the world for the whole ladder, so every sample sees the same
  // geometry and only the beam changes.
  game.admin.timeScale = 1e-4;
  game.snapDrivingCamera();
  return { at: [centre.x, centre.y, centre.z] };
}, { threeUrl: THREE_URL });
await page.waitForTimeout(600);

/**
 * Mean luma of the panel's middle, read straight off the presented canvas. The
 * panel is re-projected every time so the sample window cannot drift off it.
 */
const panelLuma = () => page.evaluate(() => new Promise((done) => {
  const game = window.shutoko;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const source = game.renderer.domElement;
    const ndc = window.__probePanel.position.clone().project(game.camera);
    const x = Math.round((ndc.x * 0.5 + 0.5) * source.width);
    const y = Math.round((-ndc.y * 0.5 + 0.5) * source.height);
    const half = 12;
    // A reading from outside the frame is not a dark panel, it is a miss.
    const ok = ndc.z < 1 && x >= half && y >= half
      && x <= source.width - half && y <= source.height - half;
    if (!ok) { done({ luma: null, x, y, ok }); return; }
    const scratch = document.createElement('canvas');
    scratch.width = source.width; scratch.height = source.height;
    const ctx = scratch.getContext('2d');
    ctx.drawImage(source, 0, 0);
    const { data } = ctx.getImageData(x - half, y - half, half * 2, half * 2);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    const luma = sum / (data.length / 4);
    // The panel keeps the ambient fill even with the beam at zero, so a pure
    // black sample is a cleared canvas, not a measurement.
    done({ luma, x, y, ok: luma > 1 });
  }));
}));

// Drive the light directly so the ladder can include the pre-calibration level,
// which is above what the dev-panel multiplier can reach.
const atBeam = async (candela) => {
  await page.evaluate((cd) => {
    const light = window.shutoko.playerHeadlights[0];
    light.intensity = cd;
  }, candela);
  await page.waitForTimeout(260);
  // The camera settles over a couple of frames after the pose is pinned, so a
  // first read can land outside the frame. Retry rather than record a miss.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const read = await panelLuma();
    if (read.ok) return read.luma;
    await page.waitForTimeout(200);
  }
  throw new Error(`panel never landed on screen at ${candela} cd`);
};

const authored = await page.evaluate(() => window.shutoko.playerHeadlights[0].userData.authoredIntensity);
const calibrated = await page.evaluate(() => window.shutoko._headlightBeamIntensity(window.shutoko.playerHeadlights[0]));
const dark = await atBeam(0);
const oldFull = await atBeam(authored);
const oldHalf = await atBeam(authored / 2);
const newFull = await atBeam(calibrated);
const newHalf = await atBeam(calibrated / 2);
await page.evaluate(() => window.shutoko._applyHeadlightState());
await page.waitForTimeout(300);
await page.screenshot({ path: join(SHOTS, 'headlight-response.png') });
await page.evaluate(() => { window.__probePanel?.removeFromParent(); window.shutoko.admin.timeScale = 1; });

console.log(`panel luma · off ${dark.toFixed(1)} · old ${authored}cd ${oldFull.toFixed(1)}`
  + ` / half ${oldHalf.toFixed(1)} · new ${calibrated.toFixed(0)}cd ${newFull.toFixed(1)} / half ${newHalf.toFixed(1)}`);

check('the calibration is the authored value scaled, not replaced',
  Math.abs(calibrated - authored * 0.26) < 0.5, `${authored} cd → ${calibrated.toFixed(1)} cd`);
check('the car rear is lit at all', newFull - dark > 4,
  `${dark.toFixed(1)} unlit → ${newFull.toFixed(1)} lit (of 255)`);
// The bug, measured. What matters is how much of the picture a doubling of the
// beam buys, relative to the brightness already there: at the authored level the
// panel sits at 220/255 and doubling the light moves it 12 — about 5%, which is
// the "nothing changes" the report describes. Calibrated, the same doubling is
// worth three times as much.
const oldStep = (oldFull - oldHalf) / oldFull;
const newStep = (newFull - newHalf) / newFull;
check('the authored beam clipped (halving it barely showed)', oldStep < 0.08,
  `${oldHalf.toFixed(1)} → ${oldFull.toFixed(1)}/255 = ${(oldStep * 100).toFixed(1)}% for 2× the light`);
check('the calibrated beam reads on the dial', newStep > 0.12,
  `${newHalf.toFixed(1)} → ${newFull.toFixed(1)}/255 = ${(newStep * 100).toFixed(1)}% for 2× the light`);
check('and reads several times better than before', newStep > oldStep * 2,
  `${(newStep * 100).toFixed(1)}% vs ${(oldStep * 100).toFixed(1)}% per doubling`);
check('the dev-panel multiplier reaches the light', calibrated > 0
  && await page.evaluate(() => {
    const game = window.shutoko;
    game.setVisualParam('headlight', 40);
    const dim = game.playerHeadlights[0].intensity;
    game.setVisualParam('headlight', 100);
    const full = game.playerHeadlights[0].intensity;
    return Math.abs(dim - full * 0.4) < 0.5 && full > 0;
  }), 'setVisualParam("headlight") scales the live beam');
check('no console errors during the run', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed · shots in .devtests/shots/`);
process.exitCode = passed === results.length ? 0 : 1;
