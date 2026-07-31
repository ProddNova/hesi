/**
 * Reference shots of the Tatsumi No.1 PA lot (js/tatsumi-pa-lot.js), framed to
 * match the photographs the layout was built from.
 *
 *  1. lot-plan     — whole strip from above (the aerial).
 *  2. lot-comb     — driver's eye down the 45° large-vehicle comb.
 *  3. lot-building — driver's eye at the arched canopy / vending row.
 *  4. lot-forecourt— the island kerb and railing from the aisle.
 *  5. lot-entry    — arriving through the entry gate.
 *
 * Run: node .devtests/tatsumi-pa-lot-shots.mjs [suffix] [--case=name]
 * Writes .devtests/shots/LOT-<case>[-suffix].png
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
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });
await page.evaluate(() => {
  const g = window.shutoko;
  (g.traffic?.pool || []).forEach((v) => { if (v.mesh) v.mesh.visible = false; });
});

console.log(await page.evaluate(() => {
  let meshes = 0; let instances = 0;
  const paint = [];
  window.shutoko.map.group.traverse((o) => {
    if (!o.name?.startsWith('Tatsumi PA lot')) return;
    meshes += 1; instances += o.count || 0;
    if (!o.name.includes('text')) return;
    const image = o.material.map?.image;
    // Is the painted glyph tile actually a tile with ink on it?
    let ink = 0;
    if (image?.getContext) {
      const data = image.getContext('2d').getImageData(0, 0, image.width, image.height).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 8) ink += 1;
    }
    paint.push(`${o.name} ${image ? `${image.width}x${image.height}` : 'NO TEXTURE'} ink=${ink}`);
  });
  return `lot meshes ${meshes}, instances ${instances}\n${paint.join('\n')}`;
}));

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
const shoot = async (name) => {
  await page.screenshot({ path: join(OUT, `LOT-${name}${SUFFIX}.png`) });
  console.log(`shot LOT-${name}${SUFFIX}.png`);
};
const want = (name) => !ONLY || ONLY === name;

if (want('lot-plan')) {
  await place({ u: 0, v: 0, up: 150, yaw: Math.PI * 0.5, pitch: -Math.PI * 0.5 + 0.001 });
  await shoot('lot-plan');
}
if (want('lot-comb')) {
  await place({ u: -50, v: 1, up: 1.5, yaw: 0.5, pitch: -0.06 });
  await shoot('lot-comb');
}
if (want('lot-building')) {
  await place({ u: 8, v: 0, up: 1.5, yaw: 0.42, pitch: 0.06 });
  await shoot('lot-building');
}
if (want('lot-forecourt')) {
  await place({ u: 44, v: 1, up: 1.5, yaw: Math.PI - 0.55, pitch: 0.05 });
  await shoot('lot-forecourt');
}
if (want('lot-entry')) {
  await place({ u: -86, v: 1, up: 1.5, yaw: 0, pitch: -0.02 });
  await shoot('lot-entry');
}
if (want('lot-paint')) {   // close plan over the comb: bay lines + painted 大型
  await place({ u: -50, v: -6, up: 26, yaw: Math.PI * 0.5, pitch: -Math.PI * 0.5 + 0.001 });
  await shoot('lot-paint');
}
if (want('lot-paint-small')) {
  await place({ u: -50, v: 8, up: 22, yaw: Math.PI * 0.5, pitch: -Math.PI * 0.5 + 0.001 });
  await shoot('lot-paint-small');
}

await browser.close();
server.close();
