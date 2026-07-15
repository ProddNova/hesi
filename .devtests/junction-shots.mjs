/**
 * Repeatable debug screenshots of representative same-level lateral
 * junction mouths (Phase 1 of the junction rebuild). Camera positions are
 * derived from route centrelines only, so before/after runs frame the
 * exact same spot regardless of deck-geometry changes.
 *
 * Cases: right merge, right diverge, left merge, left diverge, and one
 * wider multi-lane junction — chosen from .devtests/lateral-junction-audit.mjs.
 *
 * Run: CHROMIUM_PATH=... node .devtests/junction-shots.mjs [suffix]
 * Writes .devtests/shots/J-<case>-{oblique,top,chase}[-suffix].png
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const SUFFIX = process.argv[2] ? `-${process.argv[2]}` : '';
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
const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
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
// hide live traffic so geometry shots are deterministic
await page.evaluate(() => { const g = window.shutoko; if (g.traffic?.setDensity) g.traffic.setDensity(0); g.traffic?.vehicles?.forEach?.((v) => { if (v.mesh) v.mesh.visible = false; }); });

/**
 * Representative same-level lateral junctions (audit catalogue keys):
 *  - branchS: branch station at the gore/split (from the audit's splitStation)
 *    used to centre the camera on the junction mouth.
 */
const cases = [
  { name: 'right-merge-r1_3-ramp_12', branch: 'ramp_12', which: 'end', host: 'r1_3', branchS: 100 },
  { name: 'right-diverge-c1_0-ramp_22', branch: 'ramp_22', which: 'start', host: 'c1_0', branchS: 170 },
  { name: 'left-merge-k1_0-ramp_42', branch: 'ramp_42', which: 'end', host: 'k1_0', branchS: 100 },
  { name: 'left-diverge-k1_0-ramp_42', branch: 'ramp_42', which: 'start', host: 'k1_0', branchS: 116 },
  { name: 'wide-diverge-wangan_0-ramp_2', branch: 'ramp_2', which: 'start', host: 'wangan_0', branchS: 240 },
];

for (const junction of cases) {
  const setup = await page.evaluate((c) => {
    const g = window.shutoko;
    const map = g.map;
    let branch;
    let host;
    try { branch = map.getRoute(c.branch); host = map.getRoute(c.host); } catch { return { missing: true }; }
    const stationAt = (s) => (c.which === 'start' ? s : branch.length - s);
    const goreSample = map._sampleCenter(branch, stationAt(c.branchS), 1);
    const hostProjection = map._projectToRoute(host, goreSample.position);
    const gore = goreSample.position.clone().lerp(hostProjection.point, 0.5);
    const tangent = hostProjection.tangent.clone();
    if (c.which === 'end') tangent.multiplyScalar(1); // travel direction of the host
    return {
      gore: { x: gore.x, y: gore.y, z: gore.z },
      tangent: { x: tangent.x, y: tangent.y, z: tangent.z },
      heading: Math.atan2(tangent.x, tangent.z),
    };
  }, junction);
  if (setup.missing) { console.log(`SKIP ${junction.name}`); continue; }

  // 1. elevated oblique — looking along the host through the mouth
  await page.evaluate(({ setup: s }) => {
    const g = window.shutoko;
    if (!g.debug.noclip) g.setNoclip(true);
    g.debug.position.set(s.gore.x - s.tangent.x * 65, s.gore.y + 20, s.gore.z - s.tangent.z * 65);
    g.debug.yaw = s.heading;
    g.debug.pitch = -0.34;
  }, { setup });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `J-${junction.name}-oblique${SUFFIX}.png`) });

  // 2. top-down — straight above the gore
  await page.evaluate(({ setup: s }) => {
    const g = window.shutoko;
    g.debug.position.set(s.gore.x, s.gore.y + 78, s.gore.z);
    g.debug.yaw = s.heading;
    g.debug.pitch = -1.45;
  }, { setup });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, `J-${junction.name}-top${SUFFIX}.png`) });

  // 3. chase — drive view approaching the mouth on the branch (diverge) or
  //    toward the merge point (merge)
  await page.evaluate((c) => {
    const g = window.shutoko;
    const map = g.map;
    const branch = map.getRoute(c.branch);
    if (g.debug.noclip) g.setNoclip(false);
    const s = c.which === 'start' ? Math.max(6, c.branchS - 80) : Math.min(branch.length - 6, branch.length - c.branchS - 40);
    const lane = map.sampleLane(branch.id, s, 0, 1);
    g.physics.setPosition(lane.position.x, lane.position.y + 0.6, lane.position.z, lane.heading);
    g.physics.setSpeed(0);
    g.snapDrivingCamera();
  }, junction);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, `J-${junction.name}-chase${SUFFIX}.png`) });
  console.log(`shot J-${junction.name}-{oblique,top,chase}${SUFFIX}.png`);
}
await browser.close();
server.close();
