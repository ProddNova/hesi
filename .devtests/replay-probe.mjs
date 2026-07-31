/**
 * Replay system smoke test (REPLAY // 3, editorTest only).
 * Records a few seconds of driving, saves, plays back with hitboxes and
 * camera cycling, then exits playback. Fails on any page error.
 * Run: node .devtests/replay-probe.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

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

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const context = await browser.newContext({ viewport: { width: 1100, height: 620 } });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const url = route.request().url();
  const addon = url.match(/\/examples\/jsm\/(.+)$/);
  const local = addon ? join(ROOT, 'node_modules/three/examples/jsm', addon[1]) : join(ROOT, 'node_modules/three/build/three.module.js');
  const body = await readFile(local);
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
const check = (cond, msg) => { if (!cond) fail(msg); else console.log(`ok: ${msg}`); };

await page.goto(`http://127.0.0.1:${port}/?editorTest=1`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 30000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });

// Menu key "3" only exists in editorTest.
await page.keyboard.press('3');
await page.waitForTimeout(150);
check(await page.evaluate(() => window.shutoko.replay.menuOpen) === true, '3 opens the replay menu');
check(await page.evaluate(() => !document.getElementById('replay-menu').classList.contains('hidden')), 'replay panel visible');
await page.keyboard.press('3');
await page.waitForTimeout(150);
check(await page.evaluate(() => window.shutoko.replay.menuOpen) === false, '3 closes the replay menu');

// Record while teleporting the car along a path (headless Chromium renders
// ~2 fps, so real driving covers no distance; teleports create the path).
await page.evaluate(() => { window.shutoko.traffic?.setDensity(2); window.shutoko.replay.startRecording(); });
check(await page.evaluate(() => window.shutoko.replay.recording), 'recording started');
for (let i = 1; i <= 10; i += 1) {
  await page.evaluate((step) => {
    const g = window.shutoko;
    const s = g.getVehicleState();
    const h = s.heading ?? 0;
    g.physics.setPosition(s.position.x + Math.sin(h) * 8 * step / step, s.position.y, s.position.z + Math.cos(h) * 8, h);
  }, i);
  await page.waitForTimeout(650);
}
const clipInfo = await page.evaluate(() => {
  const clip = window.shutoko.replay.stopRecording();
  return clip ? { frames: clip.frames.length, duration: clip.duration, scene: clip.scene, trafficCars: Object.keys(clip.carTypes).length } : null;
});
check(!!clipInfo, 'recording stopped, clip produced');
console.log('  clip:', JSON.stringify(clipInfo));
check(clipInfo && clipInfo.frames >= 6, `enough frames (${clipInfo?.frames}) — headless renders ~2 fps`);
check(clipInfo && clipInfo.duration > 2, `duration recorded (${clipInfo?.duration?.toFixed(1)}s)`);

// Save to localStorage.
await page.evaluate(() => { window.shutoko.replay.saveClip(window.shutoko.replay.lastClip); window.shutoko.replay.lastClip = null; });
check(await page.evaluate(() => window.shutoko.replay.clips.length) === 1, 'clip saved to store');
check(await page.evaluate(() => !!localStorage.getItem('shutoko-nights.replays.v1')), 'localStorage written');

// Playback.
const before = await page.evaluate(() => { const g = window.shutoko; const s = g.getVehicleState(); return { x: s.position.x, z: s.position.z }; });
await page.evaluate(() => window.shutoko.replay.startPlayback(window.shutoko.replay.clips[0]));
check(await page.evaluate(() => window.shutoko.replay.playing), 'playback started');
check(await page.evaluate(() => window.shutoko.debug.hitboxes.vehicles), 'vehicle hitboxes auto-enabled in playback');
check(await page.evaluate(() => !document.getElementById('replay-hud').classList.contains('hidden')), 'playback HUD bar visible');
await page.waitForTimeout(2500);
const during = await page.evaluate(() => {
  const g = window.shutoko;
  const s = g.getVehicleState();
  return { x: s.position.x, z: s.position.z, time: g.replay.playback.time, ghosts: g.replay.playback.ghosts.size };
});
console.log('  playback:', JSON.stringify(during));
check(during.time > 0.1, `playback time advancing (${during.time.toFixed(2)}s) — headless renders ~2 fps`);
check(Math.hypot(during.x - before.x, during.z - before.z) > 0.5, 'car follows the recorded path');
check(await page.evaluate(() => window.shutoko.mode) === 'driving', 'mode stays driving during playback');

// Cameras + pause + scrub.
await page.keyboard.press('c');
await page.waitForTimeout(120);
check(await page.evaluate(() => window.shutoko.replay.playback.cam) === 'orbit', 'C cycles to orbit camera');
await page.keyboard.press('c');
await page.keyboard.press('c');
await page.waitForTimeout(120);
check(await page.evaluate(() => window.shutoko.replay.playback.cam) === 'fly', 'C cycles to fly camera');
await page.keyboard.press('c');
await page.keyboard.press(' '); // pause
await page.waitForTimeout(300);
const t1 = await page.evaluate(() => window.shutoko.replay.playback.time);
await page.waitForTimeout(400);
const t2 = await page.evaluate(() => window.shutoko.replay.playback.time);
check(Math.abs(t2 - t1) < 0.01, 'space pauses playback');
await page.keyboard.press('.'); // frame step
await page.waitForTimeout(120);
check(await page.evaluate(() => window.shutoko.replay.playback.paused), 'frame step keeps pause');
await page.evaluate(() => window.shutoko.replay.seek(-2));

// Exit playback: position restored, hitboxes restored, traffic cleared.
await page.evaluate(() => window.shutoko.replay.stopPlayback());
check(await page.evaluate(() => !window.shutoko.replay.playing), 'playback stopped');
check(await page.evaluate(() => !window.shutoko.debug.hitboxes.vehicles), 'hitboxes restored to pre-playback state');
const after = await page.evaluate(() => { const s = window.shutoko.getVehicleState(); return { x: s.position.x, z: s.position.z }; });
check(Math.hypot(after.x - before.x, after.z - before.z) < 2, 'player restored to pre-playback position');

// Delete the clip, verify store empties.
await page.evaluate(() => window.shutoko.replay.deleteClip(window.shutoko.replay.clips[0].id));
check(await page.evaluate(() => window.shutoko.replay.clips.length) === 0, 'clip deleted');

const fatal = errors.filter((e) => !/favicon|net::|Failed to load resource/i.test(e));
if (fatal.length) { console.error('PAGE ERRORS:'); for (const e of fatal) console.error(' -', e); process.exitCode = 1; }
else console.log('ok: no page errors');

await browser.close();
server.close();
console.log(process.exitCode ? 'REPLAY PROBE FAILED' : 'REPLAY PROBE PASSED');
