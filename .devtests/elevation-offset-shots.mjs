/**
 * Deterministic before/after screenshots for the global road elevation audit.
 *
 * Run: node .devtests/elevation-offset-shots.mjs before
 *      node .devtests/elevation-offset-shots.mjs after
 *
 * The cyan overlay is the analytic road surface. It remains visible through
 * the terrain, making a buried pre-offset deck unambiguous while keeping the
 * camera framing identical between runs.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'docs', 'elevation-offset');
const phase = process.argv[2];
if (!['before', 'after'].includes(phase)) {
  throw new Error('Expected screenshot phase: before or after');
}
await mkdir(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
const server = createServer(async (request, response) => {
  try {
    const pathname = request.url.split('?')[0];
    const file = pathname === '/' ? '/index.html' : pathname;
    const body = await readFile(join(ROOT, file));
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules', 'three', 'build', 'three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (dialog) => dialog.accept());
page.on('pageerror', (error) => console.error('pageerror:', String(error)));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });

const cases = [
  { name: 'c1-worst', routeId: 'c1_0', distance: 4222, lateral: -38, back: 25, height: 12 },
  { name: 'wangan-floor', routeId: 'wangan_1', distance: 6830, lateral: 38, back: 32, height: 12 },
];

for (const shot of cases) {
  const detail = await page.evaluate((config) => {
    const game = window.shutoko;
    const map = game.map;
    const route = map.getRoute(config.routeId);
    const frame = map._frameAt(route, config.distance);
    if (!game.debug.noclip) game.setNoclip(true);
    game.setTrafficDisabled(true);
    game.setDebugHitbox('roads', true);

    const target = frame.position.clone();
    target.y = Math.max(0.45, target.y + 0.3);
    const camera = frame.position.clone()
      .addScaledVector(frame.normal, config.lateral)
      .addScaledVector(frame.tangent, -config.back);
    camera.y = config.height;
    const look = target.sub(camera).normalize();
    game.debug.position.copy(camera);
    game.debug.yaw = Math.atan2(look.x, look.z);
    game.debug.pitch = Math.asin(look.y);
    game.map.update(camera, 0);

    // The production palette is intentionally near-black at night. Lift only
    // the slab material in this diagnostic capture so its top plane and the
    // road/floor relationship remain readable.
    const slabNames = new Set(map._terrainSlabs.map((slab) => slab.name));
    map.group.children.forEach((object) => {
      if (!slabNames.has(object.name) || !object.material) return;
      object.material = object.material.clone();
      object.material.color?.setHex(0x34434c);
      object.material.emissive?.setHex(0x111820);
      object.material.needsUpdate = true;
    });

    document.querySelectorAll('#touch-controls, #hud, #phone, #debug-menu, #debug-drone-hud, .toast').forEach((element) => {
      element.style.display = 'none';
    });
    let label = document.getElementById('elevation-shot-label');
    if (!label) {
      label = document.createElement('div');
      label.id = 'elevation-shot-label';
      Object.assign(label.style, {
        position: 'fixed', left: '18px', top: '16px', zIndex: '99999',
        padding: '8px 11px', background: 'rgba(4,8,14,.82)', color: '#7de8ff',
        border: '1px solid #36bcd6', font: '15px monospace', letterSpacing: '1px',
      });
      document.body.appendChild(label);
    }
    label.textContent = `${config.phase.toUpperCase()} // ${config.routeId} @ ${config.distance} m // CYAN = ROAD SURFACE`;
    return { y: frame.position.y, x: frame.position.x, z: frame.position.z };
  }, { ...shot, phase });
  await page.waitForTimeout(900);
  const filename = `${shot.name}-${phase}.png`;
  await page.screenshot({ path: join(OUT, filename) });
  console.log(`${filename}: ${shot.routeId} @ ${shot.distance} m, deck y=${detail.y.toFixed(2)}`);
}

await browser.close();
server.close();
