/**
 * Render-resolution probe (desktop).
 *
 * The reported bug: the game looks pixelated on PC. The internal framebuffer
 * was the cause — desktop booted the adaptive governor at .82 and multiplied it
 * by a .75 "Medium" quality scale, so the default tier drew ~62% linear (38% of
 * the pixels) and stretched the result over a native canvas. On top of that the
 * governor judged each frame's CPU work against a hardcoded 1000/144 ms budget,
 * so a 60 Hz PC with plenty of headroom still walked the scale down to its
 * floor.
 *
 * Checks, on the default (Medium) settings a fresh save gets:
 *   - the drawing buffer matches the CSS viewport × DPR (native, no upscale),
 *   - the mip bias handed to the map is 0 (nothing to compensate for),
 *   - High is native too, and Low is the only tier that renders below it,
 *   - the governor's budget follows the observed display cadence, not 144 fps.
 *
 * Run: node .devtests/render-resolution-probe.mjs
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.obj': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg',
};

const server = createServer(async (request, response) => {
  try {
    const urlPath = request.url.split('?')[0];
    const file = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
    const body = await readFile(join(ROOT, file));
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
// Split routing is mandatory — see the note in vhs-car-paint-probe.mjs.
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const url = new URL(route.request().url());
  const addon = url.pathname.match(/\/examples\/jsm\/(.+)$/);
  const file = addon
    ? join(ROOT, 'node_modules', 'three', 'examples', 'jsm', addon[1])
    : join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(file) });
});

const page = await context.newPage();
const errors = [];
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
page.on('pageerror', (error) => errors.push(String(error)));
page.on('dialog', (dialog) => dialog.accept());

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} · ${name}${detail ? ` · ${detail}` : ''}`);
};

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });

const boot = await page.evaluate(() => ({
  touch: window.shutoko.isTouchDevice,
  quality: window.shutoko.renderQuality(),
  profile: window.shutoko.performanceProfile,
  dynamic: window.shutoko._dynamicRenderScale,
}));
check('probe runs on the desktop profile', !boot.touch && boot.profile.name === 'desktop-144', boot.profile.name);
check('a fresh save defaults to Medium', boot.quality === 'medium', boot.quality);
check('desktop boots at native scale', boot.profile.initialRenderScale === 1 && boot.dynamic === 1,
  `initial=${boot.profile.initialRenderScale} dynamic=${boot.dynamic}`);

const measure = (quality) => page.evaluate((q) => {
  window.shutoko.changeSetting('quality', q);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  return {
    width: window.shutoko.canvas.width,
    height: window.shutoko.canvas.height,
    expected: Math.round(window.innerWidth * dpr),
    mipBias: window.shutoko.map?._surfaceMipBias?.value ?? null,
  };
}, quality);

const medium = await measure('medium');
check('Medium draws at native width', medium.width === medium.expected,
  `${medium.width}×${medium.height} vs ${medium.expected}`);
check('Medium needs no mip-bias compensation', Math.abs(medium.mipBias ?? 1) < 1e-6, String(medium.mipBias));

const high = await measure('high');
check('High draws at native width', high.width === high.expected, `${high.width} vs ${high.expected}`);

const low = await measure('low');
check('Low is the only tier below native', low.width < low.expected && low.width > low.expected * 0.5,
  `${low.width} vs ${low.expected}`);
await page.evaluate(() => window.shutoko.changeSetting('quality', 'medium'));

// The governor must budget against the real presentation cadence. Headless
// Chromium presents at ~60 Hz, so a 144 fps budget would be a false positive on
// every frame; feed it a CPU cost that fits 60 Hz and check it holds native.
const governed = await page.evaluate(async () => {
  const game = window.shutoko;
  const governor = game._performanceGovernor;
  game.mode = 'driving';
  governor.emaMs = 0; governor.samples = 0;
  let now = performance.now();
  // 12 ms of work per frame at a 16.7 ms cadence: comfortable at 60 Hz, three
  // times over budget if the governor still believed in 1000/144.
  for (let i = 0; i < 400; i += 1) {
    now += 16.7;
    governor.lastAdjustAt = now - 800;
    game.updatePerformanceGovernor(12, now);
  }
  return { displayMs: governor.displayMs, scale: game._dynamicRenderScale };
});
check('governor learns the display cadence', governed.displayMs > 14 && governed.displayMs < 20,
  `${(governed.displayMs || 0).toFixed(1)} ms`);
check('governor holds native when the frame fits the display', governed.scale === 1, String(governed.scale));
check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

// A desktop with a touchscreen. This is the configuration the player actually
// has, and the one every check above misses: headless Chromium reports
// maxTouchPoints 0, so the touch branch never ran here. `hasTouch: true` with
// `isMobile: false` is exactly a Windows laptop with a touch panel — touch
// input available, mouse as the primary pointer.
const touchContext = await browser.newContext({
  viewport: { width: 1920, height: 911 }, deviceScaleFactor: 1, hasTouch: true, isMobile: false,
});
await touchContext.route('https://cdn.jsdelivr.net/**', async (route) => {
  const url = new URL(route.request().url());
  const addon = url.pathname.match(/\/examples\/jsm\/(.+)$/);
  const file = addon
    ? join(ROOT, 'node_modules', 'three', 'examples', 'jsm', addon[1])
    : join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(file) });
});
const touchPage = await touchContext.newPage();
touchPage.on('dialog', (dialog) => dialog.accept());
await touchPage.goto(`http://127.0.0.1:${port}/`);
await touchPage.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });
const touchDesktop = await touchPage.evaluate(() => {
  const game = window.shutoko;
  game.changeSetting('quality', 'high');
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  return {
    maxTouchPoints: navigator.maxTouchPoints,
    isTouchDevice: game.isTouchDevice,
    isHandheld: game.isHandheld,
    profile: game.performanceProfile.name,
    width: game.canvas.width,
    height: game.canvas.height,
    expected: Math.round(window.innerWidth * dpr),
    info: document.getElementById('render-info')?.textContent,
  };
});
check('the touchscreen desktop is seen as touch-capable', touchDesktop.isTouchDevice === true && touchDesktop.maxTouchPoints > 0,
  `maxTouchPoints=${touchDesktop.maxTouchPoints}`);
check('…but NOT as a handheld', touchDesktop.isHandheld === false, `isHandheld=${touchDesktop.isHandheld}`);
check('…so it gets the desktop performance profile', touchDesktop.profile === 'desktop-144', touchDesktop.profile);
check('…and draws at native, not 0.62×0.72', touchDesktop.width === touchDesktop.expected,
  `${touchDesktop.width}×${touchDesktop.height} vs ${touchDesktop.expected}${touchDesktop.info || ''}`);

// The other direction: a real phone must stay on the handheld profile. Its
// scales and 1.25 MP ceiling are tuned against a thermal budget, and widening
// the desktop test must not quietly take that away.
const phoneContext = await browser.newContext({
  ...devices['Pixel 5'],
});
await phoneContext.route('https://cdn.jsdelivr.net/**', async (route) => {
  const url = new URL(route.request().url());
  const addon = url.pathname.match(/\/examples\/jsm\/(.+)$/);
  const file = addon
    ? join(ROOT, 'node_modules', 'three', 'examples', 'jsm', addon[1])
    : join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(file) });
});
const phonePage = await phoneContext.newPage();
phonePage.on('dialog', (dialog) => dialog.accept());
await phonePage.goto(`http://127.0.0.1:${port}/`, { timeout: 120000 });
await phonePage.waitForFunction(() => window.shutoko?.map, null, { timeout: 90000 });
const phone = await phonePage.evaluate(() => ({
  isHandheld: window.shutoko.isHandheld,
  profile: window.shutoko.performanceProfile.name,
  pixels: window.shutoko.canvas.width * window.shutoko.canvas.height,
}));
check('a real phone is still a handheld', phone.isHandheld === true, `isHandheld=${phone.isHandheld}`);
check('…and keeps its thermal profile and pixel ceiling',
  phone.profile !== 'desktop-144' && phone.pixels <= 1250000,
  `${phone.profile} · ${(phone.pixels / 1e6).toFixed(2)}MP`);

await browser.close();
server.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
