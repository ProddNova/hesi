/**
 * Screenshots of the Ramp 8 emergency lay-by, from the air and from the deck.
 * Run: node .devtests/layby-shots.mjs [tag]   ->  .devtests/shots/layby-*.png
 *
 * NOTE the SPLIT cdn routing below: the game imports both `three` and
 * `three/addons/utils/BufferGeometryUtils.js`, so a blanket jsdelivr route
 * hands the addon path the core bundle and the page dies on mergeGeometries.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = process.argv[2] || 'after';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/json' };

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(ROOT, decodeURIComponent(file)));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1.5, hasTouch: true });
// Playwright consults route handlers in REVERSE registration order, so the
// addon handler must be registered LAST to win over the core-bundle catch-all.
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
await context.route('https://cdn.jsdelivr.net/**/examples/jsm/**', async (route) => {
  const rest = route.request().url().split('/examples/jsm/')[1];
  const body = await readFile(join(ROOT, 'node_modules/three/examples/jsm', rest));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
await page.goto(`http://127.0.0.1:${port}/`);
try {
  await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });
} catch (error) {
  console.log('boot failed:', errors.slice(0, 8));
  throw error;
}
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 15000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 10000 });

const layby = await page.evaluate(() => {
  const route = window.shutoko.map.getRoute('ramp_8');
  const bay = route.laybys?.[0];
  return bay ? { start: bay.start, end: bay.end, taperIn: bay.taperIn, taperOut: bay.taperOut, side: bay.side } : null;
});
if (!layby) { console.log('FAIL: no lay-by registered on ramp_8'); await browser.close(); server.close(); process.exit(1); }
const mid = (layby.start + layby.taperIn + layby.end - layby.taperOut) / 2;
console.log(`lay-by span ${layby.start}..${layby.end} m, bay centre s=${mid}`);

const shots = [
  // near-nadir: the plan shape of the bay (bulge + both tapers) in one frame
  { name: 'plan', at: mid, up: 150, back: 12, pitch: -1.45, lateral: 11 },
  { name: 'oblique', at: mid, up: 15, back: 46, pitch: -0.30, lateral: 5.9 },
  { name: 'approach', at: layby.start - 48, up: 2.4, back: 11, pitch: -0.06 },
  { name: 'parked', at: mid, up: 1.6, back: 16, pitch: -0.04, lateral: 5.9 },
];
for (const shot of shots) {
  await page.evaluate(async (s) => {
    const g = window.shutoko;
    const map = g.map;
    const sample = map.sampleLane('ramp_8', s.at, 0, 1);
    const position = sample.position.clone();
    if (s.lateral) position.addScaledVector(sample.normal, s.lateral);
    // Park the car itself in/near the bay so the shots show a real stop.
    g.physics.setPosition(position.x, position.y + 0.6, position.z, sample.heading);
    g.physics.setSpeed(0);
    g.snapDrivingCamera();
    g.setNoclip(true);
    const heading = sample.heading;
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    g.debug.position.set(position.x - fx * s.back, position.y + s.up, position.z - fz * s.back);
    g.debug.yaw = heading;
    g.debug.pitch = s.pitch;
  }, shot);
  await page.waitForTimeout(1600);
  const file = join(OUT, `layby-${shot.name}-${TAG}.png`);
  await page.screenshot({ path: file });
  console.log('shot', file);
}
if (errors.length) console.log('page errors:', errors.slice(0, 4));
await browser.close();
server.close();
