/**
 * Near-top-down shots of the lamp pools on several sections so a pool-vs-deck
 * occlusion cut (hard straight light/dark edge) is unmistakable. Prints the
 * bank angle at each spot. Run twice (once per bank sign) to A/B the fix.
 * Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node .devtests/pool-topdown-probe.mjs [tag]
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
const context = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1.5, hasTouch: true });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(ROOT, 'node_modules/three/build/three.module.js')) });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 30000 });
await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });
await page.evaluate(() => window.shutoko.traffic?.setDensity(0));

// Find the most-banked lamp spots by scanning bank along c1.
const spots = await page.evaluate(() => {
  const g = window.shutoko;
  const out = [];
  for (const id of ['c1', 'k1', 'wangan']) {
    const route = g.map.getRoute(id);
    if (!route) continue;
    let best = { frac: 0, bank: 0 };
    for (let f = 0.05; f < 0.95; f += 0.01) {
      const b = Math.abs(g.map._bankAt(route, route.length * f));
      if (b > best.bank) best = { frac: f, bank: b };
    }
    out.push({ id, frac: best.frac, bankDeg: +(best.bank * 180 / Math.PI).toFixed(1) });
  }
  return out;
});
console.log('most-banked spots:', JSON.stringify(spots));

for (const s of spots) {
  await page.evaluate((s) => {
    const g = window.shutoko;
    const route = g.map.getRoute(s.id);
    const lane = g.map.sampleLane(s.id, route.length * s.frac, 0, 1);
    g.physics.setPosition(lane.position.x, lane.position.y + 0.6, lane.position.z, lane.heading);
    g.setNoclip(true);
    const h = lane.heading, fx = Math.sin(h), fz = Math.cos(h);
    g.debug.position.set(lane.position.x - fx * 10, lane.position.y + 15, lane.position.z - fz * 10);
    g.debug.yaw = h;
    g.debug.pitch = -0.92;
  }, s);
  await page.waitForTimeout(1400);
  await page.screenshot({ path: join(OUT, `topdown-${TAG}-${s.id}.png`) });
  await page.evaluate(() => window.shutoko.setNoclip(false));
}
await browser.close();
server.close();
