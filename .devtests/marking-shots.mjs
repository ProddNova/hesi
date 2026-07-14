/**
 * Visual check for the road-surface/markings frame pass: noclip camera
 * screenshots of sloped + curved sections where markings used to step,
 * float or disconnect. Run: CHROMIUM_PATH=... node .devtests/marking-shots.mjs [suffix]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, '.devtests', 'shots');
const SUFFIX = process.argv[2] ? `-${process.argv[2]}` : '';
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
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 30000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });

// route + distance chosen for slope/curve severity; camera hovers behind/above
const spots = [
  { name: 'ramp17-dive', route: 'ramp_17', d: 110, back: 26, up: 7, pitch: -0.3 },   // Namamugi dive: data steps + grade
  { name: 'rainbow-ascent', route: 'r11_1', frac: 0.18, back: 30, up: 8, pitch: -0.26 }, // bridge climb
  { name: 'c1-curve', route: 'c1_0', frac: 0.62, back: 26, up: 9, pitch: -0.33 },     // tight loop bend
  { name: 'k5-sbend', route: 'r6_3', d: 1805, back: 30, up: 8, pitch: -0.3 },         // old bank-flip inflection
  { name: 'wangan-dashes', route: 'wangan_1', frac: 0.22, back: 24, up: 5.5, pitch: -0.22 },
];
for (const spot of spots) {
  const missing = await page.evaluate((s) => {
    const g = window.shutoko;
    let route;
    try { route = g.map.getRoute(s.route); } catch { return s.route; }
    const d = s.d ?? route.length * s.frac;
    const lane = g.map.sampleLane(route.id, d, 0, 1);
    g.setNoclip(true);
    g.debug.position.copy(lane.position)
      .addScaledVector(lane.tangent, -s.back)
      .add(new g.debug.position.constructor(0, s.up, 0));
    g.debug.yaw = Math.atan2(lane.tangent.x, lane.tangent.z);
    g.debug.pitch = s.pitch;
    return null;
  }, spot);
  if (missing) { console.log(`SKIP ${spot.name}: no route ${missing}`); continue; }
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `M-${spot.name}${SUFFIX}.png`) });
  console.log(`shot M-${spot.name}${SUFFIX}.png`);
}
await browser.close();
server.close();
