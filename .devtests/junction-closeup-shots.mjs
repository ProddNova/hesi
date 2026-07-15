/**
 * Close-range screenshots of junction FINISHING details: gore-wedge paint
 * (the user-reported slash/backslash marks), merge dash boundaries and rail
 * terminals. Cameras derive from route centrelines only, so before/after
 * runs frame identical spots.
 *
 * Run: CHROMIUM_PATH=... node .devtests/junction-closeup-shots.mjs [suffix]
 * Writes .devtests/shots/JC-<case>[-suffix].png
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const PA_LANES = process.argv.includes('--paAccessLanes'); // restore disabled PA lanes (?paAccessLanes=1)
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
const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (error) => console.error('pageerror:', String(error)));
await page.goto(`http://127.0.0.1:${port}/${PA_LANES ? '?paAccessLanes=1' : ''}`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });
await page.evaluate(() => { const g = window.shutoko; if (g.traffic?.setDensity) g.traffic.setDensity(0); g.traffic?.vehicles?.forEach?.((v) => { if (v.mesh) v.mesh.visible = false; }); });

/**
 * Each case: anchor on a route station, camera hovers close (low altitude)
 * looking along the tangent. `which`/`host` cases centre on the junction
 * zone's crossable interval midpoint instead of a raw station.
 */
const cases = [
  // merge wedges (gore chevron paint) — one-lane branch into two-lane host
  { name: 'wedge-left-merge-k1_0-ramp_42', branch: 'ramp_42', host: 'k1_0', which: 'end', at: 'gore', up: 26, back: 30, pitch: -0.72 },
  { name: 'wedge-right-merge-r1_3-ramp_12', branch: 'ramp_12', host: 'r1_3', which: 'end', at: 'gore', up: 26, back: 30, pitch: -0.72 },
  { name: 'wedge-right-merge-c1_0-r6_3', branch: 'r6_3', host: 'c1_0', which: 'end', at: 'gore', up: 26, back: 30, pitch: -0.72 },
  { name: 'wedge-right-merge-c1_0-c1_3', branch: 'c1_3', host: 'c1_0', which: 'end', at: 'gore', up: 26, back: 30, pitch: -0.72 },
  // same spots from a low chase-like angle (paint direction readability)
  { name: 'low-left-merge-k1_0-ramp_42', branch: 'ramp_42', host: 'k1_0', which: 'end', at: 'gore', up: 6, back: 46, pitch: -0.12 },
  { name: 'low-right-merge-r1_3-ramp_12', branch: 'ramp_12', host: 'r1_3', which: 'end', at: 'gore', up: 6, back: 46, pitch: -0.12 },
  // diverge gore
  { name: 'wedge-right-diverge-c1_0-ramp_22', branch: 'ramp_22', host: 'c1_0', which: 'start', at: 'gore', up: 26, back: 30, pitch: -0.72 },
  // the Shibaura PA garage connector (both mouths + the lot run) — anchored
  // on the HOST carriageway via the service-area record, so the framing is
  // identical whether or not the access lane exists at runtime
  { name: 'pa-shibaura-diverge', pa: 'shibaura_pa', along: -180, up: 22, back: 36, pitch: -0.5 },
  { name: 'pa-shibaura-lot', pa: 'shibaura_pa', along: 0, up: 30, back: 40, pitch: -0.55 },
  { name: 'pa-shibaura-merge', pa: 'shibaura_pa', along: 180, up: 22, back: 36, pitch: -0.5 },
];

for (const c of cases) {
  const setup = await page.evaluate((s) => {
    const g = window.shutoko;
    const map = g.map;
    let anchor = null;
    let tangent = null;
    if (s.pa) {
      const area = (map.serviceAreas || []).find((candidate) => candidate.id === s.pa);
      if (!area) return { missing: s.pa };
      const host = map.routes.get(area.routeId);
      if (!host) return { missing: area.routeId };
      const d = map._normalizeDistance(host, area.mainDistance + s.along);
      const sample = map._sampleCenter(host, d, 1);
      anchor = sample.position.clone();
      tangent = sample.tangent.clone();
    } else if (s.route) {
      let route;
      try { route = map.getRoute(s.route); } catch { return { missing: s.route }; }
      const d = s.d ?? (s.dFromEnd !== undefined ? route.length - s.dFromEnd : route.length * s.frac);
      const sample = map._sampleCenter(route, Math.max(0, Math.min(route.length, d)), 1);
      anchor = sample.position.clone();
      tangent = sample.tangent.clone();
    } else {
      let branch; let host;
      try { branch = map.getRoute(s.branch); host = map.getRoute(s.host); } catch { return { missing: `${s.branch}/${s.host}` }; }
      const zone = (map.junctionZones || []).find((z) => z.branch === branch && z.host === host && z.which === s.which);
      if (!zone || !zone.crossable) return { missing: `zone ${s.branch}->${s.host}` };
      // 'gore': the mouth end of the crossable interval, where the wedge
      // paint lives (merge: interval end toward branch tail; diverge: start)
      const hs = s.which === 'end'
        ? zone.crossable.host[s.at === 'gore' ? 0 : 1]
        : zone.crossable.host[s.at === 'gore' ? 1 : 0];
      const sample = map._sampleCenter(host, map._normalizeDistance(host, hs), 1);
      anchor = sample.position.clone();
      tangent = sample.tangent.clone();
    }
    return {
      anchor: { x: anchor.x, y: anchor.y, z: anchor.z },
      tangent: { x: tangent.x, y: tangent.y, z: tangent.z },
      heading: Math.atan2(tangent.x, tangent.z),
    };
  }, c);
  if (setup.missing) { console.log(`SKIP ${c.name}: ${setup.missing}`); continue; }
  await page.evaluate(({ s, c: cc }) => {
    const g = window.shutoko;
    if (!g.debug.noclip) g.setNoclip(true);
    g.debug.position.set(
      s.anchor.x - s.tangent.x * cc.back,
      s.anchor.y + cc.up,
      s.anchor.z - s.tangent.z * cc.back,
    );
    g.debug.yaw = s.heading;
    g.debug.pitch = cc.pitch;
  }, { s: setup, c });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `JC-${c.name}${SUFFIX}.png`) });
  console.log(`shot JC-${c.name}${SUFFIX}.png`);
}
await browser.close();
server.close();
