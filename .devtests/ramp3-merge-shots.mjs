/**
 * Fixed cameras on the ramp 30 -> ramp 3 merge (P5,
 * `J39:merge:ramp_3:ramp_30:end`) — P3's model on a two-lane host, at the head
 * of R11 Daiba.
 *
 * Cameras derive from the host centreline only, so the legacy and progressive
 * runs frame identical spots and can be compared directly.
 *
 * Run: node .devtests/ramp3-merge-shots.mjs [suffix] [--legacy]
 * Writes .devtests/shots/RM-<case>[-suffix].png
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const LEGACY = process.argv.includes('--legacy');
const suffixArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const SUFFIX = suffixArg ? `-${suffixArg}` : (LEGACY ? '-legacy' : '');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/json' };

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(ROOT, decodeURIComponent(file)));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
// The game imports both `three` and `three/addons/...`; a blanket jsdelivr
// route serves the core build for the addon URLs and kills the page.
await context.route('https://cdn.jsdelivr.net/**/examples/jsm/**', async (route) => {
  const rest = route.request().url().split('/examples/jsm/')[1];
  await route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: await readFile(join(ROOT, 'node_modules/three/examples/jsm', rest)),
  });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (error) => console.error('pageerror:', String(error)));
await page.goto(`http://127.0.0.1:${port}/${LEGACY ? '?legacyProgressiveMerges=1' : ''}`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 90000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 15000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 15000 });
await page.evaluate(() => {
  const g = window.shutoko;
  if (g.traffic?.setDensity) g.traffic.setDensity(0);
  g.traffic?.vehicles?.forEach?.((v) => { if (v.mesh) v.mesh.visible = false; });
});

// Stations are host chainages on `ramp_3`: approach 788.5, opening 814.3,
// FULL 4 865.0, 4 -> 3 913.2 -> 961.4, 3 -> 2 1009.6 -> 1057.7.
const cases = [
  { name: 'plan-approach', at: 800, up: 120, back: 30, pitch: -1.2 },
  { name: 'plan-full-four', at: 890, up: 120, back: 30, pitch: -1.2 },
  { name: 'plan-absorptions', at: 990, up: 130, back: 30, pitch: -1.2 },
  { name: 'before-chase', at: 780, up: 6, back: 26, pitch: -0.06 },
  { name: 'opening-chase', at: 830, up: 6, back: 26, pitch: -0.06 },
  { name: 'four-lane-chase', at: 880, up: 6, back: 26, pitch: -0.06 },
  { name: 'first-taper-chase', at: 935, up: 6, back: 26, pitch: -0.06 },
  { name: 'three-lane-chase', at: 985, up: 6, back: 26, pitch: -0.06 },
  { name: 'second-taper-chase', at: 1035, up: 6, back: 26, pitch: -0.06 },
  { name: 'after-chase', at: 1075, up: 6, back: 26, pitch: -0.06 },
  // Driver's eye in the arriving ramp lanes themselves.
  { name: 'aux1-eye', at: 880, up: 1.7, back: 24, pitch: -0.03, lateral: -10.6 },
  { name: 'aux0-eye', at: 975, up: 1.7, back: 24, pitch: -0.03, lateral: -7.1 },
];


for (const c of cases) {
  const setup = await page.evaluate((s) => {
    const g = window.shutoko;
    const map = g.map;
    const host = map.getRoute('ramp_3');
    const sample = map._sampleCenter(host, map._normalizeDistance(host, s.at), 1);
    const anchor = sample.position.clone();
    const tangent = sample.tangent.clone();
    if (s.lateral) {
      const frame = map._frameAt(host, map._normalizeDistance(host, s.at));
      anchor.addScaledVector(frame.normal, s.lateral);
    }
    return {
      anchor: { x: anchor.x, y: anchor.y, z: anchor.z },
      tangent: { x: tangent.x, y: tangent.y, z: tangent.z },
      heading: Math.atan2(tangent.x, tangent.z),
    };
  }, c);
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
  await page.screenshot({ path: join(OUT, `RM-${c.name}${SUFFIX}.png`) });
  console.log(`shot RM-${c.name}${SUFFIX}.png`);
}
await browser.close();
server.close();
