/**
 * Post-pipeline-aware render load probe: accumulates renderer.info across ALL
 * passes in a frame (the retro post pipeline issues several render calls, so
 * the plain per-call info undercounts). Samples frame timing at the
 * k1-industrial landmark with density-1 traffic, like landmarks.mjs.
 * Run: CHROMIUM_PATH=... node .devtests/style-perf.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const body = await readFile(join(ROOT, path === '/' ? '/index.html' : path));
    res.writeHead(200, { 'content-type': MIME[extname(path === '/' ? '/index.html' : path)] || 'application/octet-stream' });
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
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 30000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 15000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });

await page.evaluate(() => {
  const g = window.shutoko;
  const route = g.map.getRoute('k1');
  const lane = g.map.sampleLane('k1', route.length * 0.5, 0, 1);
  g.physics.setPosition(lane.position.x, lane.position.y + 0.6, lane.position.z, lane.heading);
  g.physics.setSpeed(30);
  g.snapDrivingCamera();
  // Accumulate info across every pass of the frame.
  g.renderer.info.autoReset = false;
  const original = g.render.bind(g);
  g.__frameStats = { calls: 0, triangles: 0 };
  g.render = () => {
    g.renderer.info.reset();
    original();
    g.__frameStats = { calls: g.renderer.info.render.calls, triangles: g.renderer.info.render.triangles };
  };
});
await page.waitForTimeout(2500);
const frames = await page.evaluate(() => new Promise((resolve) => {
  const samples = [];
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    samples.push(now - last);
    last = now;
    if (samples.length < 240) requestAnimationFrame(tick);
    else resolve(samples.slice(30));
  };
  requestAnimationFrame(tick);
}));
frames.sort((a, b) => a - b);
const pct = (f) => frames[Math.floor(frames.length * f)].toFixed(2);
const stats = await page.evaluate(() => ({
  ...window.shutoko.__frameStats,
  geometries: window.shutoko.renderer.info.memory.geometries,
  textures: window.shutoko.renderer.info.memory.textures,
  traffic: window.shutoko.traffic?.activeCount ?? 0,
  resolution: [window.shutoko.canvas.width, window.shutoko.canvas.height],
}));
console.log('per-frame (all passes):', JSON.stringify(stats));
console.log(`frame ms mean=${(frames.reduce((s, v) => s + v, 0) / frames.length).toFixed(2)} p50=${pct(0.5)} p95=${pct(0.95)}`);
console.log('page errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
server.close();
