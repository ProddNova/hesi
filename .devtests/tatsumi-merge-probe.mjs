/**
 * Survey the 2-lane -> 3-lane merge near Tatsumi PA. Logs routes near the PA
 * with their lane counts, then shoots the area from an aerial and a low angle,
 * once with the additive light pools/streaks visible and once with them hidden,
 * so we can tell whether the reported "spikes" are the light planes or the road.
 * Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node .devtests/tatsumi-merge-probe.mjs [tag]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = process.argv[2] || 'now';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
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
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const context = await browser.newContext({ viewport: { width: 1000, height: 640 }, deviceScaleFactor: 1.5, hasTouch: true });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(ROOT, 'node_modules/three/build/three.module.js')) });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => console.error('pageerror:', String(e)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 30000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });
await page.evaluate(() => window.shutoko.traffic?.setDensity(0));

const info = await page.evaluate(() => {
  const g = window.shutoko;
  const pa = g.map.serviceAreas.find((a) => a.id === 'tatsumi_pa');
  const c = pa ? pa.center : { x: 0, y: 0, z: 0 };
  const near = [];
  for (const route of g.map.routes.values()) {
    // sample a few stations; keep routes passing within 400 m of the PA centre
    let best = Infinity, bestS = 0, bestY = 0;
    for (let f = 0; f <= 1.0001; f += 0.02) {
      const s = route.length * f;
      const p = g.map.sampleLane(route.id, s, 0, 1)?.position;
      if (!p) continue;
      const d = Math.hypot(p.x - c.x, p.z - c.z);
      if (d < best) { best = d; bestS = s; bestY = p.y; }
    }
    if (best < 420) near.push({ id: route.id, lanes: route.lanes, len: Math.round(route.length), dist: Math.round(best), s: Math.round(bestS), y: Math.round(bestY) });
  }
  near.sort((a, b) => a.dist - b.dist);
  return { center: { x: Math.round(c.x), y: Math.round(c.y), z: Math.round(c.z) }, near };
});
console.log('tatsumi center:', JSON.stringify(info.center));
console.log('nearby routes:', JSON.stringify(info.near, null, 0));

const shoot = async (name, cam, hidePools) => {
  await page.evaluate(({ cam, hidePools }) => {
    const g = window.shutoko;
    g.setNoclip(true);
    g.debug.position.set(cam.x, cam.y, cam.z);
    g.debug.yaw = cam.yaw; g.debug.pitch = cam.pitch;
    g.roadScene.traverse((o) => { if (o.name && /light(Pool|Streak)/.test(o.name)) o.visible = !hidePools; });
  }, { cam, hidePools });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(OUT, `tatsumi-${TAG}-${name}.png`) });
};

const c = info.center;
// aerial looking down-ish over the PA merge, and a low oblique
await shoot('aerial-pools', { x: c.x - 40, y: c.y + 120, z: c.z + 160, yaw: Math.atan2(40, -160), pitch: -0.7 }, false);
await shoot('aerial-nopools', { x: c.x - 40, y: c.y + 120, z: c.z + 160, yaw: Math.atan2(40, -160), pitch: -0.7 }, true);
await shoot('oblique-pools', { x: c.x - 30, y: c.y + 35, z: c.z + 120, yaw: Math.atan2(30, -120), pitch: -0.28 }, false);
await shoot('oblique-nopools', { x: c.x - 30, y: c.y + 35, z: c.z + 120, yaw: Math.atan2(30, -120), pitch: -0.28 }, true);
await page.evaluate(() => window.shutoko.setNoclip(false));
await browser.close();
server.close();
