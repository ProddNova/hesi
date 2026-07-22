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
// Optional close-up: --zoom <centreX> <centreZ> <halfSpan-in-metres>
const ZOOM = process.argv.includes('--zoom')
  ? process.argv.slice(process.argv.indexOf('--zoom') + 1, process.argv.indexOf('--zoom') + 4).map(Number)
  : null;
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

const report = await page.evaluate((zoom) => {
  const map = window.shutoko.map;
  const slabNames = new Set(map._terrainSlabs.map((s) => s.name));
  const meshes = [];
  window.shutoko.roadScene.traverse((o) => { if (slabNames.has(o.name) && o.geometry) meshes.push(o); });

  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  const grow = (x, z) => {
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minZ = Math.min(bounds.minZ, z); bounds.maxZ = Math.max(bounds.maxZ, z);
  };
  if (zoom) {
    grow(zoom[0] - zoom[2], zoom[1] - zoom[2]);
    grow(zoom[0] + zoom[2], zoom[1] + zoom[2]);
  } else {
    for (const slab of map._terrainSlabs) {
      grow(slab.x - slab.w / 2, slab.z - slab.d / 2);
      grow(slab.x + slab.w / 2, slab.z + slab.d / 2);
    }
  }
  const pad = zoom ? 0 : 800;
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

  // carved land: every +Y face, kept as world-space triangles
  let tris = 0;
  let flipped = 0;
  let degenerate = 0;
  const faces = [];
  ctx.fillStyle = '#25406b';
  for (const mesh of meshes) {
    const pos = mesh.geometry.attributes.position;
    const nor = mesh.geometry.attributes.normal;
    const idx = mesh.geometry.index;
    tris += idx.count / 3;
    for (let t = 0; t < idx.count; t += 3) {
      const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
      // Winding must agree with the stored normal on EVERY face, cap or skirt.
      const ux = pos.getX(b) - pos.getX(a), uy = pos.getY(b) - pos.getY(a), uz = pos.getZ(b) - pos.getZ(a);
      const vx = pos.getX(c) - pos.getX(a), vy = pos.getY(c) - pos.getY(a), vz = pos.getZ(c) - pos.getZ(a);
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const len = Math.hypot(cx, cy, cz);
      if (len < 1e-6) degenerate += 1;
      else if ((cx * nor.getX(a) + cy * nor.getY(a) + cz * nor.getZ(a)) / len < 0.001) flipped += 1;
      if (nor.getY(a) < 0.5) continue;
      const tri = [];
      ctx.beginPath();
      for (const v of [a, b, c]) {
        const wx = pos.getX(v) + mesh.position.x;
        const wz = pos.getZ(v) + mesh.position.z;
        tri.push(wx, wz);
        ctx.lineTo(px(wx), py(wz));
      }
      ctx.closePath(); ctx.fill();
      faces.push(tri);
    }
  }
  const HASH = 512;
  const faceHash = new Map();
  for (const tri of faces) {
    const minX = Math.min(tri[0], tri[2], tri[4]);
    const maxX = Math.max(tri[0], tri[2], tri[4]);
    const minZ = Math.min(tri[1], tri[3], tri[5]);
    const maxZ = Math.max(tri[1], tri[3], tri[5]);
    for (let i = Math.floor(minX / HASH); i <= Math.floor(maxX / HASH); i += 1) {
      for (let k = Math.floor(minZ / HASH); k <= Math.floor(maxZ / HASH); k += 1) {
        const key = `${i},${k}`;
        if (!faceHash.has(key)) faceHash.set(key, []);
        faceHash.get(key).push(tri);
      }
    }
  }
  const side = (px1, pz1, px2, pz2, x, z) => (px2 - px1) * (z - pz1) - (pz2 - pz1) * (x - px1);
  const onLand = (x, z) => (faceHash.get(`${Math.floor(x / HASH)},${Math.floor(z / HASH)}`) || [])
    .some((t) => {
      const d1 = side(t[0], t[1], t[2], t[3], x, z);
      const d2 = side(t[2], t[3], t[4], t[5], x, z);
      const d3 = side(t[4], t[5], t[0], t[1], x, z);
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    });
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
  return { W, H, tris, flipped, degenerate, anchors, orphans, alwaysOverWater, bounds };
}, ZOOM);
console.log(JSON.stringify(report));
await page.locator('#terrain-map').screenshot({ path: join(OUT, `terrain-map-${TAG}${ZOOM ? '-zoom' : ''}.png`) });
await browser.close();
server.close();
