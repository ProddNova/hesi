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
import { chromium } from 'playwright';

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
  handheld: window.shutoko.isHandheld,
  quality: window.shutoko.renderQuality(),
  profile: window.shutoko.performanceProfile,
  dynamic: window.shutoko._dynamicRenderScale,
}));
check('probe runs on the desktop profile', boot.handheld === false && boot.profile.name === 'desktop-144', `handheld=${boot.handheld} ${boot.profile.name}`);
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

// The touchscreen-desktop case — the one that actually caused this — lives in
// .devtests/device-profile.test.mjs instead. Playwright cannot produce it:
// `hasTouch: true` supplies the non-zero maxTouchPoints but also forces
// `(pointer: coarse)` to match, which real touchscreen laptops do not, and
// patching matchMedia in an init script stops the page firing `load`. The rule
// is a pure function so its truth table can be asserted directly.

// The opposite direction — a real phone must stay on the handheld profile with
// its 1.25 MP ceiling — is covered by .devtests/e2e.mjs, which runs the whole
// session under a full mobile emulation, and by the truth table in
// device-profile.test.mjs. A third WebGL context in this process would not load
// reliably, and a flaky check is worse than no check.

await browser.close();
server.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
