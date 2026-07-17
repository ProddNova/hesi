/**
 * Asphalt art-direction candidate comparison. Loads the game three times
 * with ?asphaltStyle=A|B|C (see js/textures.js ASPHALT_STYLES) and captures
 * the two decisive views per candidate — low road close-up and chase
 * framing — plus the barrier/pillar view (concrete language) and skyline
 * (facade language) once per candidate.
 *
 * Run: CHROMIUM_PATH=/opt/pw-browsers/chromium node .devtests/ps2-texture-candidates.mjs
 * Writes .devtests/shots/PS2-cand-<style>-<case>.png
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

for (const style of ['A', 'B', 'C']) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 2 });
  await context.route('https://cdn.jsdelivr.net/**', async (route) => {
    const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
    await route.fulfill({ status: 200, contentType: 'text/javascript', body });
  });
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (error) => console.error('pageerror:', String(error)));
  await page.goto(`http://127.0.0.1:${port}/?asphaltStyle=${style}`);
  await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });
  await page.click('#new-game-button');
  await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 8000 });
  await page.evaluate(() => window.shutoko.exitGarage());
  await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 5000 });
  await page.evaluate(() => {
    const g = window.shutoko;
    if (!g.debug.noclip) g.setNoclip(true);
    g.traffic?.setDensity?.(0);
    g.traffic?.pool?.forEach?.((v) => { if (v.mesh) v.mesh.visible = false; });
    document.querySelector('#hud')?.setAttribute('style', 'display:none!important');
    document.querySelector('#debug-drone-hud')?.setAttribute('style', 'display:none!important');
    document.querySelector('#toast-stack')?.setAttribute('style', 'display:none!important');
  });
  const cases = await page.evaluate(() => {
    const map = window.shutoko.map;
    const at = (routeId, distance, { lat = 0, up = 3, yawOff = 0, pitch = -0.06, back = 0 } = {}) => {
      const route = map.routes.get(routeId);
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
    return [
      { name: 'closeup', view: at('wangan_0', 26000, { up: 1.6, lat: 2, pitch: -0.32 }) },
      { name: 'chase', view: at('wangan_0', 26150, { up: 2.7, back: 7, pitch: -0.07 }) },
      { name: 'barrier', view: at('wangan_0', 26600, { up: 5, lat: -21, yawOff: 0.55, pitch: -0.2 }) },
      { name: 'skyline', view: at('c1_0', 5200, { up: 9, back: 14, pitch: 0.02 }) },
    ];
  });
  for (const c of cases) {
    await page.evaluate(({ view }) => {
      const g = window.shutoko;
      g.debug.position.set(view.position.x, view.position.y, view.position.z);
      g.debug.yaw = view.yaw;
      g.debug.pitch = view.pitch;
    }, c);
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, `PS2-cand-${style}-${c.name}.png`) });
    console.log(`shot PS2-cand-${style}-${c.name}.png`);
  }
  await context.close();
}
await browser.close();
server.close();
