/**
 * Fairing metrics: curvature quality of a centripetal Catmull-Rom built on a
 * point set (exactly what the runtime does). Used by
 * build-smoothed-routes.mjs --sweep to calibrate λ, and standalone:
 *
 *   node tools/fairing-metrics.mjs            raw vs smoothed comparison
 */
import fs from 'node:fs';
import * as THREE from 'three';

const DSAMPLE = 2;
const K = 6; // ±12 m curvature baseline

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function mengerSigned(p0, p1, p2) {
  const a = dist(p0, p1); const b = dist(p1, p2); const c = dist(p0, p2);
  if (a < 1e-9 || b < 1e-9 || c < 1e-9) return 0;
  const cross = (p1.x - p0.x) * (p2.z - p1.z) - (p1.z - p0.z) * (p2.x - p1.x);
  return (2 * cross) / (a * b * c);
}

/** Quality of the runtime curve over a point list. */
export function curveQuality(points, closed) {
  const vecs = points.map((p) => new THREE.Vector3(p[0], 0, p[2]));
  const curve = new THREE.CatmullRomCurve3(vecs, closed, 'centripetal');
  let plen = 0;
  for (let i = 1; i < points.length; i += 1) plen += Math.hypot(points[i][0] - points[i - 1][0], points[i][2] - points[i - 1][2]);
  curve.arcLengthDivisions = Math.max(240, Math.ceil(plen / 14));
  curve.updateArcLengths();
  const length = curve.getLength();
  const n = Math.max(8, Math.round(length / DSAMPLE));
  const samples = [];
  for (let i = 0; i <= n; i += 1) {
    const p = curve.getPointAt(i / n);
    samples.push({ x: p.x, z: p.z });
  }
  const kappa = [];
  for (let i = K; i < samples.length - K; i += 1) {
    kappa.push(mengerSigned(samples[i - K], samples[i], samples[i + K]));
  }
  // sign flips (ignore straighter than R = 4 km)
  let flips = 0; let prev = 0;
  for (const v of kappa) {
    if (Math.abs(v) < 1 / 4000) continue;
    const s = Math.sign(v);
    if (prev !== 0 && s !== prev) flips += 1;
    prev = s;
  }
  // curvature jerk: max |dκ/ds| over 10 m (sudden curvature changes)
  let jerk = 0;
  const stride = Math.round(10 / DSAMPLE);
  for (let i = stride; i < kappa.length; i += 1) {
    jerk = Math.max(jerk, Math.abs(kappa[i] - kappa[i - stride]) / 10);
  }
  const maxKappa = kappa.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return { length, flipsPerKm: (flips / Math.max(1, length)) * 1000, jerk, maxKappa, samples, kappa };
}

/** λ sweep used by build-smoothed-routes.mjs --sweep. */
export async function sweep(data, fairRoute, { CAP }) {
  const ids = ['r11_0', 'r11_1', 'c1_0', 'wangan_0', 'ramp_13', 'r9_0'];
  console.log(`λ sweep on ${ids.join(', ')} (cap ${CAP} m)`);
  console.log('route          λ        maxDev  flips/km   jerk(1/m per m)  maxκ');
  for (const id of ids) {
    const routeData = data.routes.find((r) => r.id === id);
    const before = curveQuality(routeData.points, !!routeData.closed);
    console.log(`${id.padEnd(14)} raw      —      ${before.flipsPerKm.toFixed(1).padStart(8)}  ${before.jerk.toExponential(2)}  ${before.maxKappa.toExponential(2)}`);
    for (const lambda of [1e4, 1e5, 3e5, 1e6, 1e7]) {
      const r = fairRoute(routeData, lambda);
      const q = curveQuality(r.pts, !!routeData.closed);
      console.log(`${''.padEnd(14)} ${String(lambda).padEnd(8)} ${r.stats.maxDev.toFixed(2).padStart(5)}  ${q.flipsPerKm.toFixed(1).padStart(8)}  ${q.jerk.toExponential(2)}  ${q.maxKappa.toExponential(2)}`);
    }
  }
}

// ------------------------------------------------------------ standalone
if (import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const root = new URL('../', import.meta.url);
  const raw = JSON.parse(fs.readFileSync(new URL('data/routes.json', root), 'utf8'));
  let smoothed = null;
  try {
    smoothed = JSON.parse(fs.readFileSync(new URL('data/routes-smoothed.json', root), 'utf8'));
  } catch {
    console.log('no data/routes-smoothed.json yet — raw only');
  }
  console.log('route            len(m) | raw flips/km  jerk      maxκ    | smoothed flips/km  jerk      maxκ');
  const agg = { rawFlips: [], smFlips: [] };
  for (const routeData of raw.routes) {
    if (routeData.points.length < 8) continue;
    const before = curveQuality(routeData.points, !!routeData.closed);
    let after = null;
    if (smoothed) {
      const sm = smoothed.routes.find((r) => r.id === routeData.id);
      if (sm) after = curveQuality(sm.points, !!sm.closed);
    }
    agg.rawFlips.push(before.flipsPerKm);
    if (after) agg.smFlips.push(after.flipsPerKm);
    console.log(
      routeData.id.padEnd(14),
      String(Math.round(before.length)).padStart(7), '|',
      before.flipsPerKm.toFixed(1).padStart(8),
      before.jerk.toExponential(2).padStart(9),
      before.maxKappa.toExponential(2).padStart(9), '|',
      after ? after.flipsPerKm.toFixed(1).padStart(8) : '     —',
      after ? after.jerk.toExponential(2).padStart(9) : '',
      after ? after.maxKappa.toExponential(2).padStart(9) : '',
    );
  }
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  console.log(`\nmean flips/km: raw ${mean(agg.rawFlips).toFixed(1)}${agg.smFlips.length ? ` -> smoothed ${mean(agg.smFlips).toFixed(1)}` : ''}`);
}
