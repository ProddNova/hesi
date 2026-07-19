/**
 * Close top-down plan shots of the Tatsumi PA deck for line/marking QA.
 *  1. plan-full   — whole deck from above.
 *  2. plan-entry  — entry half close-up.
 *  3. plan-exit   — exit half close-up.
 *  4. plan-walls  — oblique on the deck edge walls.
 *
 * Run: node .devtests/tatsumi-pa-topdown-shots.mjs [suffix] [--case=name]
 * Writes .devtests/shots/PLAN-<case>[-suffix].png
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
const context = await browser.newContext({ viewport: { width: 1200, height: 500 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
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
await page.evaluate(() => {
  const g = window.shutoko;
  (g.traffic?.pool || []).forEach((v) => { if (v.mesh) v.mesh.visible = false; });
});

const shoot = async (name) => {
  await page.screenshot({ path: join(OUT, `PLAN-${name}${SUFFIX}.png`) });
  console.log(`shot PLAN-${name}${SUFFIX}.png`);
};
const want = (name) => !ONLY || ONLY === name;

const place = async (spec) => {
  const setup = await page.evaluate((s) => {
    const g = window.shutoko;
    const area = (g.map.serviceAreas || []).find((candidate) => candidate.id === 'tatsumi_pa');
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

if (want('plan-full')) {
  await place({ u: 0, v: 0, up: 120, yaw: Math.PI * 0.5, pitch: -Math.PI * 0.5 + 0.001 });
  await shoot('plan-full');
}
if (want('plan-entry')) {
  await place({ u: -60, v: 0, up: 70, yaw: Math.PI * 0.5, pitch: -Math.PI * 0.5 + 0.001 });
  await shoot('plan-entry');
}
if (want('plan-exit')) {
  await place({ u: 60, v: 0, up: 70, yaw: Math.PI * 0.5, pitch: -Math.PI * 0.5 + 0.001 });
  await shoot('plan-exit');
}
if (want('plan-walls')) {
  await place({ u: -40, v: 30, up: 14, yaw: Math.PI * 0.72, pitch: -0.3 });
  await shoot('plan-walls');
}
if (want('barrier-close')) {
  // On the aisle looking at the far-side parapet from ~12 m.
  await place({ u: 30, v: 0, up: 1.6, yaw: Math.PI * 0.5, pitch: -0.04 });
  await shoot('barrier-close');
}
if (want('barrier-end')) {
  // Looking along the deck end wall from just outside the exit gate.
  await place({ u: 101, v: -6, up: 3, yaw: Math.PI, pitch: -0.1 });
  await shoot('barrier-end');
}

await browser.close();
server.close();
