/**
 * Identical-camera A-B marking screenshots for the six required junction
 * topologies. The served root may be a detached parent worktree; output
 * always belongs to this harness repository.
 *
 * Run:
 *   node .devtests/ab-marking-shots.mjs --root=<repo> --suffix=before
 *   node .devtests/ab-marking-shots.mjs --suffix=after
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_ROOT = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const ROOT = resolve(option('root', HARNESS_ROOT));
const SUFFIX = option('suffix', 'after');
const LIMIT = Number(option('limit', '6'));
const OUT = resolve(option('out', join(HARNESS_ROOT, 'docs', 'junctions', 'ab-clipping')));
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
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko?.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko?.mode === 'driving', null, { timeout: 5000 });
await page.waitForFunction(() => Number.parseFloat(getComputedStyle(document.querySelector('#fade')).opacity) < 0.001, null, { timeout: 5000 });
await page.evaluate(() => {
  const game = window.shutoko;
  game.traffic?.setDensity?.(0);
  game.traffic?.vehicles?.forEach?.((vehicle) => { if (vehicle.mesh) vehicle.mesh.visible = false; });
});

// Route IDs are validation fixtures only, never production special cases.
const cases = [
  { name: 'one-to-two-merge', branch: 'ramp_1', host: 'r11_0', which: 'end' },
  { name: 'two-to-two-merge', branch: 'c1_3', host: 'c1_0', which: 'end' },
  { name: 'two-to-three-merge', branch: 'ramp_3', host: 'wangan_1', which: 'end' },
  { name: 'left-merge', branch: 'c1_6', host: 'c1_2', which: 'end' },
  { name: 'right-merge', branch: 'r6_3', host: 'c1_0', which: 'end' },
  { name: 'right-diverge', branch: 'r1_0', host: 'c1_0', which: 'start' },
];
const views = [
  { name: 'plan', anchor: 'middle', up: 105, back: 0, pitch: -1.50 },
  { name: 'chase', anchor: 'cut', up: 7, back: 42, pitch: -0.14 },
  { name: 'close', anchor: 'cut', up: 18, back: 30, pitch: -0.38 },
];

for (const fixture of cases.slice(0, LIMIT)) {
  const geometry = await page.evaluate((spec) => {
    const map = window.shutoko.map;
    const branch = map.routes.get(spec.branch);
    const host = map.routes.get(spec.host);
    const zone = map.junctionZones.find((candidate) => candidate.branch === branch
      && candidate.host === host && candidate.which === spec.which);
    if (!branch || !host || !zone?.crossable) return null;
    const branchCut = spec.which === 'end' ? zone.crossable.branch[0] : zone.crossable.branch[1];
    const branchMiddle = (zone.crossable.branch[0] + zone.crossable.branch[1]) * 0.5;
    const record = (distance) => {
      const sample = map._sampleCenter(branch, distance, 1);
      return {
        position: { x: sample.position.x, y: sample.position.y, z: sample.position.z },
        tangent: { x: sample.tangent.x, y: sample.tangent.y, z: sample.tangent.z },
        heading: Math.atan2(sample.tangent.x, sample.tangent.z),
      };
    };
    return {
      cut: record(branchCut),
      middle: record(branchMiddle),
      side: zone.side > 0 ? 'left' : 'right',
      lanes: `${branch.lanes}->${host.lanes}`,
      a: zone.markingOpening?.branch?.[0] ?? zone.crossable.branch[0],
      b: zone.markingOpening?.branch?.[1] ?? zone.crossable.branch[1],
    };
  }, fixture);
  if (!geometry) throw new Error(`Missing validation fixture ${fixture.branch}->${fixture.host}`);

  for (const view of views) {
    const anchor = geometry[view.anchor];
    await page.evaluate(({ sample, camera }) => {
      const game = window.shutoko;
      if (!game.debug.noclip) game.setNoclip(true);
      game.debug.position.set(
        sample.position.x - sample.tangent.x * camera.back,
        sample.position.y + camera.up,
        sample.position.z - sample.tangent.z * camera.back,
      );
      game.debug.yaw = sample.heading;
      game.debug.pitch = camera.pitch;
      game._snapNoclipCamera();
      game.map._visibleKey = null;
      game.map.update(game.debug.position, performance.now() / 1000);
    }, { sample: anchor, camera: view });
    await page.waitForTimeout(500);
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(
      () => requestAnimationFrame(resolveFrame),
    )));
    const filename = `AB-${fixture.name}-${view.name}-${SUFFIX}.png`;
    await page.screenshot({ path: join(OUT, filename) });
    console.log(`${filename} | ${fixture.branch}->${fixture.host} ${geometry.side} ${geometry.lanes} A=${geometry.a.toFixed(2)} B=${geometry.b.toFixed(2)}`);
  }
}

await browser.close();
server.close();
