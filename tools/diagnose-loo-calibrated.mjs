/**
 * DIAGNOSTIC GATE part 3 — bias-calibrated leave-one-out.
 *
 * LOO residual (distance from point i to the centripetal CR through its
 * neighbours without i) overstates noise on bends: even for perfect points
 * on a circle, the gap-spanning curve sags inward by ~h²/8R. Calibration:
 * run the IDENTICAL LOO construction on synthetic points placed exactly on
 * the local best-fit circle at the same arc spacings. The bias-corrected
 * noise estimate is sqrt(max(0, LOO² − LOO_synthetic²)).
 *
 * This is the number the gate needs: how much lateral wave the RAW DATA
 * forces on ANY curve that interpolates it.
 *
 * Run: node tools/diagnose-loo-calibrated.mjs
 */
import fs from 'node:fs';
import * as THREE from 'three';

const data = JSON.parse(fs.readFileSync(new URL('../data/routes.json', import.meta.url), 'utf8'));
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function fitCircle(points) {
  const n = points.length;
  let sx = 0; let sz = 0;
  for (const p of points) { sx += p.x; sz += p.z; }
  const mx = sx / n; const mz = sz / n;
  let suu = 0; let suv = 0; let svv = 0; let suuu = 0; let svvv = 0; let suvv = 0; let svuu = 0;
  for (const p of points) {
    const u = p.x - mx; const v = p.z - mz;
    suu += u * u; suv += u * v; svv += v * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9 * (suu + svv) * (suu + svv)) return null;
  const uc = (0.5 * (svv * (suuu + suvv) - suv * (svvv + svuu))) / det;
  const vc = (0.5 * (suu * (svvv + svuu) - suv * (suuu + suvv))) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  if (!Number.isFinite(r) || r > 50000) return null;
  return { cx: uc + mx, cz: vc + mz, r };
}

function looOf(windowPts, target) {
  const curve = new THREE.CatmullRomCurve3(
    windowPts.map((p) => new THREE.Vector3(p.x, 0, p.z)), false, 'centripetal',
  );
  let best = Infinity;
  const N = 260;
  for (let j = 0; j <= N; j += 1) {
    const p = curve.getPoint(j / N);
    const d = Math.hypot(p.x - target.x, p.z - target.z);
    if (d < best) best = d;
  }
  return best;
}

/** Calibrated LOO noise for vertex i. Returns {raw, bias, noise} or null. */
function calibratedLoo(pts, i) {
  const lo = i - 4; const hi = i + 4;
  if (lo < 0 || hi > pts.length - 1) return null;
  const winAll = [];
  for (let k = lo; k <= hi; k += 1) winAll.push(pts[k]);
  const winSans = winAll.filter((_, idx) => idx !== i - lo);
  const raw = looOf(winSans, pts[i]);

  // synthetic points on the local circle at the same arc spacings
  const circle = fitCircle(winAll);
  let bias = 0;
  if (circle) {
    const angOf = (p) => Math.atan2(p.z - circle.cz, p.x - circle.cx);
    // unwrap angles so spacing along the arc is preserved
    const angs = [angOf(winAll[0])];
    for (let k = 1; k < winAll.length; k += 1) {
      let a = angOf(winAll[k]);
      while (a - angs[k - 1] > Math.PI) a -= 2 * Math.PI;
      while (a - angs[k - 1] < -Math.PI) a += 2 * Math.PI;
      angs.push(a);
    }
    const synth = angs.map((a) => ({ x: circle.cx + circle.r * Math.cos(a), z: circle.cz + circle.r * Math.sin(a) }));
    const synthSans = synth.filter((_, idx) => idx !== i - lo);
    bias = looOf(synthSans, synth[i - lo]);
  }
  const noise = Math.sqrt(Math.max(0, raw * raw - bias * bias));
  return { raw, bias, noise };
}

function percentile(values, q) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

console.log('route            pts | noise p50   p90   p95    max | verts>0.3m  >0.5m (share)');
const allNoise = [];
const perRoute = {};
for (const routeData of data.routes) {
  const pts = routeData.points.map((p) => ({ x: p[0], z: p[2] }));
  if (pts.length < 10) continue;
  const noises = [];
  const at = [];
  for (let i = 4; i < pts.length - 4; i += 1) {
    const r = calibratedLoo(pts, i);
    if (r) { noises.push(r.noise); at.push({ i, ...r }); }
  }
  if (!noises.length) continue;
  const n03 = noises.filter((v) => v > 0.3).length;
  const n05 = noises.filter((v) => v > 0.5).length;
  console.log(
    routeData.id.padEnd(14),
    String(pts.length).padStart(4), '|',
    percentile(noises, 0.5).toFixed(2).padStart(5),
    percentile(noises, 0.9).toFixed(2).padStart(5),
    percentile(noises, 0.95).toFixed(2).padStart(5),
    Math.max(...noises).toFixed(2).padStart(6), '|',
    String(n03).padStart(6), String(n05).padStart(6),
    `(${((n03 / noises.length) * 100).toFixed(0)}%)`,
  );
  allNoise.push(...noises);
  perRoute[routeData.id] = at;
}

console.log('\nALL ROUTES calibrated noise: p50=%s p90=%s p95=%s max=%s (m)',
  percentile(allNoise, 0.5).toFixed(2), percentile(allNoise, 0.9).toFixed(2),
  percentile(allNoise, 0.95).toFixed(2), Math.max(...allNoise).toFixed(2));
console.log('share of vertices forcing >0.3 m wave on any interpolant: %s%%',
  ((allNoise.filter((v) => v > 0.3).length / allNoise.length) * 100).toFixed(1));

for (const id of ['r11_0', 'r11_1']) {
  const at = perRoute[id];
  if (!at) continue;
  const top = [...at].sort((a, b) => b.noise - a.noise).slice(0, 8);
  console.log(`\n${id} worst calibrated vertices:`);
  for (const t of top) {
    console.log(`  v${t.i}: raw LOO ${t.raw.toFixed(2)} m, circle bias ${t.bias.toFixed(2)} m -> forced wave ${t.noise.toFixed(2)} m`);
  }
}
