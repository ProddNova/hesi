/**
 * Driver-level scan along the 2-lane ramp_8 (and ramp_9) that merges into the
 * 3-lane wangan near Tatsumi PA, to locate the reported spikes and light/dark
 * cuts. Each station is shot with pools ON and OFF to isolate the light planes.
 * Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node .devtests/ramp-scan-probe.mjs [route] [tag]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTE = process.argv[2] || 'ramp_8';
const TAG = process.argv[3] || 'now';
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
const context = await browser.newContext({ viewport: { width: 1000, height: 600 }, deviceScaleFactor: 1.5, hasTouch: true });
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

const fracs = [0.1, 0.25, 0.4, 0.5, 0.6, 0.72, 0.85, 0.95];
for (const f of fracs) {
  const ok = await page.evaluate(({ ROUTE, f }) => {
    const g = window.shutoko;
    const route = g.map.getRoute(ROUTE);
    if (!route) return false;
    const lane = g.map.sampleLane(ROUTE, route.length * f, 0, 1);
    if (!lane) return false;
    g.setNoclip(true);
    const h = lane.heading, fx = Math.sin(h), fz = Math.cos(h);
    g.debug.position.set(lane.position.x - fx * 9, lane.position.y + 3.2, lane.position.z - fz * 9);
    g.debug.yaw = h; g.debug.pitch = -0.14;
    return true;
  }, { ROUTE, f });
  if (!ok) continue;
  const label = String(Math.round(f * 100)).padStart(2, '0');
  await page.evaluate(() => window.shutoko.roadScene.traverse((o) => { if (o.name && /light(Pool|Streak)/.test(o.name)) o.visible = true; }));
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, `ramp-${TAG}-${ROUTE}-${label}-pools.png`) });
  await page.evaluate(() => window.shutoko.roadScene.traverse((o) => { if (o.name && /light(Pool|Streak)/.test(o.name)) o.visible = false; }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `ramp-${TAG}-${ROUTE}-${label}-nopools.png`) });
}
await page.evaluate(() => window.shutoko.setNoclip(false));
await browser.close();
server.close();
