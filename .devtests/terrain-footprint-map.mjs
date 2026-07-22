/**
 * Top-down schematic of the carved land: every terrain top face filled, with
 * the route network and the recorded building footprints drawn over it, so the
 * shape can be checked against "hugs the road, still carries the buildings,
 * leaves the bay open".
 * Run: node .devtests/terrain-footprint-map.mjs [tag]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = process.argv[2] || 'after';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary' };

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const file = path === '/' ? '/index.html' : path;
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 900, height: 1200 } });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const body = await readFile(join(ROOT, 'node_modules/three/build/three.module.js'));
  await route.fulfill({ status: 200, contentType: 'text/javascript', body });
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });

const report = await page.evaluate(() => {
  const map = window.shutoko.map;
  const slabNames = new Set(map._terrainSlabs.map((s) => s.name));
  const meshes = [];
  window.shutoko.roadScene.traverse((o) => { if (slabNames.has(o.name) && o.geometry) meshes.push(o); });

  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  const grow = (x, z) => {
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minZ = Math.min(bounds.minZ, z); bounds.maxZ = Math.max(bounds.maxZ, z);
  };
  for (const slab of map._terrainSlabs) {
    grow(slab.x - slab.w / 2, slab.z - slab.d / 2);
    grow(slab.x + slab.w / 2, slab.z + slab.d / 2);
  }
  const pad = 800;
  const w = bounds.maxX - bounds.minX + pad * 2;
  const h = bounds.maxZ - bounds.minZ + pad * 2;
  const W = 900;
  const scale = W / w;
  const H = Math.round(h * scale);
  const px = (x) => (x - bounds.minX + pad) * scale;
  const py = (z) => H - (z - bounds.minZ + pad) * scale;

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.id = 'terrain-map';
  canvas.style.cssText = `position:fixed;inset:0;z-index:99999;background:#05070d;width:${W}px;height:${H}px`;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#05070d'; ctx.fillRect(0, 0, W, H);

  // original rectangles, for comparison
  ctx.strokeStyle = 'rgba(255,90,90,0.55)'; ctx.lineWidth = 1;
  for (const slab of map._terrainSlabs) {
    ctx.strokeRect(px(slab.x - slab.w / 2), py(slab.z + slab.d / 2), slab.w * scale, slab.d * scale);
  }

  // carved land: every +Y face, collected as world-space rects
  let tris = 0;
  const rects = [];
  ctx.fillStyle = '#25406b';
  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position;
    const nor = mesh.geometry.attributes.normal;
    const idx = mesh.geometry.index;
    tris += idx.count / 3;
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
      if (nor.getY(a) < 0.5) continue;
      const xs = [], zs = [];
      ctx.beginPath();
      for (const v of [a, b, c]) {
        const wx = pos.getX(v) + mesh.position.x;
        const wz = pos.getZ(v) + mesh.position.z;
        xs.push(wx); zs.push(wz);
        ctx.lineTo(px(wx), py(wz));
      }
      ctx.closePath(); ctx.fill();
      rects.push({ minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) });
    }
  }
  const HASH = 512;
  const rectHash = new Map();
  for (const r of rects) {
    for (let i = Math.floor(r.minX / HASH); i <= Math.floor(r.maxX / HASH); i += 1) {
      for (let k = Math.floor(r.minZ / HASH); k <= Math.floor(r.maxZ / HASH); k += 1) {
        const key = `${i},${k}`;
        if (!rectHash.has(key)) rectHash.set(key, []);
        rectHash.get(key).push(r);
      }
    }
  }
  const onLand = (x, z) => (rectHash.get(`${Math.floor(x / HASH)},${Math.floor(z / HASH)}`) || [])
    .some((r) => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ);
  const insideSlab = (x, z) => map._terrainSlabs.some((s) => Math.abs(x - s.x) <= s.w / 2 && Math.abs(z - s.z) <= s.d / 2);

  // routes
  ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 0.9;
  for (const route of map.routes.values()) {
    ctx.beginPath();
    route.samples.forEach((s, i) => (i ? ctx.lineTo(px(s.point.x), py(s.point.z)) : ctx.moveTo(px(s.point.x), py(s.point.z))));
    ctx.stroke();
  }

  // ground props: green = supported, magenta = lost its ground (regression),
  // grey = was always over open bay, outside every slab rectangle.
  let anchors = 0;
  let orphans = 0;
  let alwaysOverWater = 0;
  for (const anchor of map._terrainAnchors) {
    anchors += 1;
    const supported = onLand(anchor.x, anchor.z);
    const inSlab = insideSlab(anchor.x, anchor.z);
    if (supported) ctx.fillStyle = 'rgba(120,255,180,0.85)';
    else if (inSlab) { orphans += 1; ctx.fillStyle = '#ff35d0'; }
    else { alwaysOverWater += 1; ctx.fillStyle = 'rgba(140,150,165,0.7)'; }
    const size = supported ? 1.4 : 4;
    ctx.fillRect(px(anchor.x) - size / 2, py(anchor.z) - size / 2, size, size);
  }
  return { W, H, tris, anchors, orphans, alwaysOverWater, bounds };
});
console.log(JSON.stringify(report));
await page.locator('#terrain-map').screenshot({ path: join(OUT, `terrain-map-${TAG}.png`) });
await browser.close();
server.close();
