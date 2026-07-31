/**
 * Reference shots of the WALKABLE Tatsumi No.1 PA (js/tatsumi-pa-lot.js), the
 * scene you arrive in through the lay-by gate. Framed to match the
 * photographs the layout was built from.
 *
 *  1. pa-spawn     — exactly what you see when you get out of the car.
 *  2. pa-building  — the arched canopy, vending row and glass-block wall.
 *  3. pa-comb      — the 45° large-vehicle comb with the box trucks.
 *  4. pa-small     — the 小型 row.
 *  5. pa-gate      — looking back at the way out.
 *  6. pa-plan      — the whole lot from above (layout check).
 *
 * Run: node .devtests/tatsumi-pa-lot-shots.mjs [suffix] [--case=name]
 * Writes .devtests/shots/PALOT-<case>[-suffix].png
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
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  // The whole three package, not just the core build: js/custom-assets.js
  // imports three/addons/utils/BufferGeometryUtils.js.
  const rel = new URL(route.request().url()).pathname.replace(/^\/npm\/three@[^/]+\//, '');
  try {
    const body = await readFile(join(ROOT, 'node_modules/three', rel));
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  } catch {
    await route.fulfill({ status: 404, body: 'nope' });
  }
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (error) => console.error('pageerror:', String(error)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 15000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 10000 });
await page.evaluate(() => window.shutoko.enterTatsumiPa());
await page.waitForFunction(() => window.shutoko.mode === 'pa', null, { timeout: 15000 });
await page.waitForTimeout(1200);

console.log(await page.evaluate(() => {
  const pa = window.shutoko.tatsumiPa;
  const parts = [];
  let ink = '';
  pa.root.traverse((o) => {
    if (o.isInstancedMesh && o.name?.startsWith('PA lot')) {
      parts.push(`${o.name} x${o.count}`);
      const image = o.material.map?.image;
      if (image?.getContext) {
        const data = image.getContext('2d').getImageData(0, 0, image.width, image.height).data;
        let painted = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 8) painted += 1;
        ink += `\n  ${o.name} ${image.width}x${image.height} ink=${painted}`;
      }
    }
  });
  const groups = pa.root.children.filter((c) => c.name?.startsWith('PA ')).map((c) => c.name);
  return `groups: ${groups.join(', ')}\ncolliders: ${pa.colliders.length}\nbatches: ${parts.join(', ')}${ink}`;
}));

const place = async (x, z, yaw, pitch = 0) => {
  await page.evaluate(({ x: px, z: pz, yaw: py, pitch: pp }) => {
    const pa = window.shutoko.tatsumiPa;
    pa.position.set(px, pa.playerHeight, pz);
    pa.yaw = py;
    pa.pitch = pp;
    pa.updateCamera();
  }, { x, z, yaw, pitch });
  await page.waitForTimeout(500);
};
// updateCamera() runs every frame off pa.position/yaw/pitch, so the camera has
// to be driven through those, not set directly.
const overhead = async (y) => {
  await page.evaluate((height) => {
    const pa = window.shutoko.tatsumiPa;
    pa.position.set(0, height, 0.01);
    pa.yaw = 0;
    pa.pitch = -1.5;
    pa.updateCamera();
  }, y);
  await page.waitForTimeout(500);
};
const shoot = async (name) => {
  await page.screenshot({ path: join(OUT, `PALOT-${name}${SUFFIX}.png`) });
  console.log(`shot PALOT-${name}${SUFFIX}.png`);
};
const want = (name) => !ONLY || ONLY === name;

if (want('pa-spawn')) { await place(0, 6.2, 0, -0.02); await shoot('pa-spawn'); }
if (want('pa-building')) { await place(2, -1, 0.12, 0.16); await shoot('pa-building'); }
if (want('pa-comb')) { await place(-20, 10, -0.75, 0.05); await shoot('pa-comb'); }
if (want('pa-small')) { await place(24, 6, 1.9, 0.0); await shoot('pa-small'); }
if (want('pa-gate')) { await place(0, 8, Math.PI, 0.05); await shoot('pa-gate'); }
if (want('pa-plan')) { await overhead(58); await shoot('pa-plan'); }

await browser.close();
server.close();
