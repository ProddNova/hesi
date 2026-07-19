/**
 * Deterministic close-ups of the Tatsumi No.1 PA dressing (real-world lot:
 * perpendicular stalls, toilet block, vending row, smoking corner, poles,
 * signage, painted one-way flow). All cameras derive from the runtime
 * service-area record, so before/after runs frame identical spots.
 *
 *  1. lot-overview    — low oblique down the whole lot from the entry end.
 *  2. stall-row       — the far-side perpendicular stalls with backed-in cars.
 *  3. truck-row       — the 17-stall large-vehicle diagonal row (ramp side).
 *  4. toilets-vending — toilet block, walkway, vending row, smoking corner.
 *  5. ring-forecourt  — the garage ENTER ring in the entry gore.
 *  6. entry-signage   — PA name + P signs as the entry lane sees them.
 *  7. exit-signage    — EXIT sign and the exit wedge zebra.
 *
 * Run: CHROMIUM_PATH=... node .devtests/tatsumi-pa-dressing-shots.mjs [suffix] [--case=name]
 * Writes .devtests/shots/DRESS-<case>[-suffix].png
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const suffixArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const SUFFIX = suffixArg ? `-${suffixArg}` : '';
const onlyArg = process.argv.slice(2).find((arg) => arg.startsWith('--case='));
const ONLY = onlyArg ? onlyArg.slice(7) : null;
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
page.on('pageerror', (error) => console.error('pageerror:', String(error)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });

// Hide traffic so the dressing shots stay deterministic.
await page.evaluate(() => {
  const g = window.shutoko;
  (g.traffic?.pool || []).forEach((v) => { if (v.mesh) v.mesh.visible = false; });
});

const shoot = async (name) => {
  await page.screenshot({ path: join(OUT, `DRESS-${name}${SUFFIX}.png`) });
  console.log(`shot DRESS-${name}${SUFFIX}.png`);
};
const want = (name) => !ONLY || ONLY === name;

// Deck-frame camera: u along the one-way flow, v across (aisle side < 0
// when aisleV < 0), yaw relative to the deck heading.
const place = async (spec) => {
  const setup = await page.evaluate((s) => {
    const g = window.shutoko;
    const map = g.map;
    const area = (map.serviceAreas || []).find((candidate) => candidate.id === 'tatsumi_pa');
    if (!area) return null;
    if (!g.debug.noclip) g.setNoclip(true);
    const heading = Math.atan2(area.tangent.x, area.tangent.z);
    const position = area.center.clone()
      .addScaledVector(area.tangent, s.u || 0)
      .addScaledVector(area.normal, s.v || 0);
    position.y = area.elevation + (s.up || 0);
    return { position: { x: position.x, y: position.y, z: position.z }, yaw: heading + (s.yaw || 0) };
  }, spec);
  if (!setup) throw new Error('tatsumi area missing');
  await page.evaluate(({ s, p }) => {
    const g = window.shutoko;
    g.debug.position.set(s.position.x, s.position.y, s.position.z);
    g.debug.yaw = s.yaw;
    g.debug.pitch = p;
  }, { s: setup, p: spec.pitch || 0 });
  await page.waitForTimeout(900);
};

// The live deck's large-vehicle row backs onto the ramp_8 side; mirror the
// cameras if a future re-fit flips it.
const rampSign = await page.evaluate(() => {
  const area = window.shutoko.map.serviceAreas.find((candidate) => candidate.id === 'tatsumi_pa');
  return area?.rampSideSign ?? (Math.sign(area?.aisleV ?? -1) || -1);
});
const v = (value) => value * -rampSign; // positive = far side (small stalls, toilets)

if (want('lot-overview')) {
  await place({ u: -112, v: v(1), up: 20, yaw: 0.04, pitch: -0.2 });
  await shoot('lot-overview');
}
if (want('stall-row')) {
  await place({ u: -30, v: v(-1), up: 4.2, yaw: 0.62 * rampSign, pitch: -0.16 });
  await shoot('stall-row');
}
if (want('truck-row')) {
  await place({ u: -12, v: v(3), up: 5.5, yaw: -0.75 * rampSign, pitch: -0.15 });
  await shoot('truck-row');
}
if (want('toilets-vending')) {
  await place({ u: 12, v: v(-2), up: 5, yaw: 0.55 * rampSign, pitch: -0.12 });
  await shoot('toilets-vending');
}
if (want('ring-forecourt')) {
  await place({ u: -62, v: v(0), up: 6, yaw: 0.4 * rampSign - Math.PI, pitch: -0.2 });
  await shoot('ring-forecourt');
}
if (want('entry-signage')) {
  await place({ u: -108, v: v(0), up: 2.6, yaw: 0, pitch: -0.02 });
  await shoot('entry-signage');
}
if (want('exit-signage')) {
  await place({ u: 58, v: v(-2), up: 2.6, yaw: 0, pitch: -0.03 });
  await shoot('exit-signage');
}

await browser.close();
server.close();
