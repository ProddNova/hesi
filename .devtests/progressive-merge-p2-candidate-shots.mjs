/**
 * Runtime plan/deck evidence for every exact 2-lane + 2-lane merge candidate.
 *
 * Run: node .devtests/progressive-merge-p2-candidate-shots.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'docs', 'progressive-merges', 'p2-candidate-audit');
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
await page.goto(`http://127.0.0.1:${port}/?legacyProgressiveMerges=1`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko?.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko?.mode === 'driving', null, { timeout: 5000 });
await page.waitForFunction(
  () => Number.parseFloat(getComputedStyle(document.querySelector('#fade')).opacity) < 0.001,
  null,
  { timeout: 5000 },
);
await page.evaluate(() => {
  const game = window.shutoko;
  game.traffic?.setDensity?.(0);
  game.traffic?.vehicles?.forEach?.((vehicle) => { if (vehicle.mesh) vehicle.mesh.visible = false; });
  document.querySelector('#hud')?.setAttribute('style', 'display:none!important');
  document.querySelector('#debug-drone-hud')?.setAttribute('style', 'display:none!important');
});

const candidates = await page.evaluate(() => {
  const map = window.shutoko.map;
  return map.junctionZones.filter((zone) => zone.kind === 'merge'
    && zone.host.lanes === 2 && zone.branch.lanes === 2).map((zone) => {
    const overlap = (row) => row.innerEdge < row.hostHalf - 0.3;
    const deckEdge = (row) => Math.max(Math.abs(row.dy), ...(row.dyEnds || []).map(Math.abs));
    const overlapRows = zone.samples.filter(overlap);
    const worst = overlapRows.reduce((left, right) => (deckEdge(right) > deckEdge(left) ? right : left));
    const centre = zone.samples[Math.floor(zone.samples.length * 0.55)];
    const sample = (row) => {
      const hostFrame = map._frameAt(zone.host, row.hS);
      const branchFrame = map._frameAt(zone.branch, row.bS);
      const hostPoint = map._deckPoint(hostFrame, zone.side * row.hostHalf * 0.45, 0.1);
      const branchPoint = map._deckPoint(branchFrame, -zone.hostwardSign * row.half * 0.45, 0.1);
      return {
        hostPoint: { x: hostPoint.x, y: hostPoint.y, z: hostPoint.z },
        branchPoint: { x: branchPoint.x, y: branchPoint.y, z: branchPoint.z },
        hostTangent: { x: hostFrame.tangent.x, y: hostFrame.tangent.y, z: hostFrame.tangent.z },
        side: zone.side,
      };
    };
    return {
      stem: zone.id.split(':')[0].toLowerCase(),
      id: zone.id,
      pair: `${zone.branch.id} -> ${zone.host.id}`,
      plan: sample(centre),
      deck: sample(worst),
      maximumDeckSeparation: deckEdge(worst),
    };
  });
});

for (const candidate of candidates) {
  for (const viewName of ['plan', 'deck']) {
    await page.evaluate(({ geometry, view }) => {
      const game = window.shutoko;
      const anchor = geometry[view];
      const host = game.debug.position.clone().set(anchor.hostPoint.x, anchor.hostPoint.y, anchor.hostPoint.z);
      const branch = game.debug.position.clone().set(anchor.branchPoint.x, anchor.branchPoint.y, anchor.branchPoint.z);
      const target = host.clone().lerp(branch, 0.5);
      const tangent = game.debug.position.clone().set(anchor.hostTangent.x, 0, anchor.hostTangent.z).normalize();
      const normal = game.debug.position.clone().set(-tangent.z, 0, tangent.x);
      const planMaterials = new Set([
        game.map.materials.road,
        game.map.materials.roadAlt,
        game.map.materials.roadService,
        game.map.materials.marking,
        game.map.materials.concrete,
        game.map.materials.concreteDark,
        game.map.materials.barrier,
        game.map.materials.railMetal,
        game.map.materials.cushion,
      ]);
      const clutterMaterials = new Set([
        game.map.materials.facadeOffice,
        game.map.materials.facadeDark,
        game.map.materials.facadeHotel,
        game.map.materials.facadeIndustrial,
        game.map.materials.building,
      ]);
      game.map.group.traverse((object) => {
        if (!object.isMesh) return;
        object.visible = view === 'plan'
          ? planMaterials.has(object.material)
          : !clutterMaterials.has(object.material);
      });
      game.debug.noclip = true;
      game.debug.position.copy(target);
      if (view === 'plan') {
        game.debug.position.y += 135;
      } else {
        game.debug.position.addScaledVector(tangent, -34);
        game.debug.position.addScaledVector(normal, anchor.side * 26);
        game.debug.position.y += 9;
      }
      const x = game.debug.position.x;
      const y = game.debug.position.y;
      const z = game.debug.position.z;
      game.debug.yaw = Math.atan2(target.x - x, target.z - z);
      game.debug.pitch = Math.atan2(target.y - y, Math.max(0.001, Math.hypot(target.x - x, target.z - z)));
      game._snapNoclipCamera();
      game.map._visibleKey = null;
      game.map.update(game.debug.position, performance.now() / 1000);
    }, { geometry: candidate, view: viewName });
    await page.waitForTimeout(400);
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(
      () => requestAnimationFrame(resolveFrame),
    )));
    const filename = `${candidate.stem}-${viewName}.png`;
    await page.screenshot({ path: join(OUT, filename) });
    console.log(`${filename} | ${candidate.id} | ${candidate.pair} | max deck ${candidate.maximumDeckSeparation.toFixed(3)} m`);
  }
}

await browser.close();
server.close();
