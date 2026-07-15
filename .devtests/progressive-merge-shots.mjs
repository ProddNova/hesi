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
});

// Validation fixtures only. Production enablement lives in one data module.
const cases = [
  { name: 'one-to-two-merge', branch: 'ramp_1', host: 'r11_0', which: 'end' },
  { name: 'two-to-two-merge', branch: 'c1_3', host: 'c1_0', which: 'end' },
  { name: 'two-to-three-merge', branch: 'ramp_3', host: 'wangan_1', which: 'end' },
  { name: 'right-diverge', branch: 'r1_0', host: 'c1_0', which: 'start' },
];

for (const fixture of cases) {
  const geometry = await page.evaluate((spec) => {
    const map = window.shutoko.map;
    const branch = map.routes.get(spec.branch);
    const host = map.routes.get(spec.host);
    const zone = map.junctionZones.find((candidate) => candidate.branch === branch
      && candidate.host === host && candidate.which === spec.which);
    if (!branch || !host || !zone?.crossable) return null;
    const h0 = zone.crossable.host[0];
    const h1 = zone.crossable.host[1];
    const hostAt = (distance) => {
      const sample = map._sampleCenter(host, map._normalizeDistance(host, distance), 1);
      return {
        position: { x: sample.position.x, y: sample.position.y, z: sample.position.z },
        tangent: { x: sample.tangent.x, y: sample.tangent.y, z: sample.tangent.z },
      };
    };
    const branchAt = (distance) => {
      const sample = map._sampleCenter(branch, Math.max(0, Math.min(branch.length, distance)), 1);
      return {
        position: { x: sample.position.x, y: sample.position.y, z: sample.position.z },
        tangent: { x: sample.tangent.x, y: sample.tangent.y, z: sample.tangent.z },
      };
    };
    const openingBranch = zone.markingOpening?.branch || zone.crossable.branch;
    const branchApproach = spec.which === 'end'
      ? Math.max(0, openingBranch[0] - 55)
      : Math.min(branch.length, openingBranch[1] + 55);
    return {
      plan: hostAt((h0 + h1) * 0.5),
      chase: branchAt(branchApproach),
      marking: hostAt(spec.which === 'end' ? h0 : h1),
      rail: hostAt(spec.which === 'end' ? h1 : h0),
      side: zone.side,
      zoneId: zone.id,
      lanes: `${branch.lanes}->${host.lanes}`,
    };
  }, fixture);
  if (!geometry) throw new Error(`Missing validation fixture ${fixture.branch}->${fixture.host}`);

  const views = [
    { name: 'plan', sample: geometry.plan, up: 118, back: 0, lateral: 0, pitch: -1.50 },
    { name: 'chase', sample: geometry.chase, up: 6.5, back: 38, lateral: 0, pitch: -0.13 },
    { name: 'marking', sample: geometry.marking, up: 9, back: 24, lateral: -geometry.side * 5, pitch: -0.22 },
    { name: 'guardrail', sample: geometry.rail, up: 5.5, back: 20, lateral: geometry.side * 20, pitch: -0.12 },
  ];
  for (const view of views) {
    await page.evaluate(({ sample, camera }) => {
      const game = window.shutoko;
      if (!game.debug.noclip) game.setNoclip(true);
      const normalX = -sample.tangent.z;
      const normalZ = sample.tangent.x;
      const x = sample.position.x - sample.tangent.x * camera.back + normalX * camera.lateral;
      const y = sample.position.y + camera.up;
      const z = sample.position.z - sample.tangent.z * camera.back + normalZ * camera.lateral;
      game.debug.position.set(x, y, z);
      game.debug.yaw = Math.atan2(sample.position.x - x, sample.position.z - z);
      game.debug.pitch = camera.pitch;
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
