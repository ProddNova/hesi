/**
 * Anti-aliasing probe.
 *
 * The player's screenshots show hard stair-stepping on the car silhouette and
 * on thin lines — that is edge aliasing, which is a different defect from the
 * texture filtering fixed earlier and from the render resolution before it.
 *
 * The canvas is created with `antialias: true`, but once the VHS pass is on the
 * scene is drawn into an offscreen target instead, and the canvas MSAA stops
 * being the anti-aliaser (vhs-effect.js says exactly this). So the question is
 * whether that target's `samples: 4` is actually in effect. `isXRRenderTarget`
 * and the pinned RGBA8 internalFormat are load-bearing there and easy to break.
 *
 * Measures edge aliasing directly: renders the garage, then counts how many
 * pixels along high-contrast edges are *intermediate* values. A properly
 * multisampled edge has a band of in-between pixels; a hard aliased edge jumps
 * straight from one side to the other.
 *
 * Run: node .devtests/antialias-probe.mjs
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, '.devtests', 'shots');
await mkdir(SHOTS, { recursive: true });
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
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
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
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => d.accept());

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko?.map, null, { timeout: 60000 });
await page.click('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 45000 });
await page.waitForTimeout(2500);

// What the pass thinks it allocated, and what the GL driver actually gave it.
const target = await page.evaluate(() => {
  const game = window.shutoko;
  const vhs = game.vhs;
  const gl = game.renderer.getContext();
  const properties = game.renderer.properties.get(vhs?.target);
  let renderbufferSamples = null;
  try {
    const framebuffer = properties?.__webglMultisampledFramebuffer;
    if (framebuffer) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
      renderbufferSamples = gl.getParameter(gl.SAMPLES);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    }
  } catch (e) { renderbufferSamples = `error: ${e.message}`; }
  return {
    vhsActive: vhs?.active?.(),
    requestedSamples: vhs?.samples,
    targetSamples: vhs?.target?.samples ?? null,
    hasMultisampledFramebuffer: !!properties?.__webglMultisampledFramebuffer,
    driverSamples: renderbufferSamples,
    canvasAntialias: game.renderer.getContext().getContextAttributes().antialias,
    maxSamples: gl.getParameter(gl.MAX_SAMPLES),
  };
});

// Edge-softness measurement. Scan rows for large luminance jumps between
// neighbouring pixels; an anti-aliased edge lands as two smaller steps with an
// intermediate pixel, an aliased one as a single hard step.
const measureEdges = () => page.evaluate(() => {
  const game = window.shutoko;
  const canvas = game.canvas;
  const gl = game.renderer.getContext();
  const width = canvas.width; const height = canvas.height;
  const pixels = new Uint8Array(width * height * 4);
  // Draw and read in the same task. Without preserveDrawingBuffer the buffer is
  // gone once the frame has been composited, and readPixels comes back empty —
  // which reads as "no edges at all" rather than as a failed measurement.
  game.render();
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const luma = (i) => 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
  let hardEdges = 0; let softEdges = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 1; x < width - 2; x += 1) {
      const i = (y * width + x) * 4;
      const a = luma(i - 4); const b = luma(i); const c = luma(i + 4);
      const jump = Math.abs(c - a);
      if (jump < 40) continue;                 // not an edge
      const middle = Math.abs(b - (a + c) / 2);
      // b sitting near the midpoint means the edge was resolved across pixels.
      if (middle < jump * 0.28) softEdges += 1; else hardEdges += 1;
      x += 2;
    }
  }
  return { hardEdges, softEdges, ratio: softEdges / Math.max(1, softEdges + hardEdges) };
});

const withVhs = await measureEdges();
await page.screenshot({ path: join(SHOTS, 'aa-vhs-on.png') });
await page.evaluate(() => window.shutoko.changeSetting('vhs', false));
await page.waitForTimeout(1200);
const withoutVhs = await measureEdges();
await page.screenshot({ path: join(SHOTS, 'aa-vhs-off.png') });

console.log(JSON.stringify({ target, withVhs, withoutVhs }, null, 2));

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} · ${name}${detail ? ` · ${detail}` : ''}`);
};
console.log('');
check('the VHS pass is what draws the scene', target.vhsActive === true);
check('its target asked for 4 samples', target.targetSamples === 4, String(target.targetSamples));
check('the driver actually allocated a multisampled buffer',
  target.hasMultisampledFramebuffer && typeof target.driverSamples === 'number' && target.driverSamples >= 4,
  `fbo=${target.hasMultisampledFramebuffer} samples=${target.driverSamples} max=${target.maxSamples}`);
check('edges are resolved, not stair-stepped (VHS on)', withVhs.ratio > 0.5,
  `${(withVhs.ratio * 100).toFixed(1)}% soft · ${withVhs.hardEdges} hard`);
check('turning the pass off does not change the edges', Math.abs(withVhs.ratio - withoutVhs.ratio) < 0.15,
  `on ${(withVhs.ratio * 100).toFixed(1)}% vs off ${(withoutVhs.ratio * 100).toFixed(1)}%`);
check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed · shots in .devtests/shots/aa-vhs-{on,off}.png`);
