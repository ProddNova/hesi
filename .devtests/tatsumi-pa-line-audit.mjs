/**
 * Analytic audit of every painted marking on the Tatsumi PA deck.
 * Dumps each box:marking instance overlapping the deck rectangle in deck
 * frame (u along flow, v across, yaw vs tangent, length), then reports
 * segment-segment intersections between stripes that should never cross.
 *
 * Run: node .devtests/tatsumi-pa-line-audit.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
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
const page = await browser.newPage();
page.on('pageerror', (error) => console.error('pageerror:', String(error)));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => window.shutoko && !!window.shutoko.map, null, { timeout: 60000 });

const data = await page.evaluate(() => {
  const g = window.shutoko;
  const map = g.map;
  const area = (map.serviceAreas || []).find((a) => a.id === 'tatsumi_pa');
  if (!area) return null;
  const T = area.tangent; const N = area.normal; const C = area.center;
  const halfL = area.length / 2; const halfW = area.width / 2;
  const out = [];
  map.group.updateMatrixWorld(true);
  map.group.traverse((object) => {
    if (!object.isInstancedMesh) return;
    if (!/box:marking$/.test(object.name)) return;
    const arr = object.instanceMatrix.array;
    for (let i = 0; i < object.count; i += 1) {
      const e = arr.subarray(i * 16, i * 16 + 16);
      const px = e[12]; const py = e[13]; const pz = e[14];
      const du = (px - C.x) * T.x + (pz - C.z) * T.z;
      const dv = (px - C.x) * N.x + (pz - C.z) * N.z;
      if (Math.abs(du) > halfL + 15 || Math.abs(dv) > halfW + 6) continue;
      if (Math.abs(py - area.elevation) > 2) continue;
      // local axes columns: X = e[0..2], Z = e[8..10]; lengths = scales
      const sx = Math.hypot(e[0], e[1], e[2]);
      const sz = Math.hypot(e[8], e[9], e[10]);
      const dirU = (e[8] * T.x + e[10] * T.z) / (sz || 1);
      const dirV = (e[8] * N.x + e[10] * N.z) / (sz || 1);
      out.push({
        mesh: object.name, i,
        u: +du.toFixed(2), v: +dv.toFixed(2), y: +(py - area.elevation).toFixed(3),
        len: +sz.toFixed(2), wid: +sx.toFixed(2),
        yawDeg: +((Math.atan2(dirV, dirU) * 180) / Math.PI).toFixed(1),
      });
    }
  });
  return {
    area: {
      length: area.length, width: area.width, aisleV: area.aisleV,
      rampSideSign: area.rampSideSign, plan: area.tatsumiPlan,
      ringU: (area.garageEntrance.x - C.x) * T.x + (area.garageEntrance.z - C.z) * T.z,
    },
    marks: out,
  };
});

if (!data) { console.error('no tatsumi area'); process.exit(1); }
console.log('AREA', JSON.stringify(data.area));
console.log('marks:', data.marks.length);

// classify + segment endpoints in deck frame
const segs = data.marks.map((mk) => {
  const rad = (mk.yawDeg * Math.PI) / 180;
  const hu = Math.cos(rad) * mk.len / 2; const hv = Math.sin(rad) * mk.len / 2;
  return { ...mk, u0: mk.u - hu, v0: mk.v - hv, u1: mk.u + hu, v1: mk.v + hv };
});
const cross = (ax, ay, bx, by) => ax * by - ay * bx;
const intersects = (s, t) => {
  const r = [s.u1 - s.u0, s.v1 - s.v0]; const q = [t.u1 - t.u0, t.v1 - t.v0];
  const d = cross(r[0], r[1], q[0], q[1]);
  if (Math.abs(d) < 1e-9) return false;
  const du = t.u0 - s.u0; const dv = t.v0 - s.v0;
  const a = cross(du, dv, q[0], q[1]) / d;
  const b = cross(du, dv, r[0], r[1]) / d;
  return a > 0.02 && a < 0.98 && b > 0.02 && b < 0.98;
};
let count = 0;
for (let i = 0; i < segs.length; i += 1) {
  for (let j = i + 1; j < segs.length; j += 1) {
    const s = segs[i]; const t = segs[j];
    if (Math.abs(s.yawDeg - t.yawDeg) < 2) continue; // parallel families
    if (intersects(s, t)) {
      count += 1;
      if (count <= 60) {
        console.log(`X u≈${((s.u + t.u) / 2).toFixed(1)} v≈${((s.v + t.v) / 2).toFixed(1)} | A(u=${s.u},v=${s.v},yaw=${s.yawDeg},len=${s.len}) B(u=${t.u},v=${t.v},yaw=${t.yawDeg},len=${t.len})`);
      }
    }
  }
}
console.log('total crossings:', count);

await browser.close();
server.close();
