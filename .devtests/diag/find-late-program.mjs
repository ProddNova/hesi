/** Finds which shader programs compile during driving (after the prewarm). */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/home/user/hesi/';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = path === '/' ? '/index.html' : decodeURIComponent(path);
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 880, height: 500 } });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 15000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 15000 });
await page.waitForTimeout(1500);
const list = () => page.evaluate(() => window.shutoko.renderer.info.programs.map((p) => ({
  id: p.id,
  name: p.name || 'unnamed',
  key: String(p.cacheKey),
})));
const atDriveStart = await list();
await page.evaluate(() => {
  const game = window.shutoko;
  const clampValue = (value, low, high) => Math.min(high, Math.max(low, value));
  const wrapAngle = (value) => { const tau = Math.PI * 2; return ((value + Math.PI) % tau + tau) % tau - Math.PI; };
  game.registerContact = () => {};
  game.admin.infiniteFuel = true;
  let preferredRoute = null;
  game.getInput = () => {
    const physics = game.physics;
    let steer = 0; let throttle = 1; let brake = 0;
    try {
      const info = game.map.getRoadInfo(physics.position, preferredRoute);
      if (info) {
        preferredRoute = info.routeId;
        const speed = physics.velocity.length();
        const direction = info.direction || 1;
        const target = game.map.sampleLane(info.routeId, info.distance + (15 + speed * 0.6) * direction, Math.min(info.lane ?? 0, (info.lanes ?? 1) - 1), direction);
        if (target) steer = clampValue(wrapAngle(Math.atan2(target.position.x - physics.position.x, target.position.z - physics.position.z) - physics.heading) * 2.4, -1, 1);
        const kmh = speed * 3.6;
        throttle = kmh < 125 ? 1 : 0; brake = kmh > 140 ? 0.4 : 0;
      }
    } catch { /* keep last */ }
    return { throttle, brake, steer, handbrake: false, shiftUp: false, shiftDown: false, clutch: false };
  };
});
console.log('driving 75s ...');
await page.waitForTimeout(75000);
const atEnd = await list();
const startIds = new Set(atDriveStart.map((p) => p.id));
console.log(`programs at drive start: ${atDriveStart.length}, at end: ${atEnd.length}`);
for (const program of atEnd.filter((p) => !startIds.has(p.id))) {
  console.log('LATE COMPILE:', program.id, program.name);
  const prefix = program.key.split(',').slice(0, 1)[0];
  const lateParts = program.key.split(',');
  for (const other of atDriveStart.filter((p) => p.key.startsWith(`${prefix},`))) {
    const otherParts = other.key.split(',');
    const diffs = [];
    for (let i = 0; i < Math.max(lateParts.length, otherParts.length); i += 1) {
      if (lateParts[i] !== otherParts[i]) diffs.push(`[${i}] '${otherParts[i]}' -> '${lateParts[i]}'`);
    }
    console.log(`  vs id=${other.id}: ${diffs.length} diffs: ${diffs.slice(0, 12).join(' ; ')}`);
  }
}
await browser.close();
server.close();
