/** Identical-camera eight-view P4 before/after evidence. */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => process.argv
  .find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const SUFFIX = option('suffix', 'after');
const LEGACY = process.argv.includes('--legacy');
const OUT = resolve(option('out', join(ROOT, 'docs', 'progressive-merges', 'checkpoint-2', SUFFIX)));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
await mkdir(OUT, { recursive: true });

const server = createServer(async (request, response) => {
  try {
    const requestPath = request.url.split('?')[0];
    const file = requestPath === '/' ? '/index.html' : requestPath;
    const body = await readFile(join(ROOT, file));
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules', 'three', 'build', 'three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (dialog) => dialog.accept());
page.on('pageerror', (error) => console.error('pageerror:', String(error)));
await page.goto(`http://127.0.0.1:${port}/${LEGACY ? '?legacyProgressiveMerges=1' : ''}`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko?.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko?.mode === 'driving', null, { timeout: 5000 });
await page.evaluate(() => {
  const game = window.shutoko;
  game.traffic?.setDensity?.(0);
  game.traffic?.vehicles?.forEach?.((vehicle) => { if (vehicle.mesh) vehicle.mesh.visible = false; });
  document.querySelector('#hud')?.setAttribute('style', 'display:none!important');
  document.querySelector('#debug-drone-hud')?.setAttribute('style', 'display:none!important');
  const clutter = new Set([
    game.map.materials.facadeOffice,
    game.map.materials.facadeDark,
    game.map.materials.facadeHotel,
    game.map.materials.facadeIndustrial,
    game.map.materials.building,
  ]);
  game.map.group.traverse((object) => {
    if (object.isMesh && clutter.has(object.material)) object.visible = false;
  });
});

// Absolute chainages are source-curve fixtures and intentionally do not read
// progressive phases, so before/after camera transforms remain identical.
const views = [
  { name: 'high-plan', routeId: 'c1_0', distance: 10928, lane: null, up: 150, back: 0, lateral: 0, plan: true },
  { name: 'host-approach', routeId: 'c1_0', distance: 10882, lane: 1, up: 7, back: 58, lateral: 0 },
  { name: 'auxiliary-lane', routeId: 'c1_0', distance: 10928, lane: null, targetLateral: -5.325, up: 6, back: 42, lateral: 0 },
  { name: 'branch-handoff', routeId: 'r1_0', distance: 148, lane: 0, up: 8, back: 48, lateral: 0 },
  { name: 'guardrail-opening', routeId: 'r1_0', distance: 140, lane: null, targetLateral: -4.1, up: 13, back: 30, lateral: -15 },
  { name: 'collision-hitbox', routeId: 'c1_0', distance: 10982.425, lane: null, up: 72, back: 0, lateral: 0, plan: true, hitboxes: true },
  { name: 'host-continuation', routeId: 'c1_0', distance: 11035, lane: 1, up: 7, back: 45, lateral: 0 },
  { name: 'branch-continuation', routeId: 'r1_0', distance: 215, lane: 0, up: 7, back: 45, lateral: 0 },
];

for (const view of views) {
  await page.evaluate((camera) => {
    const game = window.shutoko;
    game.setDebugHitbox('roads', !!camera.hitboxes);
    game.setDebugHitbox('walls', !!camera.hitboxes);
    if (!game.debug.noclip) game.setNoclip(true);
    const route = game.map.routes.get(camera.routeId);
    const frame = game.map._frameAt(route, camera.distance);
    const target = camera.lane === null
      ? game.map._deckPoint(frame, camera.targetLateral || 0, 0.1)
      : game.map.sampleLane(camera.routeId, camera.distance, camera.lane, 1).position;
    const tangent = frame.tangent;
    const normal = frame.normal;
    const x = target.x - tangent.x * camera.back + normal.x * camera.lateral;
    const y = target.y + camera.up;
    const z = target.z - tangent.z * camera.back + normal.z * camera.lateral;
    game.debug.position.set(x, y, z);
    game.debug.yaw = Math.atan2(target.x - x, target.z - z);
    const horizontal = Math.hypot(target.x - x, target.z - z);
    game.debug.pitch = Math.atan2(target.y - y, Math.max(0.001, horizontal));
    game._snapNoclipCamera();
    game.map._visibleKey = null;
    game.map.update(game.debug.position, performance.now() / 1000);
  }, view);
  await page.waitForTimeout(500);
  await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(
    () => requestAnimationFrame(resolveFrame),
  )));
  const filename = `p4-${view.name}-${SUFFIX}.png`;
  await page.screenshot({ path: join(OUT, filename) });
  console.log(filename);
}

await browser.close();
server.close();
