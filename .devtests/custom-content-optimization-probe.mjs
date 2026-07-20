/**
 * Custom-content optimization regression probe.
 *
 * Verifies the four mechanisms that keep editor-made content scalable on
 * weak GPUs as the map grows:
 *
 *  1. Texture size budget — every editor-imported image is downscaled to the
 *     quality profile's cap (medium 256 px) before GPU upload, and re-scaled
 *     when the player changes quality.
 *  2. Garage VRAM release — leaving the garage disposes the GPU copies of
 *     garage-only textures (the JS images stay, so re-entry re-uploads).
 *  3. Shared part builds — repeated placements of one custom asset share one
 *     geometry set instead of building per-placement copies.
 *  4. Chunk streaming for placements — highway place-* objects live inside
 *     streamed chunk groups and pop in/out with player distance.
 *
 * Run from repo root:  node .devtests/custom-content-optimization-probe.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

const server = createServer(async (req, res) => {
  try {
    const path = req.url.split('?')[0];
    const file = path === '/' ? '/index.html' : decodeURIComponent(path);
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('nope');
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });

// Starting a night boots into the garage, which uploads every garage texture.
await page.click('#continue-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 15000 });

// Wait for the editor builds and their async texture loads to settle: every
// budgeted texture keeps its decoded source on userData.hesiSourceImage.
await page.waitForFunction(() => {
  let loaded = 0;
  const scan = (scene) => scene.traverse((o) => {
    for (const m of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
      if (m.map?.userData?.hesiSourceImage) loaded += 1;
    }
  });
  scan(window.shutoko.garageScene);
  scan(window.shutoko.roadScene);
  return loaded >= 10;
}, null, { timeout: 60000 });
await page.waitForTimeout(1500);

const collectCustomTextures = () => page.evaluate(() => {
  const seen = new Set();
  const textures = [];
  const scan = (scene) => scene.traverse((o) => {
    for (const m of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
      const t = m.map;
      if (!t || seen.has(t) || !t.userData?.hesiSourceImage) continue;
      seen.add(t);
      const source = t.userData.hesiSourceImage;
      textures.push({
        image: { width: t.image?.width || 0, height: t.image?.height || 0, isCanvas: String(t.image?.tagName || t.image?.constructor?.name || '').toLowerCase().includes('canvas') },
        source: { width: source.naturalWidth || source.width || 0, height: source.naturalHeight || source.height || 0 },
      });
    }
  });
  scan(window.shutoko.garageScene);
  scan(window.shutoko.roadScene);
  return textures;
});

// --- 1. Texture budget at the default medium quality (cap 256) ---
let textures = await collectCustomTextures();
const oversized = textures.filter((t) => Math.max(t.image.width, t.image.height) > 256);
const downscaled = textures.filter((t) => t.image.isCanvas && Math.max(t.source.width, t.source.height) > 256);
check('editor textures observed', textures.length >= 10, `${textures.length} textures`);
check('no editor texture exceeds the medium 256px budget', oversized.length === 0, `${oversized.length} oversized`);
check('large imports were actually downscaled to canvases', downscaled.length > 0, `${downscaled.length} downscaled of ${textures.length}`);

// --- 1b. Budget re-applies when the player changes quality ---
await page.evaluate(() => window.shutoko.changeSetting('quality', 'low'));
await page.waitForTimeout(400);
textures = await collectCustomTextures();
const overLow = textures.filter((t) => Math.max(t.image.width, t.image.height) > 128);
check('low quality re-caps cached textures to 128px', overLow.length === 0, `${overLow.length} above cap`);
await page.evaluate(() => window.shutoko.changeSetting('quality', 'medium'));
await page.waitForTimeout(400);

// --- 3. Shared part builds across repeated placements ---
// N placements of one asset must reference the same geometry objects: the
// distinct-geometry count per asset stays at one placement's worth of meshes
// instead of growing with every placement.
const sharing = await page.evaluate(() => {
  const byAsset = new Map();
  for (const scene of [window.shutoko.garageScene, window.shutoko.roadScene]) {
    scene.traverse((o) => {
      const id = o.userData?.customAssetId;
      if (!id) return;
      if (!byAsset.has(id)) byAsset.set(id, { placements: 0, geometries: new Set(), meshes: 0 });
      const entry = byAsset.get(id);
      entry.placements += 1;
      o.traverse((child) => { if (child.isMesh && child.geometry) { entry.geometries.add(child.geometry); entry.meshes += 1; } });
    });
  }
  const repeated = [...byAsset.values()].filter((e) => e.placements > 1);
  return {
    assets: byAsset.size,
    repeated: repeated.length,
    allShared: repeated.every((e) => e.geometries.size <= e.meshes / e.placements),
    detail: repeated.map((e) => `${e.placements} placements / ${e.geometries.size} geometries / ${e.meshes} meshes`).join(', '),
  };
});
check('custom assets placed', sharing.assets > 0, `${sharing.assets} distinct assets`);
if (sharing.repeated > 0) check('repeated placements share geometries', sharing.allShared, sharing.detail);
else check('repeated placements share geometries', true, 'no repeated assets in current builds (vacuous)');

// --- 2. Garage texture VRAM release on exit ---
const inGarage = await page.evaluate(() => window.shutoko.renderer.info.memory.textures);
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 10000 });
await page.waitForTimeout(1200);
const driving = await page.evaluate(() => window.shutoko.renderer.info.memory.textures);
check('garage GPU textures released while driving', driving < inGarage, `${inGarage} in garage -> ${driving} driving`);

// Re-entering must re-upload cleanly (textures re-init from cached images).
await page.evaluate(() => window.shutoko.enterGarage('service'));
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 10000 });
await page.waitForTimeout(1200);
const backIn = await page.evaluate(() => window.shutoko.renderer.info.memory.textures);
check('re-entering the garage re-uploads its textures', backIn > driving, `${driving} driving -> ${backIn} back in garage`);
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 10000 });
await page.waitForTimeout(800);

// --- 4. Highway placements stream with the chunk system ---
// Live build placements must sit inside chunk groups. When the current build
// has none that resolve (e.g. stale asset ids are skipped), exercise the same
// game path synthetically: clone a garage custom asset and attach it through
// map.attachStreamedObject exactly as applyHighwayBuild does.
const streaming = await page.evaluate(() => {
  const placements = [];
  window.shutoko.roadScene.traverse((o) => {
    if (!o.userData?.customAssetId) return;
    let node = o;
    let chunk = null;
    while (node) {
      if (node.name?.startsWith?.('chunk ')) { chunk = node; break; }
      node = node.parent;
    }
    if (!placements.some((p) => p.chunk === chunk && chunk)) {
      const world = new (o.position.constructor)();
      o.getWorldPosition(world);
      placements.push({ chunk, x: world.x, z: world.z, chunkName: chunk?.name || null });
    }
  });
  return placements.map((p) => ({ inChunk: !!p.chunk, x: p.x, z: p.z, chunkName: p.chunkName }));
});
if (streaming.length) {
  check('highway placements are inside streamed chunks', streaming.every((p) => p.inChunk), streaming.map((p) => p.chunkName).join(', '));
} else {
  const synthetic = await page.evaluate(() => {
    let donor = null;
    window.shutoko.garageScene.traverse((o) => { if (!donor && o.userData?.customAssetId) donor = o; });
    if (!donor) return null;
    const clone = donor.clone();
    clone.position.set(3626, 57.7, -4052);
    window.shutoko.map.attachStreamedObject(clone);
    let chunkName = null;
    let node = clone.parent;
    while (node) { if (node.name?.startsWith?.('chunk ')) { chunkName = node.name; break; } node = node.parent; }
    return { chunkName, x: clone.position.x, z: clone.position.z };
  });
  check('synthetic placement attaches to a streamed chunk', !!synthetic?.chunkName, synthetic ? `${synthetic.chunkName} (no live highway placements in build)` : 'no donor asset found');
  if (synthetic?.chunkName) streaming.push({ inChunk: true, x: synthetic.x, z: synthetic.z, chunkName: synthetic.chunkName });
}

if (streaming.length) {
  const target = streaming[0];
  const visibility = await page.evaluate(({ x, z }) => {
    const map = window.shutoko.map;
    const chunkVisibleAt = (px, pz) => {
      map._visibleKey = null;
      map.update({ x: px, y: 0, z: pz }, performance.now() / 1000 + 10);
      let visible = null;
      window.shutoko.roadScene.traverse((o) => {
        if (!o.userData?.customAssetId || visible !== null) return;
        let node = o;
        while (node) {
          if (node.name?.startsWith?.('chunk ')) { visible = node.visible; return; }
          node = node.parent;
        }
      });
      return visible;
    };
    const near = chunkVisibleAt(x, z);
    const far = chunkVisibleAt(x + 6000, z + 6000);
    const nearAgain = chunkVisibleAt(x, z);
    return { near, far, nearAgain };
  }, target);
  check('placement chunk visible when player is near', visibility.near === true);
  check('placement chunk hidden when player is far', visibility.far === false);
  check('placement chunk returns when player comes back', visibility.nearAgain === true);
}

check('no console errors through the whole flow', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error('CUSTOM CONTENT OPTIMIZATION REGRESSION');
  process.exit(1);
}
