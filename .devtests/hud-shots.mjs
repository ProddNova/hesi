/**
 * Visual check for the HUD 2.0 redesign: boots the game headless and shoots
 * boot screen, driving HUD (with speed on the dials), splash/toasts, phone,
 * PC auction terminal and the crash modal. Screenshots to .devtests/shots/.
 *
 * Run: node .devtests/hud-shots.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' };

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
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const url = new URL(route.request().url());
  const addon = url.pathname.match(/examples\/jsm\/(.+)$/);
  const file = addon ? `node_modules/three/examples/jsm/${addon[1]}` : 'node_modules/three/build/three.module.js';
  const body = await readFile(join(ROOT, file));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });

// 1 — boot screen
await page.screenshot({ path: join(OUT, 'hud-01-boot.png') });

// 2 — driving HUD at speed (dials up, combo, splash, toasts, prompt)
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 15000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 10000 });
await page.evaluate(() => {
  const g = window.shutoko;
  g.physics.setSpeed?.(52); g.physics.setVelocity?.(52);
  g.run.score = 128450; g.run.combo = 2.5; g.run.comboTimer = 3; g.run.nearMisses = 4; g.run.lives = 2;
  g.ui.nearMiss(1240, true);
  g.ui.toast('TATSUMI PA // DRIVE SAFE', 'amber');
  g.ui.toast('REFUELED 32.0L // ¥5\'440', 'cyan');
  g.ui.prompt('<kbd>E</kbd> ENTER WANGAN WORKS GARAGE', true);
});
await page.waitForTimeout(300);
await page.screenshot({ path: join(OUT, 'hud-02-driving.png') });

// 3 — phone home + an app
await page.evaluate(() => { window.shutoko.ui.prompt('', false); window.shutoko.ui.openPhone(window.shutoko.getPhoneContext()); });
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'hud-03-phone.png') });
await page.evaluate(() => window.shutoko.ui.openPhoneApp('stats'));
await page.waitForTimeout(300);
await page.screenshot({ path: join(OUT, 'hud-04-phone-app.png') });

// 4 — PC auction terminal (inject seeded lots if the dev catalog is thin)
await page.evaluate(() => {
  const g = window.shutoko;
  if (!g.state.auctions?.length) {
    const src = g.catalog?.length ? g.catalog : [{ id: 'c1', name: 'NISSAN SILVIA S13', year: 1991, price: 890000, power: 205, drivetrain: 'FR' }];
    const colors = ['#c73642', '#2e5fc7', '#d8d5c9', '#3a3f47', '#c7a12e', '#5a2e8c'];
    g.state.auctions = src.slice(0, 6).map((car, i) => ({ id: 'lot-' + i, carId: car.id, car: { ...car }, year: car.year || 1994, mileage: 42000 + i * 17000, grade: ['3.5', '4', '4.5'][i % 3], price: (car.price || 800000) + i * 90000, effectivePower: car.power || car.horsepower || 150, color: colors[i % 6] }));
  }
  g.ui.closePhone(); g.ui.openPC(g.getPCContext());
});
await page.waitForTimeout(1200);
await page.screenshot({ path: join(OUT, 'hud-05-pc.png') });

// 5 — crash modal + loading look
await page.evaluate(() => { window.shutoko.ui.closePC(); window.shutoko.ui.showRunOver(128450); });
await page.waitForTimeout(300);
await page.screenshot({ path: join(OUT, 'hud-06-crash.png') });

console.log(JSON.stringify({ errors }, null, 1));
await browser.close();
server.close();
