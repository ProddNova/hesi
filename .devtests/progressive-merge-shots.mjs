/**
 * Identical-camera evidence for the four progressive-merge prototypes.
 *
 * The cameras are anchored to the unchanged host/branch route curves so a
 * legacy/progressive pair frames the same world-space region even when the
 * local transition surface changes.
 *
 * Run:
 *   node .devtests/progressive-merge-shots.mjs --suffix=baseline
 *   node .devtests/progressive-merge-shots.mjs --legacy --suffix=legacy
 *   node .devtests/progressive-merge-shots.mjs --suffix=progressive
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => process.argv
  .find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const SUFFIX = option('suffix', process.argv.includes('--legacy') ? 'legacy' : 'progressive');
const LEGACY = process.argv.includes('--legacy');
const OUT = resolve(option('out', join(ROOT, 'docs', 'progressive-merges', SUFFIX)));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
await mkdir(OUT, { recursive: true });

const server = createServer(async (req, res) => {
  try {
    const requestPath = req.url.split('?')[0];
    const file = requestPath === '/' ? '/index.html' : requestPath;
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
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
await page.waitForFunction(
  () => Number.parseFloat(getComputedStyle(document.querySelector('#fade')).opacity) < 0.001,
  null,
  { timeout: 5000 },
);
await page.evaluate(() => {
  const game = window.shutoko;
  game.traffic?.setDensity?.(0);
  game.traffic?.vehicles?.forEach?.((vehicle) => { if (vehicle.mesh) vehicle.mesh.visible = false; });
  const technicalEvidenceClutter = new Set([
    game.map.materials.facadeOffice,
    game.map.materials.facadeDark,
    game.map.materials.facadeHotel,
    game.map.materials.facadeIndustrial,
    game.map.materials.building,
  ]);
  game.map.group.traverse((object) => {
    if (!object.isMesh) return;
    if (technicalEvidenceClutter.has(object.material)) object.visible = false;
  });
  document.querySelector('#hud')?.setAttribute('style', 'display:none!important');
  document.querySelector('#debug-drone-hud')?.setAttribute('style', 'display:none!important');
});

// Validation fixtures only. Production enablement lives in one data module.
const cases = [
  { name: 'one-to-two-merge', branch: 'ramp_1', host: 'r11_0', which: 'end', phases: [3009.085, 3029.082, 3059.082, 3101.971, 3145.683] },
  { name: 'two-to-two-merge', branch: 'c1_3', host: 'c1_0', which: 'end', phases: [11176.304, 11195.882, 11228.512, 11287.246, 11339.454] },
  { name: 'two-to-three-merge', branch: 'ramp_3', host: 'wangan_1', which: 'end', phases: [4392.541, 4420.358, 4457.615, 4530.823, 4595.896] },
  { name: 'right-diverge', branch: 'r1_0', host: 'c1_0', which: 'start', phases: [10837.464, 10856.748, 10888.887, 10946.737, 10998.160] },
];

for (const fixture of cases) {
  const geometry = await page.evaluate((spec) => {
    const map = window.shutoko.map;
    const branch = map.routes.get(spec.branch);
    const host = map.routes.get(spec.host);
    const zone = map.junctionZones.find((candidate) => candidate.branch === branch
      && candidate.host === host && candidate.which === spec.which);
    if (!branch || !host || !zone?.crossable) return null;
    const hostAt = (distance) => {
      const sample = map._sampleCenter(host, map._normalizeDistance(host, distance), 1);
      return {
        position: { x: sample.position.x, y: sample.position.y, z: sample.position.z },
        tangent: { x: sample.tangent.x, y: sample.tangent.y, z: sample.tangent.z },
      };
    };
    const [approachStart, openingStart, parallelStart, absorptionStart, transitionEnd] = spec.phases;
    return {
      plan: hostAt((openingStart + transitionEnd) * 0.5),
      chase: hostAt(parallelStart),
      marking: hostAt((parallelStart + absorptionStart) * 0.5),
      rail: hostAt((parallelStart + absorptionStart) * 0.5),
      side: zone.side,
      zoneId: zone.id,
      lanes: `${branch.lanes}->${host.lanes}`,
      phaseSpan: transitionEnd - approachStart,
    };
  }, fixture);
  if (!geometry) throw new Error(`Missing validation fixture ${fixture.branch}->${fixture.host}`);

  const views = [
    { name: 'plan', sample: geometry.plan, up: 145, back: 0, lateral: 0 },
    { name: 'chase', sample: geometry.chase, up: 8, back: 64, lateral: 0 },
    { name: 'marking', sample: geometry.marking, up: 11, back: 25, lateral: -geometry.side * 7 },
    { name: 'guardrail', sample: geometry.rail, up: 15, back: 25, lateral: geometry.side * 14 },
  ];
  for (const view of views) {
    await page.evaluate(({ sample, camera }) => {
      const game = window.shutoko;
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
        object.visible = camera.name === 'plan'
          ? planMaterials.has(object.material)
          : !clutterMaterials.has(object.material);
      });
      if (!game.debug.noclip) game.setNoclip(true);
      const normalX = -sample.tangent.z;
      const normalZ = sample.tangent.x;
      const x = sample.position.x - sample.tangent.x * camera.back + normalX * camera.lateral;
      const y = sample.position.y + camera.up;
      const z = sample.position.z - sample.tangent.z * camera.back + normalZ * camera.lateral;
      game.debug.position.set(x, y, z);
      game.debug.yaw = Math.atan2(sample.position.x - x, sample.position.z - z);
      const horizontal = Math.hypot(sample.position.x - x, sample.position.z - z);
      game.debug.pitch = Math.atan2(sample.position.y - y, Math.max(0.001, horizontal));
      game._snapNoclipCamera();
      game.map._visibleKey = null;
      game.map.update(game.debug.position, performance.now() / 1000);
    }, { sample: view.sample, camera: view });
    await page.waitForTimeout(500);
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(
      () => requestAnimationFrame(resolveFrame),
    )));
    const filename = `${fixture.name}-${view.name}-${SUFFIX}.png`;
    await page.screenshot({ path: join(OUT, filename) });
    console.log(`${filename} | ${geometry.zoneId} ${fixture.branch}->${fixture.host} ${geometry.lanes}`);
  }
}

await browser.close();
server.close();
