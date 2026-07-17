/**
 * PS2 visual-overhaul reference screenshots + performance metrics.
 *
 * Deterministic cameras for before/after comparison of the full visual
 * overhaul. All positions are world-space fixtures (not derived from any
 * material/lighting state), so baseline and restyled runs frame identical
 * spots:
 *
 *   1.  road-closeup     — low camera just above the Wangan asphalt
 *   2.  chase-view       — standard chase framing on the Wangan
 *   3.  wangan-night     — long Wangan straight at night
 *   4.  barriers-pillars — barrier/parapet + support pillars from outside
 *   5.  industrial       — K1 industrial roadside
 *   6.  skyline          — dense skyline from the C1
 *   7.  parked-trucks    — Daikoku PA parked vehicles
 *   8.  garage           — garage interior from the player spawn
 *   9.  hud-driving      — HUD over a driving view (UI visible)
 *   10. garage-ui        — Wangan Market PC overlay
 *
 * Also records renderer.info (draw calls, triangles, textures, programs) and
 * a rough main-thread frame time for the chase view, written to
 * .devtests/shots/PS2-metrics[-suffix].json.
 *
 * Run: node .devtests/ps2-style-shots.mjs [suffix]
 * Writes .devtests/shots/PS2-<case>[-suffix].png
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
const context = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (error) => console.error('pageerror:', String(error)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });

// --- garage interior shot from the player spawn (before leaving) -----------
await page.evaluate(() => {
  const g = window.shutoko.garage;
  g.position.set(0, 1.72, 9.5); g.yaw = 0; g.pitch = -0.05; g.updateCamera();
});
await page.waitForTimeout(700);
await page.screenshot({ path: join(OUT, `PS2-garage${SUFFIX}.png`) });
console.log(`shot PS2-garage${SUFFIX}.png`);

await page.evaluate(() => {
  const g = window.shutoko.garage;
  g.position.set(-6.4, 1.72, -3.5); g.yaw = Math.PI * 0.78; g.pitch = -0.03; g.updateCamera();
});
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, `PS2-garage-bench${SUFFIX}.png`) });
console.log(`shot PS2-garage-bench${SUFFIX}.png`);

// --- garage/PC UI ----------------------------------------------------------
await page.evaluate(() => window.shutoko.ui.openPC(window.shutoko.getPCContext()));
await page.waitForTimeout(800);
await page.screenshot({ path: join(OUT, `PS2-garage-ui${SUFFIX}.png`) });
console.log(`shot PS2-garage-ui${SUFFIX}.png`);
await page.evaluate(() => window.shutoko.ui.closePC());

// --- to the highway --------------------------------------------------------
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });
await page.waitForTimeout(600);

// HUD over a driving view: drive forward briefly so speed/rpm are alive.
await page.evaluate(() => { window.shutoko.keys.KeyW = true; });
await page.waitForTimeout(2600);
await page.evaluate(() => { window.shutoko.keys.KeyW = false; });
await page.screenshot({ path: join(OUT, `PS2-hud-driving${SUFFIX}.png`) });
console.log(`shot PS2-hud-driving${SUFFIX}.png`);

// Frame-time probe: measure rAF deltas over ~3 s in the driving view.
await page.evaluate(() => { window.shutoko.keys.KeyW = true; });
const frameStats = await page.evaluate(() => new Promise((resolve) => {
  const deltas = [];
  let last = performance.now();
  let frames = 0;
  const tick = (now) => {
    deltas.push(now - last); last = now; frames += 1;
    if (frames < 180) requestAnimationFrame(tick);
    else {
      deltas.sort((a, b) => a - b);
      const sum = deltas.reduce((total, d) => total + d, 0);
      resolve({
        meanMs: sum / deltas.length,
        p50Ms: deltas[Math.floor(deltas.length * 0.5)],
        p95Ms: deltas[Math.floor(deltas.length * 0.95)],
        maxMs: deltas[deltas.length - 1],
      });
    }
  };
  requestAnimationFrame(tick);
}));
await page.evaluate(() => { window.shutoko.keys.KeyW = false; });

const rendererInfo = await page.evaluate(() => {
  const info = window.shutoko.renderer.info;
  return {
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs?.length ?? null,
  };
});

// --- fixed world cameras via noclip ---------------------------------------
await page.evaluate(() => {
  const g = window.shutoko;
  if (!g.debug.noclip) g.setNoclip(true);
  g.traffic?.setDensity?.(0);
  g.traffic?.pool?.forEach?.((v) => { if (v.mesh) v.mesh.visible = false; });
});

// Resolve fixture positions from route samplers so they sit on real road.
const cases = await page.evaluate(() => {
  const map = window.shutoko.map;
  const at = (routeId, distance, { lat = 0, up = 3, yawOff = 0, pitch = -0.06, back = 0 } = {}) => {
    const route = map.routes.get(routeId);
    if (!route) return null;
    const d = map._normalizeDistance(route, distance);
    const frame = map._frameAt(route, d);
    const position = frame.position.clone()
      .addScaledVector(frame.normal, lat)
      .addScaledVector(frame.tangent, -back);
    position.y += up;
    return {
      position: { x: position.x, y: position.y, z: position.z },
      yaw: Math.atan2(frame.tangent.x, frame.tangent.z) + yawOff,
      pitch,
    };
  };
  const daikoku = (map.serviceAreas || []).find((a) => a.density === 'packed');
  const daikokuView = daikoku ? {
    position: {
      x: daikoku.center.x - daikoku.tangent.x * (daikoku.length * 0.42) + daikoku.normal.x * (daikoku.width * 0.4),
      y: daikoku.elevation + 5,
      z: daikoku.center.z - daikoku.tangent.z * (daikoku.length * 0.42) + daikoku.normal.z * (daikoku.width * 0.4),
    },
    yaw: Math.atan2(daikoku.tangent.x, daikoku.tangent.z) - 0.5,
    pitch: -0.18,
  } : null;
  return [
    { name: 'road-closeup', view: at('wangan_0', 26000, { up: 1.6, lat: 2, pitch: -0.32 }) },
    { name: 'chase-view', view: at('wangan_0', 26150, { up: 2.7, back: 7, pitch: -0.07 }) },
    { name: 'wangan-night', view: at('wangan_0', 27600, { up: 4.2, back: 10, pitch: -0.05 }) },
    { name: 'barriers-pillars', view: at('wangan_0', 26600, { up: 5, lat: -21, yawOff: 0.55, pitch: -0.2 }) },
    { name: 'industrial', view: at('k1_0', 4200, { up: 6, lat: 16, yawOff: -0.5, pitch: -0.1 }) },
    { name: 'skyline', view: at('c1_0', 5200, { up: 9, back: 14, pitch: 0.02 }) },
    { name: 'tunnel', view: (map.routes.get('c1_0')?.tunnels?.length
      ? at('c1_0', (map.routes.get('c1_0').tunnels[0].startDistance + map.routes.get('c1_0').tunnels[0].endDistance) / 2, { up: 2.4, pitch: -0.03 })
      : null) },
    { name: 'parked-trucks', view: daikokuView },
  ];
});

for (const c of cases) {
  if (!c.view) { console.log(`SKIP ${c.name}`); continue; }
  await page.evaluate(({ view }) => {
    const g = window.shutoko;
    g.debug.position.set(view.position.x, view.position.y, view.position.z);
    g.debug.yaw = view.yaw;
    g.debug.pitch = view.pitch;
  }, c);
  await page.waitForTimeout(850);
  await page.screenshot({ path: join(OUT, `PS2-${c.name}${SUFFIX}.png`) });
  console.log(`shot PS2-${c.name}${SUFFIX}.png`);
}

const metrics = { suffix: SUFFIX || '(none)', frameStats, rendererInfo, capturedAt: new Date().toISOString() };
await writeFile(join(OUT, `PS2-metrics${SUFFIX}.json`), JSON.stringify(metrics, null, 2));
console.log('metrics', JSON.stringify(metrics));

await browser.close();
server.close();
