/**
 * Terrain uv magnitude probe.
 *
 * The "confetti" — a lattice of repeated light/dark specks on the ground,
 * reported on a phone and never reproduced on desktop. Every presentation
 * explanation has now been eliminated ON the reporting device, not inferred:
 * native resolution (?diag=native), the whole VHS/PS2 post pass with its
 * 368-line resample and grain (?diag=nofilter), multisampling in both paths
 * (?diag=aa), and the texture-size budget (seen at High). The device also
 * reports fragHighp:YES, which kills the "precision:'highp' was silently
 * downgraded" explanation the renderer comment carries.
 *
 * What was left is the scene, and the ground had a defect the road does not.
 * map.js localises terrain POSITIONS to the area origin but built uvs from
 * raw world coordinates: `uvs.push(x / TERRAIN_CELL, z / TERRAIN_CELL)`. Over
 * a ~26 km network that runs to several hundred, and the texel is picked by
 * the fraction — the integer part has already spent most of the interpolator's
 * bits. tileAnchoredOrigin fixes exactly this for the road and says so at
 * length; the terrain never went through it.
 *
 * Magnitude is the measurable part, and it is what this asserts. The artefact
 * itself cannot be reproduced here: this renders through SwiftShader, which
 * interpolates at desktop precision, and the report comes from an Apple GPU.
 * Shipping a fix inferred from a screenshot is what went wrong three times
 * before — so this checks the property the fix is actually about, and leaves
 * the visual confirmation to the device.
 *
 * Run: node .devtests/terrain-uv-precision-probe.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.obj': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg',
};

const server = createServer(async (request, response) => {
  try {
    const urlPath = request.url.split('?')[0];
    const file = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
    const body = await readFile(join(ROOT, file));
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const url = new URL(route.request().url());
  const addon = url.pathname.match(/\/examples\/jsm\/(.+)$/);
  const file = addon
    ? join(ROOT, 'node_modules', 'three', 'examples', 'jsm', addon[1])
    : join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(file) });
});

const page = await context.newPage();
const errors = [];
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
page.on('pageerror', (error) => errors.push(String(error)));
page.on('dialog', (dialog) => dialog.accept());

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} · ${name}${detail ? ` · ${detail}` : ''}`);
};

const terrain = await page.evaluate(() => {
  const ground = window.shutoko.map?.materials?.ground;
  const meshes = [];
  window.shutoko.map.group.traverse((node) => {
    if (node.isMesh && node.material === ground && node.geometry?.attributes?.uv) meshes.push(node);
  });
  let maxUv = 0;
  let maxPosition = 0;
  let vertices = 0;
  // Worst fractional resolution across the sheet: how finely the interpolator
  // can still address a tile once the integer part has taken its bits. 24 is
  // the mantissa a float32 varying carries.
  for (const mesh of meshes) {
    const uv = mesh.geometry.attributes.uv;
    const position = mesh.geometry.attributes.position;
    vertices += uv.count;
    for (let i = 0; i < uv.count; i += 1) {
      maxUv = Math.max(maxUv, Math.abs(uv.getX(i)), Math.abs(uv.getY(i)));
    }
    for (let i = 0; i < position.count; i += 1) {
      maxPosition = Math.max(maxPosition, Math.abs(position.getX(i)), Math.abs(position.getZ(i)));
    }
  }
  return { meshes: meshes.length, vertices, maxUv, maxPosition };
});

check('the terrain was found and has uvs', terrain.meshes > 0 && terrain.vertices > 0,
  `${terrain.meshes} mesh(es), ${terrain.vertices} vertices`);

// The property the fix actually guarantees: the uv magnitude is bounded by the
// mesh's OWN extent instead of by its distance from the world origin. Measured
// on the shipped map that is 410.32 → 72.00 tiles, so the assertion is set just
// above what anchoring can reach rather than at a number picked by hope.
//
// It does NOT claim to be small enough to fix the artefact: a terrain sheet is
// kilometres wide, so ~72 tiles is the floor for a 64 m tile, and no choice of
// origin goes below it. Getting further needs smaller sheets or a uv computed
// in the fragment shader from a localised position.
check('terrain uvs are bounded by the mesh, not by the distance to the origin',
  terrain.maxUv < 128,
  `max |uv| = ${terrain.maxUv.toFixed(2)} tiles · was 410.32 with world-absolute uvs (5.7× reduction)`);

const fractionBits = 24 - Math.ceil(Math.log2(Math.max(1, terrain.maxUv)));
check('the fraction keeps at least 16 bits of a float32 varying',
  fractionBits >= 16,
  `${fractionBits} bits left for the fraction that picks the texel`);

// Positions were already localised; the uvs must now be in the same league, or
// the mismatch that caused this is still there in some form.
check('uvs are anchored like the positions they belong to',
  terrain.maxUv * 64 < terrain.maxPosition * 4 + 4096,
  `max |uv|×cell = ${(terrain.maxUv * 64).toFixed(0)} m vs max |position| = ${terrain.maxPosition.toFixed(0)} m`);

check('no console errors', errors.length === 0, errors.slice(0, 2).join(' · '));

await browser.close();
server.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
