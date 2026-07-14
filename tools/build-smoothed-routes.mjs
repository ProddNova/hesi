/**
 * OFFLINE CENTRELINE FAIRING — generates data/routes-smoothed.json (+ .js).
 *
 * WHY (see tools/diagnose-centreline.mjs / diagnose-loo-calibrated.mjs):
 * data/routes.json geometry is a Douglas-Peucker polygon (tolerance 2 m)
 * densified with exactly-collinear chord points (74.5 % of all interior
 * vertices). The true road bulges up to ~2 m outside those chords and the
 * DP survivors concentrate direction change into single vertices. Any curve
 * that interpolates every point — including the runtime centripetal
 * Catmull-Rom — must reproduce that polygon: flat chord runs, a curvature
 * spike at each survivor ("waves in broad curves", "abrupt bends").
 *
 * WHAT: for each route, XZ-only shape-preserving fair fit:
 *   - resample the raw polyline at uniform 6 m;
 *   - penalized least squares:  min Σ w_j|p_j − q_j|² + λ Σ|Δ³p_j|²
 *     (third-difference penalty ≈ curvature-CHANGE energy: a constant-
 *     curvature arc costs nothing, so bends are not shrunk — only
 *     oscillation and corner spikes are removed);
 *   - hard-protected zones (weights ≫): route endpoints (position+tangent,
 *     also the runtime diverge/merge anchoring span), every edge
 *     connection station ±45 m, PA gate + access-leg spans;
 *   - lateral deviation from the raw polyline capped (default 1.8 m) by
 *     iterative reweighting;
 *   - cross-route clearance guard: where two same-level centrelines run
 *     close (< 16 m), the smoothed pair may never get closer than the raw
 *     pair did — offending stretches are pinned back to raw on both routes
 *     and re-solved (parallel carriageways must not pinch);
 *   - elevation untouched: y is carried from the raw profile at the same
 *     raw arc station (this pass fixes XZ only);
 *   - closed routes solved with circular padding;
 *   - every distance reference (tunnels, bridges, serviceAreas.distance,
 *     edges from/to.distance, route length) remapped onto the smoothed
 *     polyline by projection.
 *
 * Manual fixes: data/route-overrides.json (optional) is applied to the raw
 * points before smoothing:
 *   { "<routeId>": [ { "op": "move",   "index": 72, "to": [x, z] },
 *                    { "op": "insert", "after": 72, "point": [x, y, z] },
 *                    { "op": "delete", "index": 5 } ] }
 *
 * Run:  node tools/build-smoothed-routes.mjs [--lambda=3e5] [--cap=1.8]
 *       node tools/build-smoothed-routes.mjs --sweep     (λ calibration)
 */
import fs from 'node:fs';
import * as THREE from 'three';

const DS = 6;               // fit grid spacing (m)
const OUT_EVERY = 3;        // output every Nth fit point (18 m spacing)
const CAP = num('--cap', 1.8);        // max lateral deviation from raw (m)
const LAMBDA = num('--lambda', 3e5);  // fairness weight (see --sweep)
const W_PIN = 1e7;          // endpoint weight (position + tangent)
const W_PROT = 1e5;         // protected zone weight (connections, PA)
const END_SPAN = 36;        // pinned span at open ends (m)
const PROT_SPAN = 45;       // protected halo around connection stations (m)
const PAD = 80;             // circular padding points for closed routes

function num(flag, dflt) {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  return arg ? Number(arg.split('=')[1]) : dflt;
}

const root = new URL('../', import.meta.url);
const data = JSON.parse(fs.readFileSync(new URL('data/routes.json', root), 'utf8'));
let overrides = {};
try {
  overrides = JSON.parse(fs.readFileSync(new URL('data/route-overrides.json', root), 'utf8'));
  console.log('route-overrides.json: loaded');
} catch { /* optional */ }

// ---------------------------------------------------------------- geometry
const hyp = (dx, dz) => Math.hypot(dx, dz);

function cumLengths(pts, closed) {
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + hyp(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
  if (closed) cum.push(cum[cum.length - 1] + hyp(pts[0][0] - pts[pts.length - 1][0], pts[0][2] - pts[pts.length - 1][2]));
  return cum;
}

/** Sample [x,y,z] on the raw polyline at arc station s. */
function polylineAt(pts, cum, closed, s) {
  const total = cum[cum.length - 1];
  let t = closed ? ((s % total) + total) % total : Math.max(0, Math.min(total, s));
  let lo = 0; let hi = cum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= t) lo = mid; else hi = mid; }
  const a = pts[lo % pts.length];
  const b = pts[(lo + 1) % pts.length];
  const span = cum[lo + 1] - cum[lo] || 1;
  const f = (t - cum[lo]) / span;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * Lateral distance + arc station (+ interpolated y) of the projection of
 * (x,z) on a polyline. Optional station window [sLo, sHi] restricts the
 * search so self-approaching routes (loops, hairpins) cannot snap the
 * projection onto the wrong pass.
 */
function projectToPolyline(x, z, pts, cum, closed, sLo = -Infinity, sHi = Infinity) {
  let best = { d: Infinity, s: 0, y: pts[0][1] };
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs; i += 1) {
    if (cum[i + 1] < sLo || cum[i] > sHi) continue;
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0]; const dz = b[2] - a[2];
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-12) continue;
    let f = ((x - a[0]) * dx + (z - a[2]) * dz) / len2;
    f = Math.max(0, Math.min(1, f));
    const qx = a[0] + f * dx; const qz = a[2] + f * dz;
    const d = hyp(x - qx, z - qz);
    if (d < best.d) best = { d, s: cum[i] + Math.sqrt(len2) * f, y: a[1] + (b[1] - a[1]) * f };
  }
  return best;
}

// ---------------------------------------------------------- banded solver
/**
 * Solve (W + λ D3ᵀD3) p = W q for one coordinate. SPD, bandwidth 3.
 * Banded Cholesky: A stored as rows of [diag, +1, +2, +3].
 */
function solveFair(q, w, lambda) {
  const n = q.length;
  const B = 3;
  const A = Array.from({ length: n }, () => new Float64Array(B + 1));
  // data term
  for (let i = 0; i < n; i += 1) A[i][0] = w[i];
  // penalty: for each third difference r = -p[k] +3p[k+1] -3p[k+2] +p[k+3]
  const st = [-1, 3, -3, 1];
  for (let k = 0; k + 3 < n; k += 1) {
    for (let a = 0; a < 4; a += 1) {
      for (let b = a; b < 4; b += 1) {
        const i = k + a; const j = k + b;
        A[i][j - i] += lambda * st[a] * st[b];
      }
    }
  }
  const rhs = new Float64Array(n);
  for (let i = 0; i < n; i += 1) rhs[i] = w[i] * q[i];
  // banded Cholesky A = L Lᵀ (L lower, bandwidth 3)
  const L = Array.from({ length: n }, () => new Float64Array(B + 1)); // L[i][i-j]
  for (let i = 0; i < n; i += 1) {
    for (let j = Math.max(0, i - B); j <= i; j += 1) {
      let sum = j <= i ? (j >= i - B ? A[j][i - j] : 0) : 0;
      for (let k = Math.max(0, i - B, j - B); k < j; k += 1) {
        sum -= L[i][i - k] * L[j][j - k];
      }
      if (i === j) {
        L[i][0] = Math.sqrt(Math.max(sum, 1e-12));
      } else {
        L[i][i - j] = sum / L[j][0];
      }
    }
  }
  // forward substitution L y = rhs
  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = rhs[i];
    for (let k = Math.max(0, i - B); k < i; k += 1) sum -= L[i][i - k] * y[k];
    y[i] = sum / L[i][0];
  }
  // back substitution Lᵀ p = y
  const p = new Float64Array(n);
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = y[i];
    for (let k = i + 1; k <= Math.min(n - 1, i + B); k += 1) sum -= L[k][k - i] * p[k];
    p[i] = sum / L[i][0];
  }
  return p;
}

// ---------------------------------------------------------------- fairing
function applyOverrides(routeId, pts) {
  const ops = overrides[routeId];
  if (!ops) return pts;
  const out = pts.map((p) => [...p]);
  // apply in listed order; indices refer to the current state of the list
  for (const op of ops) {
    if (op.op === 'move') {
      out[op.index][0] = op.to[0];
      out[op.index][2] = op.to[op.to.length - 1];
    } else if (op.op === 'insert') {
      out.splice(op.after + 1, 0, op.point.length === 3 ? [...op.point]
        : [op.point[0], (out[op.after][1] + out[Math.min(op.after + 1, out.length - 1)][1]) / 2, op.point[1]]);
    } else if (op.op === 'delete') {
      out.splice(op.index, 1);
    } else {
      throw new Error(`unknown override op '${op.op}' on ${routeId}`);
    }
  }
  console.log(`  overrides applied to ${routeId}: ${ops.length} op(s)`);
  return out;
}

/** Protected arc stations for a route: [ [s0,s1,weight], ... ] */
function protectedZones(routeData, rawLen, rawPts, cum) {
  const zones = [];
  if (!routeData.closed) {
    zones.push([0, END_SPAN, W_PIN]);
    zones.push([rawLen - END_SPAN, rawLen, W_PIN]);
  }
  for (const edge of data.edges || []) {
    if (edge.from.route === routeData.id) {
      zones.push([edge.from.distance - PROT_SPAN, edge.from.distance + PROT_SPAN, W_PROT]);
    }
    if (edge.to.route === routeData.id) {
      zones.push([edge.to.distance - PROT_SPAN, edge.to.distance + PROT_SPAN, W_PROT]);
    }
  }
  // Anchored branch ends: the runtime re-anchors a diverge start / merge end
  // onto the host's outer edge with a smoothstep blend over 2*anchorSpan of
  // the branch — the committed geometry steers that whole taper, so it must
  // stay raw or the gore walls clash (mirrors map.js _registerDataRoute).
  if (!routeData.closed) {
    const endDrop = Math.abs(routeData.points[0][1] - routeData.points[routeData.points.length - 1][1]);
    const steep = endDrop > routeData.length * 0.05;
    const anchorSpan = steep ? 30 : Math.min(95, Math.max(30, routeData.length * 0.22));
    const blend = anchorSpan * 2 + 30;
    for (const edge of data.edges || []) {
      if (edge.kind === 'diverge' && edge.to.route === routeData.id && edge.to.distance < 50) {
        zones.push([0, blend, W_PROT]);
      }
      if (edge.kind === 'merge' && edge.from.route === routeData.id && edge.from.distance > routeData.length - 50) {
        zones.push([rawLen - blend, rawLen, W_PROT]);
      }
    }
  }
  for (const sa of data.serviceAreas || []) {
    if (sa.routeId === routeData.id) {
      // the runtime synthesizes the PA lot AND its access legs from host
      // geometry well beyond the lot span — keep a generous halo raw
      const half = (sa.length || 220) * 0.5 + 120;
      zones.push([sa.distance - half, sa.distance + half, W_PROT]);
    }
    if (sa.grounded) {
      // grounded PA (Daikoku): the runtime picks entry/exit hosts among ANY
      // nearby routes and winds descent spirals off their outer edges — the
      // whole stack's geometry is load-bearing. Freeze every route where it
      // passes near the lot centroid; the access mouths reach lot half-length
      // + 360 m leg + 60 m mouth pair along their hosts, so cover that too.
      const R = 700;
      for (let k = 0; k < rawPts.length; k += 1) {
        if (hyp(rawPts[k][0] - sa.x, rawPts[k][2] - sa.z) < R) {
          zones.push([cum[k] - 40, cum[k] + 40, W_PROT]);
        }
      }
    }
  }
  return zones;
}

function prepareRoute(routeData) {
  const rawPts = applyOverrides(routeData.id, routeData.points);
  const closed = !!routeData.closed;
  const cum = cumLengths(rawPts, closed);
  const rawLen = cum[cum.length - 1];

  // synthetic connectors are generated geometry (measured clean) and very
  // tight — pass them through untouched, like anything too short to fair
  if (routeData.synthetic || rawLen < 160 || rawPts.length < 8) {
    return { id: routeData.id, routeData, rawPts, cum, rawLen, closed, skipped: true };
  }

  // uniform resample (fit grid)
  const n = Math.max(8, Math.round(rawLen / DS)) + (closed ? 0 : 1);
  const step = rawLen / (closed ? n : n - 1);
  const grid = [];
  for (let i = 0; i < n; i += 1) grid.push(polylineAt(rawPts, cum, closed, i * step));

  // weights from protected zones
  const zones = protectedZones(routeData, rawLen, rawPts, cum);
  const weightAt = (s) => {
    let w = 1;
    for (const [s0, s1, wz] of zones) {
      if (closed) {
        // compare on the circle
        const t = ((s % rawLen) + rawLen) % rawLen;
        const a = ((s0 % rawLen) + rawLen) % rawLen;
        const b = ((s1 % rawLen) + rawLen) % rawLen;
        const inside = a <= b ? (t >= a && t <= b) : (t >= a || t <= b);
        if (inside) w = Math.max(w, wz);
      } else if (s >= s0 && s <= s1) {
        w = Math.max(w, wz);
      }
    }
    return w;
  };

  // solver arrays (with circular padding for closed routes)
  const pad = closed ? PAD : 0;
  const N = n + 2 * pad;
  const gi = (i) => ((i - pad) % n + n) % n;
  const qx = new Float64Array(N);
  const qz = new Float64Array(N);
  const w = new Float64Array(N);
  for (let i = 0; i < N; i += 1) {
    const g = grid[gi(i)];
    qx[i] = g[0]; qz[i] = g[2];
    w[i] = weightAt(gi(i) * step);
  }
  // The game's CURRENT elevation profile is the y of the centripetal
  // Catmull-Rom through the raw points — sample output heights from it (not
  // from the chord polygon, whose kinks would sharpen raw y-spikes when the
  // output points are denser than the raw vertices).
  const rawCurve = new THREE.CatmullRomCurve3(
    rawPts.map((p) => new THREE.Vector3(p[0], p[1], p[2])), closed, 'centripetal',
  );
  rawCurve.arcLengthDivisions = Math.max(240, Math.ceil(rawLen / 7));
  rawCurve.updateArcLengths();
  const yAtStation = (s) => {
    const u = Math.max(0, Math.min(1, s / rawLen));
    return rawCurve.getPointAt(closed ? u % 1 : u).y;
  };
  return { id: routeData.id, routeData, rawPts, cum, rawLen, closed, skipped: false, n, step, grid, pad, N, gi, qx, qz, w, yAtStation };
}

/** Solve/re-solve one route with deviation-cap reweighting. */
function solveState(state, lambda = LAMBDA) {
  if (state.skipped) return;
  const { qx, qz, w, pad, N, rawPts, cum, closed } = state;
  let maxDev = 0;
  for (let round = 0; round < 8; round += 1) {
    state.px = solveFair(qx, w, lambda);
    state.pz = solveFair(qz, w, lambda);
    maxDev = 0;
    let bumped = 0;
    for (let i = pad; i < N - pad; i += 1) {
      const { d } = projectToPolyline(state.px[i], state.pz[i], rawPts, cum, closed);
      if (d > maxDev) maxDev = d;
      if (d > CAP && w[i] < W_PROT) { w[i] *= 4; bumped += 1; }
    }
    if (!bumped) break;
  }
  state.maxDev = maxDev;
}

/**
 * Cross-route clearance guard. Two centrelines at similar deck height that
 * run close together (parallel carriageways, braided ramps) must not end up
 * closer than the raw data had them: smoothing each route independently can
 * pinch the corridor gap and create same-level surface overlaps. Offending
 * grid nodes are pinned back to raw on BOTH routes, then re-solved.
 * Returns the number of repair rounds executed.
 */
function clearanceGuard(states) {
  const LEVEL = 7;    // same-level threshold on deck height (m)
  const SLACK = 0.15; // allowed gap loss before pinning (m)
  const MARGIN = 1.4; // required plan clearance beyond the two half-widths
  const CELL = 24;
  // approximate runtime half-width from the data (map.js: lanes*laneWidth/2
  // + shoulder, one-way carriageways)
  const halfOf = (routeData) => {
    const lanes = routeData.lanes || (routeData.kind === 'ramp' ? 1 : 2);
    const shoulder = routeData.kind === 'ramp' || routeData.kind === 'service' ? 0.95 : 2.5;
    return lanes * 3.5 * 0.5 + shoulder;
  };
  let rounds = 0;
  for (; rounds < 4; rounds += 1) {
    // spatial hash of every core grid node (smoothed position)
    const hash = new Map();
    const nodes = [];
    for (const st of states) {
      if (st.skipped) continue;
      for (let i = st.pad; i < st.N - st.pad; i += 1) {
        const node = {
          st,
          i,
          x: st.px[i],
          z: st.pz[i],
          rx: st.qx[i],
          rz: st.qz[i],
          y: st.grid[st.gi(i)][1],
        };
        nodes.push(node);
        const key = `${Math.floor(node.x / CELL)},${Math.floor(node.z / CELL)}`;
        if (!hash.has(key)) hash.set(key, []);
        hash.get(key).push(node);
      }
    }
    const dirty = new Set();
    for (const a of nodes) {
      const cx = Math.floor(a.x / CELL);
      const cz = Math.floor(a.z / CELL);
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oz = -1; oz <= 1; oz += 1) {
          const bucket = hash.get(`${cx + ox},${cz + oz}`);
          if (!bucket) continue;
          for (const b of bucket) {
            if (b.st === a.st) continue;
            if (a.st.id > b.st.id) continue; // each pair once
            if (Math.abs(a.y - b.y) > LEVEL) continue;
            const needed = halfOf(a.st.routeData) + halfOf(b.st.routeData) + MARGIN;
            const gSm = hyp(a.x - b.x, a.z - b.z);
            // pin only when the corridors actually threaten to touch AND
            // the smoothed pair is tighter than the raw pair was — gaps
            // with clearance to spare may flex freely
            if (gSm >= needed) continue;
            const gRaw = hyp(a.rx - b.rx, a.rz - b.rz);
            if (gSm >= gRaw - SLACK) continue;
            if (a.st.w[a.i] < W_PROT) { a.st.w[a.i] = W_PROT; dirty.add(a.st); }
            if (b.st.w[b.i] < W_PROT) { b.st.w[b.i] = W_PROT; dirty.add(b.st); }
          }
        }
      }
    }
    if (!dirty.size) break;
    for (const st of dirty) solveState(st);
  }
  return rounds;
}

/** Final point list + stats for a solved state. */
function finishRoute(state) {
  const { rawPts, cum, closed } = state;
  if (state.skipped) {
    return { pts: rawPts.map((p) => [...p]), cum, rawPts, rawCum: cum, stats: { skipped: true, maxDev: 0, lenDelta: 0 } };
  }
  // Output: decimated fair grid, y from the raw profile at the same raw
  // station (XZ-only pass). Protected stretches (w ≥ W_PROT) emit the RAW
  // VERTICES VERBATIM instead of resampled copies: the runtime derives
  // stations, mouths and tapers by walking metres along the curve, so
  // protected geometry must keep its exact shape AND arc length — a
  // resampled copy cuts corners by centimetres and slides every anchor
  // downstream of it.
  const { px, pz, w, pad, N, gi, step, yAtStation } = state;
  const pts = [];
  const pushPt = (p) => {
    const last = pts[pts.length - 1];
    if (last && hyp(last[0] - p[0], last[2] - p[2]) < 1.5) return; // no near-duplicates
    pts.push(p);
  };
  let i = pad;
  while (i < N - pad) {
    if (w[i] < W_PROT) {
      // y from the current (raw-curve) profile at the PROJECTED plan
      // position: smoothing shortens the path locally, and station-carried
      // heights would compress the grade into steps at zone boundaries
      const s0 = gi(i) * step;
      const proj = projectToPolyline(px[i], pz[i], rawPts, cum, closed, s0 - 60, s0 + 60);
      pushPt([px[i], yAtStation(proj.s), pz[i]]);
      i += OUT_EVERY;
      continue;
    }
    // protected stretch: [sA, sB] in raw stations
    let j = i;
    while (j < N - pad && w[j] >= W_PROT) j += 1;
    const sA = gi(i) * step;
    const sB = gi(j - 1) * step;
    for (let k = 0; k < rawPts.length; k += 1) {
      if (cum[k] >= sA - step && cum[k] <= sB + step) pushPt([...rawPts[k]]);
    }
    i = j;
  }
  if (!closed) {
    // endpoints stay exactly raw (pinned zones emit them, but make certain)
    if (hyp(pts[0][0] - rawPts[0][0], pts[0][2] - rawPts[0][2]) > 1e-9) pts.unshift([...rawPts[0]]);
    const rawEnd = rawPts[rawPts.length - 1];
    const last = pts[pts.length - 1];
    if (hyp(last[0] - rawEnd[0], last[2] - rawEnd[2]) > 1e-9) pts.push([...rawEnd]);
  }
  const outCum = cumLengths(pts, closed);
  return {
    pts,
    cum: outCum,
    rawPts,
    rawCum: cum,
    stats: { skipped: false, maxDev: state.maxDev, lenDelta: outCum[outCum.length - 1] - state.rawLen },
  };
}

/** Single-route pipeline (λ sweep helper; no cross-route guard). */
function fairRoute(routeData, lambda = LAMBDA) {
  const state = prepareRoute(routeData);
  solveState(state, lambda);
  return finishRoute(state);
}

// ------------------------------------------------------------- λ sweep
if (process.argv.includes('--sweep')) {
  const { sweep } = await import('./fairing-metrics.mjs');
  await sweep(data, fairRoute, { DS, CAP });
  process.exit(0);
}

// ---------------------------------------------------------------- build
console.log(`fairing: ds=${DS} m, λ=${LAMBDA}, cap=${CAP} m, out spacing=${DS * OUT_EVERY} m`);
const out = JSON.parse(JSON.stringify(data));
const states = data.routes.map((routeData) => prepareRoute(routeData));
for (const state of states) solveState(state);
const guardRounds = clearanceGuard(states);
console.log(`clearance guard: ${guardRounds} repair round(s)`);
const results = new Map();
let worstDev = { v: 0, id: '' };
for (const routeData of out.routes) {
  const r = finishRoute(states.find((s) => s.id === routeData.id));
  results.set(routeData.id, r);
  if (r.stats.maxDev > worstDev.v) worstDev = { v: r.stats.maxDev, id: routeData.id };

  const round2 = (v) => Math.round(v * 100) / 100;
  routeData.points = r.pts.map((p) => p.map(round2));
  const newLen = r.cum[r.cum.length - 1];

  // remap every distance reference: raw station -> point -> projection on
  // the smoothed polyline
  const remap = (s) => {
    const [x, , z] = polylineAt(r.rawPts, r.rawCum, !!routeData.closed, s);
    return Math.round(projectToPolyline(x, z, r.pts, r.cum, !!routeData.closed, s - 100, s + 100).s * 100) / 100;
  };
  routeData.tunnels = (routeData.tunnels || []).map((t) => ({ ...t, start: remap(t.start), end: remap(t.end) }));
  routeData.bridges = (routeData.bridges || []).map((b) => ({ ...b, start: remap(b.start), end: remap(b.end) }));
  routeData.length = Math.round(newLen * 100) / 100;

  if (!r.stats.skipped) {
    console.log(`  ${routeData.id.padEnd(14)} maxDev ${r.stats.maxDev.toFixed(2)} m  Δlen ${r.stats.lenDelta >= 0 ? '+' : ''}${r.stats.lenDelta.toFixed(1)} m  pts ${data.routes.find((x) => x.id === routeData.id).points.length} -> ${r.pts.length}`);
  }
}

for (const edge of out.edges || []) {
  const remapOn = (routeId, s) => {
    const r = results.get(routeId);
    const src = data.routes.find((x) => x.id === routeId);
    if (!r || !src) return s;
    const [x, , z] = polylineAt(r.rawPts, r.rawCum, !!src.closed, s);
    return Math.round(projectToPolyline(x, z, r.pts, r.cum, !!src.closed, s - 100, s + 100).s * 100) / 100;
  };
  edge.from.distance = remapOn(edge.from.route, edge.from.distance);
  edge.to.distance = remapOn(edge.to.route, edge.to.distance);
}
for (const sa of out.serviceAreas || []) {
  const r = results.get(sa.routeId);
  const src = data.routes.find((x) => x.id === sa.routeId);
  if (!r || !src) continue;
  const [x, , z] = polylineAt(r.rawPts, r.rawCum, !!src.closed, sa.distance);
  sa.distance = Math.round(projectToPolyline(x, z, r.pts, r.cum, !!src.closed, sa.distance - 100, sa.distance + 100).s * 100) / 100;
}

out.meta.fairing = {
  tool: 'tools/build-smoothed-routes.mjs',
  source: 'data/routes.json',
  generatedAt: new Date().toISOString(),
  ds: DS, lambda: LAMBDA, cap: CAP, outSpacing: DS * OUT_EVERY,
};

const json = JSON.stringify(out);
fs.writeFileSync(new URL('data/routes-smoothed.json', root), json);
fs.writeFileSync(new URL('data/routes-smoothed.js', root),
  `// GENERATED by tools/build-smoothed-routes.mjs from data/routes.json — do not edit by hand.\n`
  + `// Offline-faired centrelines (XZ only). Raw OSM data lives in data/routes.js.\n`
  + `// Data © OpenStreetMap contributors, ODbL 1.0.\n`
  + `export default ${json};\n`);
console.log(`\nwrote data/routes-smoothed.json (${(json.length / 1024).toFixed(0)} KB), worst deviation ${worstDev.v.toFixed(2)} m on ${worstDev.id}`);
