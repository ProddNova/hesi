/**
 * Deterministic screenshots of the Tatsumi PA elevated-deck prototype. All
 * cameras derive from the runtime service-area record and route centrelines,
 * so before/after runs frame identical spots. Traffic is hidden.
 *
 *  1. top-down      — high plan view: the deck between ramp_8 and ramp_9,
 *                     overlapping the Wangan pair's footprint.
 *  2. side-elevation— broadside from outside ramp_9: vertical separation
 *                     between the deck and the Wangan carriageways.
 *  3. deck-over-wangan — 3/4 aerial along the corridor: deck above, Wangan
 *                     running underneath.
 *  4. deck-level    — on the lot surface at the future spawn anchor.
 *  5. wangan-under  — driver's view on wangan_0 approaching/passing below.
 *  6. exit-anchor   — the future wangan_0 exit anchor area at the deck's
 *                     downstream end.
 *
 * Run: CHROMIUM_PATH=... node .devtests/tatsumi-pa-shots.mjs [suffix]
 * Writes .devtests/shots/TATSUMI-<case>[-suffix].png
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
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
await page.evaluate(() => { const g = window.shutoko; if (g.traffic?.setDensity) g.traffic.setDensity(0); g.traffic?.vehicles?.forEach?.((v) => { if (v.mesh) v.mesh.visible = false; }); });

/**
 * Cases are expressed in the deck's own frame: `along`/`across` offsets from
 * the lot centre (metres), or `anchor: 'exit' | 'spawn'`, or a wangan_0
 * station offset from the deck spine (`spineAlong`).
 */
const cases = [
  { name: 'top-down', along: 0, across: 0, up: 290, pitch: -1.55, yawFrom: 'tangent' },
  { name: 'side-elevation', along: 0, across: -120, up: 10, pitch: -0.06, yawFrom: 'normal' },
  { name: 'deck-over-wangan', along: -190, across: -46, up: 46, pitch: -0.42, yawFrom: 'tangent' },
  // camera nudged off the lot's centreline so the v=0 lamppost row does not
  // block the view
  { name: 'deck-level', anchor: 'spawn', back: 34, across: -4.5, up: 3.4, pitch: -0.08, yawFrom: 'tangent' },
  { name: 'wangan-under', spineAlong: -150, up: 3.2, pitch: 0.02, yawFrom: 'spine' },
  { name: 'exit-anchor', anchor: 'exit', back: 55, up: 22, pitch: -0.34, yawFrom: 'tangent' },
];

for (const c of cases) {
  const setup = await page.evaluate((s) => {
    const map = window.shutoko.map;
    const area = (map.serviceAreas || []).find((candidate) => candidate.id === 'tatsumi_pa');
    if (!area || area.placement !== 'tatsumi-elevated-deck') return { missing: 'tatsumi deck' };
    const heading = Math.atan2(area.tangent.x, area.tangent.z);
    if (s.anchor) {
      const anchor = s.anchor === 'exit' ? area.futureAnchors?.wanganExit?.deckEdge : area.futureAnchors?.[s.anchor]?.position;
      if (!anchor) return { missing: `anchor ${s.anchor}` };
      return {
        position: {
          x: anchor.x - area.tangent.x * (s.back || 0) + area.normal.x * (s.across || 0),
          y: anchor.y + s.up,
          z: anchor.z - area.tangent.z * (s.back || 0) + area.normal.z * (s.across || 0),
        },
        yaw: heading,
      };
    }
    if (s.spineAlong !== undefined) {
      const spine = map.routes.get('wangan_0');
      const d = map._normalizeDistance(spine, area.mainDistance + s.spineAlong);
      const sample = map._sampleCenter(spine, d, 1);
      return {
        position: { x: sample.position.x, y: sample.position.y + s.up, z: sample.position.z },
        yaw: Math.atan2(sample.tangent.x, sample.tangent.z),
      };
    }
    const position = area.center.clone()
      .addScaledVector(area.tangent, s.along)
      .addScaledVector(area.normal, s.across);
    position.y = area.elevation + s.up;
    const yaw = s.yawFrom === 'normal'
      ? Math.atan2(area.normal.x, area.normal.z)
      : heading;
    return { position: { x: position.x, y: position.y, z: position.z }, yaw };
  }, c);
  if (setup.missing) { console.log(`SKIP ${c.name}: ${setup.missing}`); continue; }
  await page.evaluate(({ s, c: cc }) => {
    const g = window.shutoko;
    if (!g.debug.noclip) g.setNoclip(true);
    g.debug.position.set(s.position.x, s.position.y, s.position.z);
    g.debug.yaw = s.yaw;
    g.debug.pitch = cc.pitch;
  }, { s: setup, c });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `TATSUMI-${c.name}${SUFFIX}.png`) });
  console.log(`shot TATSUMI-${c.name}${SUFFIX}.png`);
}
await browser.close();
server.close();
