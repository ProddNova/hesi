/**
 * Texture-filtering probe (garage).
 *
 * The second half of the "il gioco è pixelato su PC" report. The framebuffer
 * was only one cause; the other was that every editor-imported texture was
 * uploaded with NearestFilter magnification and anisotropy 1, so walls, crates,
 * posters and facades read as hard blocks no matter how many pixels the frame
 * had. `textureFromSource` re-configures its texture when the async image load
 * resolves, so the scene-wide applyRetroMaterials pass could not fix it after
 * the fact — the default in custom-assets.js is what reaches the GPU.
 *
 * The garage is the tightest place to check it: it is entirely built from
 * editor-placed custom objects, viewed from a metre away.
 *
 * Run: node .devtests/texture-filtering-probe.mjs
 * Screenshot: .devtests/shots/diag-garage.png
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
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
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

const report = await page.evaluate(() => {
  const game = window.shutoko;
  const dpr = window.devicePixelRatio || 1;
  const textures = new Map();
  game.garageScene.traverse((object) => {
    if (!object.material) return;
    for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
      const map = material.map;
      if (!map || textures.has(map.uuid)) continue;
      const source = map.userData?.hesiSourceImage;
      textures.set(map.uuid, {
        name: map.name || material.name || object.name || '(unnamed)',
        uploaded: `${map.image?.width || 0}×${map.image?.height || 0}`,
        source: source ? `${source.naturalWidth || source.width}×${source.naturalHeight || source.height}` : '—',
        mips: !!map.generateMipmaps,
        aniso: map.anisotropy,
        minFilter: map.minFilter,
        magFilter: map.magFilter,
      });
    }
  });
  return {
    canvas: `${game.canvas.width}×${game.canvas.height}`,
    css: `${game.canvas.clientWidth}×${game.canvas.clientHeight}`,
    dpr,
    quality: game.renderQuality(),
    dynamicScale: game._dynamicRenderScale,
    mipBias: game.map?._surfaceMipBias?.value ?? null,
    vhs: { active: game.vhs?.active?.(), size: `${game.vhs?.width}×${game.vhs?.height}`, samples: game.vhs?.samples, amount: game.vhs?.uniforms?.uAmount?.value },
    rendererAntialias: game.renderer.getContext().getContextAttributes().antialias,
    maxAniso: game.renderer.capabilities.getMaxAnisotropy?.(),
    textures: [...textures.values()],
  };
});

console.log(JSON.stringify({ ...report, textures: `${report.textures.length} textures` }, null, 2));
console.log('\nTEXTURES');
for (const t of report.textures) {
  console.log(`  ${t.name.padEnd(28)} uploaded ${t.uploaded.padEnd(11)} source ${t.source.padEnd(11)} mips=${t.mips} aniso=${t.aniso} min=${t.minFilter} mag=${t.magFilter}`);
}

// three.js filter constants, spelled out so the failure message is readable.
const LINEAR = 1006, LINEAR_MIPMAP_LINEAR = 1008;
const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'} · ${name}${detail ? ` · ${detail}` : ''}`);
};

console.log('');
check('the garage is built from imported textures', report.textures.length > 20, `${report.textures.length}`);
const blocky = report.textures.filter((t) => t.magFilter !== LINEAR);
check('nothing is point-sampled on magnification', blocky.length === 0,
  blocky.slice(0, 3).map((t) => `${t.name}=${t.magFilter}`).join(', '));
const unfiltered = report.textures.filter((t) => t.minFilter !== LINEAR_MIPMAP_LINEAR || !t.mips);
check('everything is trilinear with a mip chain', unfiltered.length === 0,
  unfiltered.slice(0, 3).map((t) => t.name).join(', '));
const flat = report.textures.filter((t) => t.aniso < 4);
check('anisotropy is not left at 1', flat.length === 0, flat.slice(0, 3).map((t) => t.name).join(', '));
check('the frame is native (the other half of the fix)', report.canvas === report.css && report.mipBias === 0,
  `${report.canvas} vs ${report.css}, bias ${report.mipBias}`);
check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await page.screenshot({ path: join(SHOTS, 'diag-garage.png') });
await browser.close();
server.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
