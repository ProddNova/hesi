/**
 * Targeted verification for the surface-UV fix. Finds a real road-edge Jersey
 * `barrier` mesh, parks the camera beside it at driver height, and shoots it —
 * the barrier photo (barrier-test2, one barrier tall) should now stand full
 * height and repeat along the run instead of smearing. Also raises the bay
 * water Brightness at runtime and shoots the bay, to prove the emissive dial
 * works.
 *
 * Run: node .devtests/surface-verify.mjs [suffix]
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'shots');
await mkdir(OUT, { recursive: true });
const SUFFIX = process.argv.slice(2).find((a) => !a.startsWith('--')) ? `-${process.argv.slice(2).find((a) => !a.startsWith('--'))}` : '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  try { const p = req.url.split('?')[0]; const f = p === '/' ? '/index.html' : p;
    const b = await readFile(join(ROOT, f)); res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(b);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5, hasTouch: true });
await context.route('https://cdn.jsdelivr.net/**', async (route) => {
  const rel = new URL(route.request().url()).pathname.replace(/^\/npm\/three@[^/]+\//, '');
  try { await route.fulfill({ status: 200, contentType: 'text/javascript', body: await readFile(join(ROOT, 'node_modules/three', rel)) }); }
  catch { await route.fulfill({ status: 404, body: 'no' }); }
});
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });

// Find a low barrier mesh BEFORE streaming culls distant chunks (all chunks
// are in the group right after build). Reports the centre of a small barrier
// bucket at near-ground height so the camera can park beside it.
const bar = await page.evaluate(() => {
  const g = window.shutoko;
  const worldCentre = (o) => {
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2;
    o.updateWorldMatrix(true, false);
    const e = o.matrixWorld.elements;
    return { x: cx * e[0] + cy * e[4] + cz * e[8] + e[12], y: cx * e[1] + cy * e[5] + cz * e[9] + e[13], z: cx * e[2] + cy * e[6] + cz * e[10] + e[14], span: [bb.max.x - bb.min.x, bb.max.z - bb.min.z] };
  };
  let best = null, count = 0;
  g.map.group.traverse((o) => {
    if (!o.isMesh || !/ barrier$/.test(o.name)) return;
    count += 1;
    const w = worldCentre(o);
    if (!best || w.y < best.y) best = { mesh: o, ...w, name: o.name };
  });
  if (!best) return { best: null, count };
  // Sample an upright wall quad's mid-point and its outward horizontal normal,
  // so the camera can face the wall straight on.
  const o = best.mesh; const pos = o.geometry.getAttribute('position');
  o.updateWorldMatrix(true, false); const e = o.matrixWorld.elements;
  const toW = (i) => { const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    return [x * e[0] + y * e[4] + z * e[8] + e[12], x * e[1] + y * e[5] + z * e[9] + e[13], x * e[2] + y * e[6] + z * e[10] + e[14]]; };
  let wall = null;
  for (let i = 0; i + 3 < pos.count; i += 4) {
    const p0 = toW(i), p1 = toW(i + 1), p2 = toW(i + 2);
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const horiz = Math.hypot(nx, nz);
    if (horiz > Math.abs(ny) && p0[1] < 12) { // upright, low enough to stand by
      const cx = (p0[0] + p1[0] + p2[0] + toW(i + 3)[0]) / 4;
      const cy = (p0[1] + p1[1] + p2[1] + toW(i + 3)[1]) / 4;
      const cz = (p0[2] + p1[2] + p2[2] + toW(i + 3)[2]) / 4;
      wall = { c: [cx, cy, cz], n: [nx / horiz, 0, nz / horiz] }; break;
    }
  }
  return { best: { x: best.x, y: best.y, z: best.z, span: best.span, name: best.name }, wall, count };
});
console.log('barrier search:', JSON.stringify({ count: bar.count, best: bar.best, wall: bar.wall }));
const barMesh = bar.best;
const wall = bar.wall;

await page.tap('#new-game-button');
await page.waitForFunction(() => window.shutoko.mode === 'garage', null, { timeout: 15000 });
await page.evaluate(() => window.shutoko.exitGarage());
await page.waitForFunction(() => window.shutoko.mode === 'driving', null, { timeout: 10000 });
await page.evaluate(() => (window.shutoko.traffic?.pool || []).forEach((v) => { if (v.mesh) v.mesh.visible = false; }));

const view = async (name, eye, target, pause = 1400) => {
  await page.evaluate(({ eye, target }) => {
    const g = window.shutoko;
    g.debug.noclip = true; g.debug.trafficDisabled = true;
    g.debug.position.set(eye[0], eye[1], eye[2]);
    const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
    g.debug.yaw = Math.atan2(dx, dz); g.debug.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }, { eye, target });
  await page.waitForTimeout(pause);
  await page.screenshot({ path: join(OUT, `VERIFY-${name}${SUFFIX}.png`) });
  console.log(`shot VERIFY-${name}${SUFFIX}.png`);
};

if (wall) {
  // Stream the chunk in around the wall point.
  await page.evaluate(({ c }) => { const g = window.shutoko; g.debug.noclip = true; g.debug.position.set(c[0], c[1] + 2, c[2]); }, wall);
  await page.waitForTimeout(1200);
  // Camera 3 m out along the wall's outward normal, looking straight at it.
  const eye = [wall.c[0] + wall.n[0] * 3, wall.c[1] + 0.2, wall.c[2] + wall.n[2] * 3];
  await view('barrier-face', eye, wall.c);
  // Same, but temporarily brighten the barrier material so the concrete photo
  // and its 首都高 sign read despite the dim night light — proves the picture
  // tiles upright along the run rather than smearing over each segment.
  await page.evaluate(() => {
    const g = window.shutoko; const m = g.map.materials.barrier;
    m.userData.__probeColor = m.color.getHex(); m.color.multiplyScalar(4.2); m.needsUpdate = true;
  });
  await view('barrier-face-lit', eye, wall.c);
  await page.evaluate(() => { const g = window.shutoko; const m = g.map.materials.barrier; m.color.setHex(m.userData.__probeColor); m.needsUpdate = true; });
} else {
  console.log('no upright barrier wall sampled');
}

// Raise the bay Brightness at runtime (as the editor would) and shoot the sea.
await page.evaluate(async () => {
  const g = window.shutoko;
  const mod = await import('./js/custom-assets.js?v=verify');
  mod.applyWorldTextureOverrides(g.map.materials, { worldTextures: { water: { brightness: 3 } }, textures: {} });
});
await view('water-bright', [3600, 40, -4300], [3900, -0.9, -4800]);
// And restore, to confirm reversibility.
await page.evaluate(async () => {
  const g = window.shutoko;
  const mod = await import('./js/custom-assets.js?v=verify');
  mod.applyWorldTextureOverrides(g.map.materials, { worldTextures: {}, textures: {} });
});
await view('water-restored', [3600, 40, -4300], [3900, -0.9, -4800]);

console.log('page errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
server.close();
