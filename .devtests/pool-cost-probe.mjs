/**
 * Noise-free isolation of the lamp-pool fill cost. Parks a fixed drone camera
 * over a lamp-heavy straight, then times renderer.render() for many frames with
 * the additive pool/streak layer VISIBLE vs HIDDEN in the same session — so the
 * only variable is the overdraw of those planes. Prints the per-frame delta.
 * Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node .devtests/pool-cost-probe.mjs
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
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(ROOT, 'node_modules/three/build/three.module.js')) });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 30000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });

const result = await page.evaluate(async () => {
  const g = window.shutoko;
  const route = g.map.getRoute('wangan');
  const lane = g.map.sampleLane('wangan', route.length * 0.2, 0, 1);
  g.physics.setPosition(lane.position.x, lane.position.y + 0.6, lane.position.z, lane.heading);
  g.setNoclip(true);
  const h = lane.heading, fx = Math.sin(h), fz = Math.cos(h);
  g.debug.position.set(lane.position.x - fx * 12, lane.position.y + 3.2, lane.position.z - fz * 12);
  g.debug.yaw = h; g.debug.pitch = -0.12;

  // Collect the additive pool/streak instanced meshes currently in the scene.
  const pools = [];
  g.roadScene.traverse((o) => { if (o.name && /pool:light(Pool|Streak)/.test(o.name)) pools.push(o); });

  const frame = () => new Promise((res) => requestAnimationFrame(() => res()));
  const time = async (n, visible) => {
    for (const m of pools) m.visible = visible;
    for (let i = 0; i < 12; i++) await frame();                 // settle
    const t = [];
    for (let i = 0; i < n; i++) {
      const a = performance.now();
      g.renderer.render(g.roadScene, g.camera);
      t.push(performance.now() - a);
    }
    t.sort((x, y) => x - y);
    return { p50: t[Math.floor(n * 0.5)], mean: t.reduce((s, v) => s + v, 0) / n };
  };
  // Interleave ON/OFF a few times to average out drift.
  const on = [], off = [];
  for (let k = 0; k < 4; k++) { on.push(await time(40, true)); off.push(await time(40, false)); }
  const avg = (a, key) => a.reduce((s, v) => s + v[key], 0) / a.length;
  return {
    poolMeshes: pools.length,
    onP50: +avg(on, 'p50').toFixed(2), offP50: +avg(off, 'p50').toFixed(2),
    onMean: +avg(on, 'mean').toFixed(2), offMean: +avg(off, 'mean').toFixed(2),
  };
});
console.log(JSON.stringify(result, null, 2));
console.log(`pool layer marginal render cost: p50 +${(result.onP50 - result.offP50).toFixed(2)} ms, mean +${(result.onMean - result.offMean).toFixed(2)} ms  (SwiftShader CPU raster; real GPU far cheaper)`);
await browser.close();
server.close();
