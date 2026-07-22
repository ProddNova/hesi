/**
 * Close looks at the Tokyo Bay surface itself, to check the swell texture reads
 * as water (and is not a flat plate or a light-blue sea). Flies the noclip
 * camera out over open water beside the Tatsumi deck and frames the surface at
 * a low grazing angle, then straight down.
 *
 * Run: node .devtests/bay-water-shots.mjs [suffix]
 * Writes .devtests/shots/BAY-<case>[-suffix].png
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
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, hasTouch: true });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const rel = new URL(route.request().url()).pathname.replace(/^\/npm\/three@[^/]+\//, '');
  try {
    const body = await readFile(join(ROOT, 'node_modules/three', rel));
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  } catch { await route.fulfill({ status: 404, body: 'nope' }); }
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 15000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 10000 });
await page.evaluate(() => (window.shutoko.traffic?.pool || []).forEach((v) => { if (v.mesh) v.mesh.visible = false; }));

// noclip drives the camera from debug.position/yaw/pitch every frame, so set
// those (not the camera) and let updateNoclip point it. yaw: 0 faces +Z, +yaw
// toward +X (see updateNoclip's look vector); pitch is negative to look down.
const view = async (name, eye, target) => {
  await page.evaluate(({ eye, target }) => {
    const g = window.shutoko;
    g.debug.noclip = true;
    g.debug.trafficDisabled = true;
    g.debug.position.set(eye[0], eye[1], eye[2]);
    const dx = target[0] - eye[0];
    const dy = target[1] - eye[1];
    const dz = target[2] - eye[2];
    const flat = Math.hypot(dx, dz);
    g.debug.yaw = Math.atan2(dx, dz);
    g.debug.pitch = Math.atan2(dy, flat);
  }, { eye, target });
  await page.waitForTimeout(1600);
  await page.screenshot({ path: join(OUT, `BAY-${name}${SUFFIX}.png`) });
  console.log(`shot BAY-${name}${SUFFIX}.png`);
};

// Open bay just south-east of the Tatsumi deck (deck centre ~3618,-4069).
await view('grazing', [3600, 40, -4300], [3900, -0.9, -4800]);
await view('topdown', [3800, 260, -4600], [3800, -0.9, -4601]);
await view('deck-edge', [3660, 90, -4180], [3780, -0.9, -4500]);

console.log('page errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
server.close();
