/**
 * Style-pass screenshot set: noclip drone views of the locations the visual
 * overhaul targets (industrial yards, lamp pools, elevated overview, barrier
 * close-up). Complements landmarks.mjs' chase-camera set.
 * Run: CHROMIUM_PATH=... node .devtests/style-shots.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots', 'style');
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
await page.evaluate(() => window.shutoko.setNoclip(true));

const spots = [
  { name: 'k1-industrial-yards', route: 'k1', frac: 0.5, lateral: 120, up: 70, lookDown: 0.62, across: true },
  { name: 'k1-industrial-yards-b', route: 'k1', frac: 0.35, lateral: -110, up: 65, lookDown: 0.6, across: true },
  { name: 'elevated-overview', route: 'c1', frac: 0.38, lateral: -90, up: 90, lookDown: 0.52, across: true },
  { name: 'lamp-pools', route: 'wangan', frac: 0.2, lateral: 0, up: 7, lookDown: 0.1 },
  { name: 'barrier-closeup', route: 'r11', frac: 0.45, lateral: -3, up: 2.2, lookDown: 0.06 },
  { name: 'skyline-wide', route: 'r11', frac: 0.52, lateral: 60, up: 34, lookDown: 0.14, across: true },
];
for (const spot of spots) {
  await page.evaluate((s) => {
    const g = window.shutoko;
    const route = g.map.getRoute(s.route);
    const lane = g.map.sampleLane(s.route, route.length * s.frac, 0, 1);
    const normal = { x: lane.tangent.z, z: -lane.tangent.x };
    const p = {
      x: lane.position.x + normal.x * s.lateral,
      y: lane.position.y + s.up,
      z: lane.position.z + normal.z * s.lateral,
    };
    g.debug.position.set(p.x, p.y, p.z);
    const target = s.across
      ? { x: lane.position.x, z: lane.position.z }
      : { x: lane.position.x + lane.tangent.x * 60, z: lane.position.z + lane.tangent.z * 60 };
    g.debug.yaw = Math.atan2(target.x - p.x, target.z - p.z);
    g.debug.pitch = -s.lookDown;
    g.map._visibleKey = null;
  }, spot);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, `S-${spot.name}.png`) });
}
console.log('page errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
server.close();
