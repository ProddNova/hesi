/**
 * DIAGNOSTIC GATE — where do the centreline waves come from?
 *
 * Local road model: a circular arc fitted (Kåsa least squares) to a sliding
 * window of ±3 raw OSM points (~±100 m). A circle has no shrinkage bias on
 * bends (unlike Laplacian smoothing) and no sagitta artifact (unlike
 * chord-polyline references), so residuals from it are honest measurements:
 *
 *   rawResid   — lateral residual of each raw OSM point from its own
 *                window's circle: noise carried BY THE DATA. Any curve that
 *                interpolates the points must reproduce at least this wave.
 *   splineResid— residual of the dense centripetal Catmull-Rom (through the
 *                same raw points) from the same circles: waves ON THE CURVE.
 *                splineResid >> rawResid ⇒ the spline ADDS waves;
 *                splineResid ≈ rawResid  ⇒ the spline faithfully reproduces
 *                waves that live in the data.
 *   candResid  — residual of a candidate faired curve (centripetal CR through
 *                circle-projected points, endpoints locked) from the circles.
 *
 * Also reports curvature sign flips/km (dense, R<4 km only) and the candidate
 * deviation from the raw polyline (must stay ~1–2 m).
 *
 * Run: node tools/diagnose-centreline.mjs [routeId ...]   (detail: r11_0 r11_1)
 */
import fs from 'node:fs';
import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';

const DS = 2;        // dense sample step (m)
const K_BASE = 6;    // curvature baseline: ±6 samples = ±12 m
const HALF_WIN = 3;  // circle-fit window: ±3 raw points (~±100 m)
const detailIds = process.argv.slice(2).length ? process.argv.slice(2) : ['r11_0', 'r11_1'];

const data = JSON.parse(fs.readFileSync(new URL('../data/routes.json', import.meta.url), 'utf8'));
const map = new HighwayMap(null, {});

// ---------------------------------------------------------------- geometry
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function mengerSigned(p0, p1, p2) {
  const a = dist(p0, p1); const b = dist(p1, p2); const c = dist(p0, p2);
  if (a < 1e-9 || b < 1e-9 || c < 1e-9) return 0;
  const cross = (p1.x - p0.x) * (p2.z - p1.z) - (p1.z - p0.z) * (p2.x - p1.x);
  return (2 * cross) / (a * b * c);
}

/**
 * Kåsa circle fit of points [{x,z}]. Returns {cx, cz, r} or a line fallback
 * {line: true, px, pz, nx, nz} (point + unit normal) when nearly straight.
 */
function fitCircle(points) {
  const n = points.length;
  let sx = 0; let sz = 0;
  for (const p of points) { sx += p.x; sz += p.z; }
  const mx = sx / n; const mz = sz / n;
  // centred coordinates for conditioning
  let suu = 0; let suv = 0; let svv = 0; let suuu = 0; let svvv = 0; let suvv = 0; let svuu = 0;
  for (const p of points) {
    const u = p.x - mx; const v = p.z - mz;
    suu += u * u; suv += u * v; svv += v * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  const lineFit = () => {
    // total least squares line through centroid (major PCA axis)
    const theta = 0.5 * Math.atan2(2 * suv, suu - svv);
    const tx = Math.cos(theta); const tz = Math.sin(theta);
    return { line: true, px: mx, pz: mz, nx: -tz, nz: tx };
  };
  if (Math.abs(det) < 1e-6 * (suu + svv) * (suu + svv)) return lineFit();
  const uc = (0.5 * (svv * (suuu + suvv) - suv * (svvv + svuu))) / det;
  const vc = (0.5 * (suu * (svvv + svuu) - suv * (suuu + suvv))) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  if (!Number.isFinite(r) || r > 20000) return lineFit();
  return { cx: uc + mx, cz: vc + mz, r };
}

const circleResidual = (fit, p) => (fit.line
  ? Math.abs((p.x - fit.px) * fit.nx + (p.z - fit.pz) * fit.nz)
  : Math.abs(Math.hypot(p.x - fit.cx, p.z - fit.cz) - fit.r));

/** Project p onto the fitted arc/line. */
function circleProject(fit, p) {
  if (fit.line) {
    const d = (p.x - fit.px) * fit.nx + (p.z - fit.pz) * fit.nz;
    return { x: p.x - d * fit.nx, z: p.z - d * fit.nz };
  }
  const dx = p.x - fit.cx; const dz = p.z - fit.cz;
  const len = Math.hypot(dx, dz) || 1;
  return { x: fit.cx + (dx / len) * fit.r, z: fit.cz + (dz / len) * fit.r };
}

function denseSamples(curve, length) {
  const n = Math.max(8, Math.round(length / DS));
  const out = [];
  for (let i = 0; i <= n; i += 1) {
    const p = curve.getPointAt(i / n);
    out.push({ x: p.x, z: p.z, s: (i / n) * length });
  }
  return out;
}

function curvatureProfile(samples, k = K_BASE) {
  const kappa = new Array(samples.length).fill(0);
  for (let i = k; i < samples.length - k; i += 1) {
    kappa[i] = mengerSigned(samples[i - k], samples[i], samples[i + k]);
  }
  return kappa;
}

function signFlipsPerKm(kappa, lengthM, floor = 1 / 4000) {
  let flips = 0; let prev = 0;
  for (const v of kappa) {
    if (Math.abs(v) < floor) continue;
    const s = Math.sign(v);
    if (prev !== 0 && s !== prev) flips += 1;
    prev = s;
  }
  return (flips / Math.max(1, lengthM)) * 1000;
}

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function centripetal(pointsVec, closed, lengthHint) {
  const curve = new THREE.CatmullRomCurve3(pointsVec, closed, 'centripetal');
  curve.arcLengthDivisions = Math.max(240, Math.ceil(lengthHint / 14));
  curve.updateArcLengths();
  return curve;
}

// ---------------------------------------------------------------- analysis
function analyseRoute(routeData) {
  const route = map.routes.get(routeData.id);
  if (!route || routeData.points.length < 2 * HALF_WIN + 3) return null;
  const closed = !!routeData.closed;
  const rawPts = routeData.points.map((p) => ({ x: p[0], z: p[2] }));
  const n = rawPts.length;
  const rawLen = routeData.length;
  const at = (i) => rawPts[closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))];

  // cumulative arc length of raw polyline (to map dense s -> raw cell)
  const cum = [0];
  for (let i = 1; i < n; i += 1) cum.push(cum[i - 1] + dist(rawPts[i - 1], rawPts[i]));

  // circle fit per interior vertex
  const fits = new Array(n).fill(null);
  const iLo = closed ? 0 : HALF_WIN;
  const iHi = closed ? n - 1 : n - 1 - HALF_WIN;
  for (let i = iLo; i <= iHi; i += 1) {
    const win = [];
    for (let k = -HALF_WIN; k <= HALF_WIN; k += 1) win.push(at(i + k));
    fits[i] = fitCircle(win);
  }

  // 1) RAW residuals + bend classification per vertex
  const rawResidAll = [];
  const rawResidBend = [];
  const isBend = new Array(n).fill(false);
  for (let i = 0; i < n; i += 1) {
    if (!fits[i]) continue;
    const res = circleResidual(fits[i], rawPts[i]);
    rawResidAll.push(res);
    if (!fits[i].line && fits[i].r >= 120 && fits[i].r <= 2500) {
      isBend[i] = true;
      rawResidBend.push(res);
    }
  }

  const nearestVertex = (s) => {
    let lo = 0; let hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < s) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(cum[lo - 1] - s) < Math.abs(cum[lo] - s)) lo -= 1;
    return lo;
  };

  const residualsOf = (samples, scaleLen) => {
    const all = []; const bend = [];
    for (const p of samples) {
      const i = nearestVertex(p.s * (cum[n - 1] / scaleLen));
      if (!fits[i]) continue;
      const res = circleResidual(fits[i], p);
      all.push(res);
      if (isBend[i]) bend.push(res);
    }
    return { all, bend };
  };

  // 2) CURRENT SPLINE through raw points (no anchoring — isolates the spline)
  const rawVec = routeData.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const rawCurve = centripetal(rawVec, closed, rawLen);
  const denseRaw = denseSamples(rawCurve, rawCurve.getLength());
  const splineResid = residualsOf(denseRaw, rawCurve.getLength());
  const kappaRawCR = curvatureProfile(denseRaw);

  // 3) CANDIDATE: project each vertex onto its window circle, lock endpoints
  const lock = closed ? 0 : 2;
  const candPts = rawPts.map((p, i) => {
    if (!fits[i] || (!closed && (i < lock || i >= n - lock))) return { ...p };
    return circleProject(fits[i], p);
  });
  let candMoved = 0;
  for (let i = 0; i < n; i += 1) candMoved = Math.max(candMoved, dist(rawPts[i], candPts[i]));
  const candVec = candPts.map((p, i) => new THREE.Vector3(p.x, rawVec[i].y, p.z));
  const candCurve = centripetal(candVec, closed, rawLen);
  const denseCand = denseSamples(candCurve, candCurve.getLength());
  const candResid = residualsOf(denseCand, candCurve.getLength());
  const kappaCand = curvatureProfile(denseCand);

  // runtime curve (with anchoring) for the detail/overlay only
  const denseRun = denseSamples(route.curve, route.length);
  const kappaRun = curvatureProfile(denseRun);

  return {
    id: routeData.id,
    lengthM: rawLen,
    points: n,
    bendVerts: rawResidBend.length,
    rawP50: percentile(rawResidAll, 0.5),
    rawP95: percentile(rawResidAll, 0.95),
    rawBendP95: percentile(rawResidBend, 0.95),
    splineP95: percentile(splineResid.all, 0.95),
    splineBendP95: percentile(splineResid.bend, 0.95),
    splineBendMax: splineResid.bend.length ? Math.max(...splineResid.bend) : 0,
    candBendP95: percentile(candResid.bend, 0.95),
    candMoved,
    flipsRawCR: signFlipsPerKm(kappaRawCR, rawLen),
    flipsCand: signFlipsPerKm(kappaCand, rawLen),
    rawPts, fits, isBend, cum,
    denseRaw, kappaRawCR, denseCand, kappaCand, denseRun, kappaRun,
  };
}

// ---------------------------------------------------------------- overlay
function writeOverlay(r, file) {
  // worst 500 m window by current-spline bend residual
  const win = Math.round(500 / DS);
  const resAt = (p, i) => (r.fits[i] ? circleResidual(r.fits[i], p) : 0);
  const vertexOf = (p) => {
    let best = 0; let bestD = Infinity;
    for (let i = 0; i < r.rawPts.length; i += 1) {
      const d = dist(p, r.rawPts[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
  let bestWin = { score: -1, i0: 0 };
  for (let i0 = 0; i0 + win < r.denseRaw.length; i0 += Math.round(60 / DS)) {
    let score = 0;
    for (let i = i0; i < i0 + win; i += Math.round(10 / DS)) {
      const v = vertexOf(r.denseRaw[i]);
      if (r.isBend[v]) score += resAt(r.denseRaw[i], v);
    }
    if (score > bestWin.score) bestWin = { score, i0 };
  }
  const seg = r.denseRaw.slice(bestWin.i0, bestWin.i0 + win);
  const s0 = seg[0].s; const s1 = seg[seg.length - 1].s;
  const minX = Math.min(...seg.map((p) => p.x)) - 25;
  const maxX = Math.max(...seg.map((p) => p.x)) + 25;
  const minZ = Math.min(...seg.map((p) => p.z)) - 25;
  const maxZ = Math.max(...seg.map((p) => p.z)) + 25;
  const W = 1300;
  const scale = W / (maxX - minX);
  const H = Math.max(140, Math.ceil((maxZ - minZ) * scale));
  const sx = (p) => ((p.x - minX) * scale).toFixed(1);
  const sz = (p) => ((p.z - minZ) * scale).toFixed(1);
  const inBox = (p) => p.x >= minX && p.x <= maxX && p.z >= minZ && p.z <= maxZ;
  const poly = (pts, color, wpx) => `<polyline fill="none" stroke="${color}" stroke-width="${wpx}" points="${pts.map((p) => `${sx(p)},${sz(p)}`).join(' ')}"/>`;

  // curvature halo on the current spline
  let halo = '';
  for (let i = bestWin.i0; i < bestWin.i0 + win; i += 3) {
    const p = r.denseRaw[i];
    if (!p || !inBox(p)) continue;
    const k = r.kappaRawCR[i];
    const mag = Math.min(1, Math.abs(k) * 700);
    if (mag < 0.05) continue;
    const col = k > 0 ? `rgba(220,40,40,${(0.25 + 0.6 * mag).toFixed(2)})` : `rgba(40,80,220,${(0.25 + 0.6 * mag).toFixed(2)})`;
    halo += `<circle cx="${sx(p)}" cy="${sz(p)}" r="${(1.5 + 7 * mag).toFixed(1)}" fill="${col}"/>`;
  }
  const dots = r.rawPts.filter(inBox).map((p) => `<circle cx="${sx(p)}" cy="${sz(p)}" r="3.5" fill="#111"/>`).join('');

  // residual graph: raw dots + spline curve + candidate curve vs s
  const GH = 220; const GPAD = 40;
  const rs = (s) => GPAD + ((s - s0) / (s1 - s0)) * (W - 2 * GPAD);
  const maxRes = 1.6;
  const ry = (v) => GH - 15 - Math.min(1, v / maxRes) * (GH - 45);
  let graph = `<line x1="${GPAD}" y1="${ry(0)}" x2="${W - GPAD}" y2="${ry(0)}" stroke="#999"/>`;
  for (const g of [0.5, 1.0, 1.5]) {
    graph += `<line x1="${GPAD}" y1="${ry(g)}" x2="${W - GPAD}" y2="${ry(g)}" stroke="#ddd"/><text x="4" y="${ry(g) + 4}" font-size="11" font-family="monospace">${g.toFixed(1)}m</text>`;
  }
  const seriesPath = (dense, color) => {
    let d = '';
    for (let i = bestWin.i0; i < bestWin.i0 + win; i += 2) {
      const p = dense[i];
      if (!p) break;
      const v = vertexOf(p);
      if (!r.fits[v]) continue;
      d += `${d ? 'L' : 'M'}${rs(p.s).toFixed(1)},${ry(resAt(p, v)).toFixed(1)}`;
    }
    return `<path fill="none" stroke="${color}" stroke-width="1.8" d="${d}"/>`;
  };
  graph += seriesPath(r.denseRaw, '#e08020');
  graph += seriesPath(r.denseCand, '#1a9c40');
  for (let i = 0; i < r.rawPts.length; i += 1) {
    if (!r.fits[i]) continue;
    const s = r.cum[i];
    if (s < s0 || s > s1) continue;
    graph += `<circle cx="${rs(s).toFixed(1)}" cy="${ry(circleResidual(r.fits[i], r.rawPts[i])).toFixed(1)}" r="3.5" fill="#111"/>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + GH + 90}" viewBox="0 0 ${W} ${H + GH + 90}" style="background:#f6f6f1">
  <text x="12" y="20" font-family="monospace" font-size="14">${r.id} — worst bend window s=${Math.round(s0)}..${Math.round(s1)} m · black dots: raw OSM points · orange: current centripetal spline · green: candidate faired · halo: curvature (red left / blue right)</text>
  <g transform="translate(0,34)">${halo}${poly(seg.filter(inBox), '#e08020', 2.2)}${poly(r.denseCand.filter((p) => p.s >= s0 && p.s <= s1 && inBox(p)), '#1a9c40', 2.2)}${dots}</g>
  <text x="12" y="${H + 58}" font-family="monospace" font-size="14">lateral residual from local circle fit (the wave signal) vs arc length — same colours; dots = the raw data's own residual</text>
  <g transform="translate(0,${H + 70})">${graph}</g>
</svg>`;
  fs.writeFileSync(file, svg);
  return { s0, s1 };
}

// ---------------------------------------------------------------- run
const rows = [];
for (const routeData of data.routes) {
  const r = analyseRoute(routeData);
  if (r) rows.push(r);
}

console.log('route            len(m)  pts bendV | raw p50/p95/bendP95 | spline p95/bendP95/bendMax | cand bendP95 moved | flips/km rawCR cand');
for (const r of rows) {
  console.log(
    r.id.padEnd(14),
    String(Math.round(r.lengthM)).padStart(7),
    String(r.points).padStart(4),
    String(r.bendVerts).padStart(5), '|',
    r.rawP50.toFixed(2), r.rawP95.toFixed(2), r.rawBendP95.toFixed(2), '|',
    r.splineP95.toFixed(2), r.splineBendP95.toFixed(2), r.splineBendMax.toFixed(2), '|',
    r.candBendP95.toFixed(2), r.candMoved.toFixed(2), '|',
    r.flipsRawCR.toFixed(1), r.flipsCand.toFixed(1),
  );
}

const wsum = (key) => {
  const vals = rows.map((r) => r[key]);
  return `p50=${percentile(vals, 0.5).toFixed(2)} p95=${percentile(vals, 0.95).toFixed(2)} max=${Math.max(...vals).toFixed(2)}`;
};
console.log('\n=== AGGREGATE ===');
console.log('raw point residual p95 (m):        ', wsum('rawP95'));
console.log('raw point BEND residual p95 (m):   ', wsum('rawBendP95'));
console.log('spline BEND residual p95 (m):      ', wsum('splineBendP95'));
console.log('candidate BEND residual p95 (m):   ', wsum('candBendP95'));
console.log('candidate max point move (m):      ', wsum('candMoved'));
console.log('flips/km rawCR:                    ', wsum('flipsRawCR'));
console.log('flips/km candidate:                ', wsum('flipsCand'));

console.log('\n=== GATE VERDICT INPUTS ===');
const dataNoisy = rows.filter((r) => r.rawBendP95 > 0.2);
const splineAdds = rows.filter((r) => r.splineBendP95 > Math.max(0.25, r.rawBendP95 * 1.8));
console.log(`routes whose RAW DATA carries bend waves > 0.2 m (p95): ${dataNoisy.length}/${rows.length}`);
console.log(`routes where the SPLINE adds waves well beyond the data: ${splineAdds.length}/${rows.length}`);

for (const id of detailIds) {
  const r = rows.find((x) => x.id === id);
  if (!r) continue;
  const out = new URL(`./diagnosis-${id}.svg`, import.meta.url);
  const info = writeOverlay(r, out);
  console.log(`overlay ${id}: tools/diagnosis-${id}.svg (window s=${Math.round(info.s0)}–${Math.round(info.s1)} m)`);
}
