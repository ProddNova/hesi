/**
 * Reproduces the "strange big elongated dark shapes when passing over the lit
 * areas" report: parks a low, near-ground camera right on top of the lamp pools
 * on a straight and shoots from a few heights/pitches so the artifact is caught.
 * Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node .devtests/pool-artifact-probe.mjs [tag]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = process.argv[2] || 'now';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
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
const context = await browser.newContext({ viewport: { width: 1000, height: 560 }, deviceScaleFactor: 1.5, hasTouch: true });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(ROOT, 'node_modules/three/build/three.module.js')) });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 30000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });
await page.evaluate(() => window.shutoko.traffic?.setDensity(0));

const shots = [
  { name: 'bank-eye', route: 'k1', frac: 0.06, up: 1.3, back: 6, pitch: -0.1 },
  { name: 'bank-down', route: 'wangan', frac: 0.08, up: 2.4, back: 3, pitch: -0.45 },
  { name: 'curve-low', route: 'c1', frac: 0.62, up: 1.4, back: 7, pitch: -0.12 },
];
for (const s of shots) {
  await page.evaluate((s) => {
    const g = window.shutoko;
    const route = g.map.getRoute(s.route);
    const lane = g.map.sampleLane(s.route, route.length * s.frac, 0, 1);
    g.physics.setPosition(lane.position.x, lane.position.y + 0.6, lane.position.z, lane.heading);
    g.snapDrivingCamera();
    g.setNoclip(true);
    const h = lane.heading, fx = Math.sin(h), fz = Math.cos(h);
    g.debug.position.set(lane.position.x - fx * s.back, lane.position.y + s.up, lane.position.z - fz * s.back);
    g.debug.yaw = h;
    g.debug.pitch = s.pitch;
  }, s);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, `artifact-${TAG}-${s.name}.png`) });
  await page.evaluate(() => window.shutoko.setNoclip(false));
}
console.log('page errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
server.close();
