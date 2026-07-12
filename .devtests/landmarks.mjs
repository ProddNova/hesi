/**
 * Screenshots the landmark locations on the rebuilt map and probes renderer
 * load (draw calls / triangles) at 1x and 3x traffic density.
 * Run: CHROMIUM_PATH=... node .devtests/landmarks.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, '.devtests', 'shots');
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
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });

const spots = [
  { name: 'shibaura-pa', route: 'c1', probe: null, pa: 'shibaura_pa' },
  { name: 'rainbow-bridge', route: 'r11', frac: 0.45 },
  { name: 'wangan-straight', route: 'wangan', frac: 0.2 },
  { name: 'port-tunnel', route: 'wangan', frac: 0.44 },
  { name: 'daikoku-approach', route: 'dj', frac: 0.15 },
  { name: 'daikoku-pa', pa: 'daikoku_pa' },
  { name: 'yaesu-tunnel', route: 'c1', frac: 0.86 },
  { name: 'k1-industrial', route: 'k1', frac: 0.5 },
];
for (const spot of spots) {
  await page.evaluate((s) => {
    const g = window.shutoko;
    if (s.pa && !s.route) {
      const area = g.map.serviceAreas.find((a) => a.id === s.pa);
      const p = area.center.clone().addScaledVector(area.tangent, -area.length * 0.3);
      g.physics.setPosition(p.x, area.elevation + 0.6, p.z, Math.atan2(area.tangent.x, area.tangent.z));
    } else {
      const route = g.map.getRoute(s.route);
      const d = s.pa ? g.map.serviceAreas.find((a) => a.id === s.pa).mainDistance : route.length * s.frac;
      const lane = g.map.sampleLane(s.route, d, 0, 1);
      g.physics.setPosition(lane.position.x, lane.position.y + 0.6, lane.position.z, lane.heading);
    }
    g.physics.setSpeed(24);
    g.snapDrivingCamera();
  }, spot);
  await page.waitForTimeout(1400);
  await page.screenshot({ path: join(OUT, `L-${spot.name}.png`) });
}

const probe = () => page.evaluate(() => {
  const g = window.shutoko;
  const info = g.renderer.info;
  return {
    calls: info.render.calls, triangles: info.render.triangles,
    geometries: info.memory.geometries, textures: info.memory.textures,
    traffic: g.traffic?.activeCount ?? 0,
  };
});
await page.evaluate(() => { const g = window.shutoko; g.physics.setSpeed(30); });
await page.waitForTimeout(2500);
console.log('density 1x:', JSON.stringify(await probe()));
await page.evaluate(() => window.shutoko.traffic.setDensity(3));
await page.waitForTimeout(6000);
console.log('density 3x:', JSON.stringify(await probe()));
console.log('page errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
server.close();
