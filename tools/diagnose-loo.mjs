/**
 * DIAGNOSTIC GATE part 2 — decisive, model-free instruments.
 *
 * 1. LEAVE-ONE-OUT (LOO): for each interior raw OSM point, build the same
 *    centripetal Catmull-Rom through its neighbours WITHOUT the point and
 *    measure how far the curve passes from it. This is exactly the lateral
 *    wave amplitude that interpolating that point forces on the curve —
 *    no road-shape model involved (an interpolant through the neighbours
 *    follows any smooth road shape fine at 33 m spacing).
 *      LOO ~ 0        ⇒ data smooth, any waves are the spline's own.
 *      LOO ≥ ~0.25 m  ⇒ the data itself zig-zags: EVERY interpolating curve
 *                       must wave by that amount. Offline fit required.
 *
 * 2. SHARP CORNERS: vertices where the polyline heading turns by a large
 *    angle in one step (the "abrupt bend" complaint). Interpolation squeezes
 *    the whole direction change into ±1 span instead of a broad arc.
 *
 * Run: node tools/diagnose-loo.mjs
 */
import fs from 'node:fs';
import * as THREE from 'three';

const data = JSON.parse(fs.readFileSync(new URL('../data/routes.json', import.meta.url), 'utf8'));

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function looResidual(pts, i) {
  // local window around i, excluding i (XZ only)
  const lo = Math.max(0, i - 4);
  const hi = Math.min(pts.length - 1, i + 4);
  const win = [];
  for (let k = lo; k <= hi; k += 1) if (k !== i) win.push(new THREE.Vector3(pts[k].x, 0, pts[k].z));
  if (win.length < 4) return null;
  const curve = new THREE.CatmullRomCurve3(win, false, 'centripetal');
  // dense scan for nearest distance
  let best = Infinity;
  const N = 240;
  for (let j = 0; j <= N; j += 1) {
    const p = curve.getPoint(j / N);
    const d = Math.hypot(p.x - pts[i].x, p.z - pts[i].z);
    if (d < best) best = d;
  }
  return best;
}

function percentile(values, q) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

console.log('route            pts | LOO p50   p95   max | corners >12deg (worst deg @ vertex)');
const all = [];
const detail = {};
for (const routeData of data.routes) {
  const pts = routeData.points.map((p) => ({ x: p[0], z: p[2] }));
  if (pts.length < 8) continue;
  const loo = [];
  const looAt = [];
  for (let i = 2; i < pts.length - 2; i += 1) {
    const r = looResidual(pts, i);
    if (r !== null) { loo.push(r); looAt.push({ i, r }); }
  }
  // corner angles: heading change at each vertex
  const corners = [];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const h1 = Math.atan2(pts[i].z - pts[i - 1].z, pts[i].x - pts[i - 1].x);
    const h2 = Math.atan2(pts[i + 1].z - pts[i].z, pts[i + 1].x - pts[i].x);
    let dh = (h2 - h1) * 180 / Math.PI;
    while (dh > 180) dh -= 360;
    while (dh < -180) dh += 360;
    if (Math.abs(dh) > 12) corners.push({ i, deg: dh });
  }
  const worst = corners.reduce((acc, c) => (Math.abs(c.deg) > Math.abs(acc?.deg ?? 0) ? c : acc), null);
  console.log(
    routeData.id.padEnd(14),
    String(pts.length).padStart(4), '|',
    percentile(loo, 0.5).toFixed(2).padStart(5),
    percentile(loo, 0.95).toFixed(2).padStart(5),
    Math.max(...loo).toFixed(2).padStart(6), '|',
    String(corners.length).padStart(3),
    worst ? `(${worst.deg.toFixed(1)}° @ v${worst.i})` : '',
  );
  all.push(...loo);
  detail[routeData.id] = { loo: looAt, corners, pts, len: routeData.length };
}

console.log('\nALL ROUTES LOO: p50=%s p90=%s p95=%s max=%s (m)',
  percentile(all, 0.5).toFixed(2), percentile(all, 0.9).toFixed(2),
  percentile(all, 0.95).toFixed(2), Math.max(...all).toFixed(2));

for (const id of ['r11_0', 'r11_1']) {
  const d = detail[id];
  if (!d) continue;
  const top = [...d.loo].sort((a, b) => b.r - a.r).slice(0, 8);
  console.log(`\n${id} worst LOO vertices (spacing ~34 m => wave forced on any interpolant):`);
  for (const t of top) {
    const arc = Math.round((t.i / (d.pts.length - 1)) * d.len);
    console.log(`  v${t.i} (~s=${arc} m): LOO ${t.r.toFixed(2)} m`);
  }
  console.log(`${id} sharp corners:`, d.corners.map((c) => `v${c.i}:${c.deg.toFixed(1)}°`).join('  ') || 'none');
}
