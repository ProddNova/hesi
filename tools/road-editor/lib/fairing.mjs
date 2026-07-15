/**
 * SHARED CENTRELINE FAIRING CORE.
 *
 * Single source of truth for the offline fairing mathematics. Used by BOTH:
 *   - tools/build-smoothed-routes.mjs   (CLI generator of data/routes-smoothed.*)
 *   - tools/road-editor/server.mjs      (manual road editor live preview)
 * so the editor preview and the committed generated assets are produced by
 * the exact same code — never by a separate browser approximation.
 *
 * The numerical pipeline is extracted VERBATIM from the original
 * tools/build-smoothed-routes.mjs (base dbb2e33): identical operations in
 * identical order, so with identical inputs the output is byte-identical.
 * See that file's header for the full rationale (third-difference penalized
 * least squares on a 6 m grid, protected zones, deviation cap, cross-route
 * clearance guard, XZ-only — y carried from the raw profile).
 *
 * Manual overrides (data/route-overrides.json) are applied to the raw points
 * before fairing. Two formats are supported:
 *
 * v1 (legacy, index-based — kept working verbatim):
 *   { "<routeId>": [ { "op": "move",   "index": 72, "to": [x, z] },
 *                    { "op": "insert", "after": 72, "point": [x, y, z] },
 *                    { "op": "delete", "index": 5 } ] }
 *
 * v2 (stable, editor-written — anchors survive resampling/regeneration):
 *   { "version": 2,
 *     "meta": { ... },
 *     "routes": { "<routeId>": [ <op>, ... ] } }
 *
 *   Every v2 op has a stable anchor instead of a mutable array index:
 *     anchor: { station:  chainage (m) on the raw route,
 *               point:    [x, z] raw position at creation time (signature),
 *               fingerprint: [[x,z],[x,z]]  optional bracketing raw vertices,
 *               tolerance: matching tolerance in metres }
 *   plus: id (stable string), enabled (default true), note, createdAt.
 *
 *   Ops:
 *     move   { anchor, to:[x,z], influence=45, weight=24 }
 *              cosine-falloff bump of the raw polyline towards `to` over
 *              ±influence metres, plus a data-weight floor so the solver
 *              tracks the handle. influence=0 pins a single vertex.
 *     insert { anchor, point:[x,y,z]|[x,z], weight=24 }
 *              insert one raw control vertex after the anchored segment.
 *     delete { anchor }
 *              remove the nearest raw vertex — only when safely matchable
 *              (within anchor.tolerance, default 6 m), otherwise skipped
 *              with a warning.
 *     pin    { anchor, span=30 }
 *              weight floor W_PROT over ±span: the stretch is emitted raw
 *              verbatim, exactly like a protected zone.
 *     smooth { anchor, span=60, factor=0.25 }
 *              scales the data weight (×factor, clamped [0.02, 1]) over
 *              ±span so the fairing smooths harder locally. The deviation
 *              cap and protected zones still apply on top.
 *
 * All exported entry points are pure with respect to module state: data,
 * overrides and parameters are arguments — nothing reads process.argv or
 * the filesystem here.
 */
import * as THREE from 'three';

// -------------------------------------------------------------- parameters
export const DEFAULT_PARAMS = Object.freeze({
  DS: 6,               // fit grid spacing (m)
  OUT_EVERY: 3,        // output every Nth fit point (18 m spacing)
  CAP: 1.8,            // max lateral deviation from raw (m)
  LAMBDA: 3e5,         // fairness weight
  W_PIN: 1e7,          // endpoint weight (position + tangent)
  W_PROT: 1e5,         // protected zone weight (connections, PA)
  END_SPAN: 36,        // pinned span at open ends (m)
  PROT_SPAN: 45,       // protected halo around connection stations (m)
  PAD: 80,             // circular padding points for closed routes
});

export function makeParams(over = {}) {
  return { ...DEFAULT_PARAMS, ...over };
}

// ---------------------------------------------------------------- geometry
export const hyp = (dx, dz) => Math.hypot(dx, dz);

export function cumLengths(pts, closed) {
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + hyp(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
  if (closed) cum.push(cum[cum.length - 1] + hyp(pts[0][0] - pts[pts.length - 1][0], pts[0][2] - pts[pts.length - 1][2]));
  return cum;
}

/** Sample [x,y,z] on the raw polyline at arc station s. */
export function polylineAt(pts, cum, closed, s) {
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
export function projectToPolyline(x, z, pts, cum, closed, sLo = -Infinity, sHi = Infinity) {
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
export function solveFair(q, w, lambda) {
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

// ------------------------------------------------------ override handling
/** True when an overrides document is the stable v2 editor format. */
export function isV2Overrides(overrides) {
  return !!overrides && overrides.version === 2 && typeof overrides.routes === 'object';
}

/** Ops list (v1 array or v2 array) for a route, or null. */
export function overrideOpsFor(overrides, routeId) {
  if (!overrides) return null;
  const ops = isV2Overrides(overrides) ? overrides.routes[routeId] : overrides[routeId];
  return Array.isArray(ops) && ops.length ? ops : null;
}

const V2_DEFAULTS = Object.freeze({
  moveInfluence: 45,   // bump half-width (m) around a moved handle
  moveWeight: 24,      // data-weight floor so the solver tracks the handle
  pinSpan: 30,
  smoothSpan: 60,
  smoothFactor: 0.25,
  matchTolerance: 15,  // anchor point-signature tolerance (m)
  deleteTolerance: 6,  // delete must match a raw vertex this closely (m)
  stationWindow: 120,  // projection window half-width around anchor.station
});
export { V2_DEFAULTS };

/**
 * Resolve a v2 anchor against the CURRENT working polyline.
 * Returns { ok, s, d, reason } — s is the matched arc station.
 */
export function resolveAnchor(anchor, pts, cum, closed) {
  if (!anchor || typeof anchor !== 'object') return { ok: false, reason: 'anchor mancante' };
  const total = cum[cum.length - 1];
  const tol = Number.isFinite(anchor.tolerance) ? anchor.tolerance : V2_DEFAULTS.matchTolerance;
  const hasStation = Number.isFinite(anchor.station);
  const hasPoint = Array.isArray(anchor.point) && anchor.point.length >= 2
    && Number.isFinite(anchor.point[0]) && Number.isFinite(anchor.point[1]);
  if (hasPoint) {
    const win = Math.max(V2_DEFAULTS.stationWindow, tol * 8);
    const sLo = hasStation ? anchor.station - win : -Infinity;
    const sHi = hasStation ? anchor.station + win : Infinity;
    const proj = projectToPolyline(anchor.point[0], anchor.point[1], pts, cum, closed, sLo, sHi);
    if (proj.d <= tol) return { ok: true, s: proj.s, d: proj.d };
    if (hasStation) {
      // widen once: the route may have been re-cut and stations shifted
      const proj2 = projectToPolyline(anchor.point[0], anchor.point[1], pts, cum, closed);
      if (proj2.d <= tol) return { ok: true, s: proj2.s, d: proj2.d, widened: true };
    }
    return { ok: false, reason: `nessuna corrispondenza entro ${tol} m (min ${proj.d.toFixed(1)} m)` };
  }
  if (hasStation) {
    const s = closed ? ((anchor.station % total) + total) % total : Math.max(0, Math.min(total, anchor.station));
    return { ok: true, s, d: 0, weak: true };
  }
  return { ok: false, reason: 'anchor senza station né point' };
}

/** Arc distance between two stations, wrap-aware for closed routes. */
function arcDist(a, b, total, closed) {
  const d = Math.abs(a - b);
  return closed ? Math.min(d, total - d) : d;
}

/** Insert a vertex at station s (linear on the current polyline). Returns new pts. */
function insertVertexAt(pts, cum, closed, s) {
  const total = cum[cum.length - 1];
  const t = closed ? ((s % total) + total) % total : Math.max(0, Math.min(total, s));
  let lo = 0; let hi = cum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= t) lo = mid; else hi = mid; }
  const p = polylineAt(pts, cum, closed, t);
  // avoid duplicate vertices when s falls on an existing one
  const prev = pts[lo % pts.length];
  const next = pts[(lo + 1) % pts.length];
  if (hyp(p[0] - prev[0], p[2] - prev[2]) < 0.75) return { pts, index: lo % pts.length, inserted: false };
  if (hyp(p[0] - next[0], p[2] - next[2]) < 0.75) return { pts, index: (lo + 1) % pts.length, inserted: false };
  const out = pts.slice();
  out.splice((lo % pts.length) + 1, 0, p);
  return { pts: out, index: (lo % pts.length) + 1, inserted: true };
}

/**
 * Apply a route's override ops to its raw points.
 *
 * Returns { pts, weightFloors, weightScales, applied, skipped, warnings }:
 *   pts          — new point list (input never mutated);
 *   weightFloors — [{s0,s1,w}] data-weight floors in FINAL-polyline stations;
 *   weightScales — [{s0,s1,f}] data-weight scales in FINAL-polyline stations;
 *   applied      — count of ops that took effect;
 *   warnings     — human-readable notes about skipped/degraded ops (Italian).
 *
 * v1 ops (index-based) reproduce the original generator behaviour verbatim.
 */
export function applyOverrides(routeData, overrides, { log = null } = {}) {
  const routeId = routeData.id;
  const closed = !!routeData.closed;
  const ops = overrideOpsFor(overrides, routeId);
  const empty = {
    pts: routeData.points, weightFloors: [], weightScales: [], applied: 0, skipped: 0, warnings: [],
  };
  if (!ops) return empty;

  const v2 = isV2Overrides(overrides);
  let out = routeData.points.map((p) => [...p]);
  const warnings = [];
  let applied = 0;
  let skipped = 0;

  if (!v2) {
    // legacy format: apply in listed order; indices refer to the current list
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
      applied += 1;
    }
    if (log) log(`  overrides applied to ${routeId}: ${ops.length} op(s)`);
    return { pts: out, weightFloors: [], weightScales: [], applied, skipped, warnings };
  }

  // ---------------------------------------------------------- v2 (stable)
  // Geometry pass: ops in listed order, each resolved against the CURRENT
  // polyline via its point signature (robust to earlier inserts/deletes).
  const later = []; // weight effects re-anchored on the final polyline
  for (const op of ops) {
    if (op.enabled === false) { skipped += 1; continue; }
    const cum = cumLengths(out, closed);
    const total = cum[cum.length - 1];
    const res = resolveAnchor(op.anchor, out, cum, closed);
    if (!res.ok) {
      skipped += 1;
      warnings.push(`${routeId}: op ${op.id || op.op} saltata — ${res.reason}`);
      continue;
    }
    if (op.op === 'move') {
      const to = op.to;
      if (!Array.isArray(to) || to.length < 2 || !Number.isFinite(to[0]) || !Number.isFinite(to[1])) {
        skipped += 1;
        warnings.push(`${routeId}: op ${op.id || 'move'} saltata — destinazione non valida`);
        continue;
      }
      const influence = Math.max(0, Number.isFinite(op.influence) ? op.influence : V2_DEFAULTS.moveInfluence);
      const base = polylineAt(out, cum, closed, res.s);
      const dx = to[0] - base[0];
      const dz = to[1] - base[2];
      // make sure the peak displacement is represented by an actual vertex
      let sStar = res.s;
      const near = Math.min(2.5, Math.max(0.75, influence * 0.25));
      let hasNear = false;
      for (let k = 0; k < out.length; k += 1) {
        if (arcDist(cum[k], sStar, total, closed) <= near) { hasNear = true; break; }
      }
      if (!hasNear) {
        const ins = insertVertexAt(out, cum, closed, sStar);
        out = ins.pts;
      }
      const cum2 = cumLengths(out, closed);
      const total2 = cum2[cum2.length - 1];
      if (influence === 0) {
        // pin-style single-vertex move
        let bi = 0; let bd = Infinity;
        for (let k = 0; k < out.length; k += 1) {
          const d = arcDist(cum2[k], sStar, total2, closed);
          if (d < bd) { bd = d; bi = k; }
        }
        out[bi][0] += dx;
        out[bi][2] += dz;
      } else {
        for (let k = 0; k < out.length; k += 1) {
          const r = arcDist(cum2[k], sStar, total2, closed);
          if (r >= influence) continue;
          const f = 0.5 * (1 + Math.cos((Math.PI * r) / influence));
          out[k][0] += dx * f;
          out[k][2] += dz * f;
        }
      }
      const weight = Math.max(1, Number.isFinite(op.weight) ? op.weight : V2_DEFAULTS.moveWeight);
      later.push({ kind: 'floor', point: [to[0], to[1]], half: Math.max(influence, 9), w: weight, station: sStar });
      applied += 1;
    } else if (op.op === 'insert') {
      const pt = op.point;
      if (!Array.isArray(pt) || pt.length < 2) {
        skipped += 1;
        warnings.push(`${routeId}: op ${op.id || 'insert'} saltata — punto non valido`);
        continue;
      }
      const cumB = cumLengths(out, closed);
      const t = closed ? ((res.s % total) + total) % total : Math.max(0, Math.min(total, res.s));
      let lo = 0; let hi = cumB.length - 1;
      while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cumB[mid] <= t) lo = mid; else hi = mid; }
      const after = lo % out.length;
      const p3 = pt.length === 3 ? [...pt]
        : [pt[0], (out[after][1] + out[Math.min(after + 1, out.length - 1)][1]) / 2, pt[1]];
      out.splice(after + 1, 0, p3);
      const weight = Math.max(1, Number.isFinite(op.weight) ? op.weight : V2_DEFAULTS.moveWeight);
      later.push({ kind: 'floor', point: [p3[0], p3[2]], half: 9, w: weight, station: res.s });
      applied += 1;
    } else if (op.op === 'delete') {
      const tol = Number.isFinite(op.anchor && op.anchor.tolerance) ? op.anchor.tolerance : V2_DEFAULTS.deleteTolerance;
      const target = op.anchor.point;
      if (!Array.isArray(target)) {
        skipped += 1;
        warnings.push(`${routeId}: op ${op.id || 'delete'} saltata — richiede anchor.point`);
        continue;
      }
      let bi = -1; let bd = Infinity;
      for (let k = 0; k < out.length; k += 1) {
        const d = hyp(out[k][0] - target[0], out[k][2] - target[1]);
        if (d < bd) { bd = d; bi = k; }
      }
      if (bi < 0 || bd > tol || out.length <= 4) {
        skipped += 1;
        warnings.push(`${routeId}: op ${op.id || 'delete'} saltata — nessun vertice entro ${tol} m`);
        continue;
      }
      out.splice(bi, 1);
      applied += 1;
    } else if (op.op === 'pin') {
      const span = Math.max(3, Number.isFinite(op.span) ? op.span : V2_DEFAULTS.pinSpan);
      const base = polylineAt(out, cum, closed, res.s);
      later.push({ kind: 'floor', point: [base[0], base[2]], half: span, w: null, station: res.s }); // w=null → W_PROT
      applied += 1;
    } else if (op.op === 'smooth') {
      const span = Math.max(6, Number.isFinite(op.span) ? op.span : V2_DEFAULTS.smoothSpan);
      const factor = Math.min(1, Math.max(0.02, Number.isFinite(op.factor) ? op.factor : V2_DEFAULTS.smoothFactor));
      const base = polylineAt(out, cum, closed, res.s);
      later.push({ kind: 'scale', point: [base[0], base[2]], half: span, f: factor, station: res.s });
      applied += 1;
    } else {
      throw new Error(`unknown override op '${op.op}' on ${routeId}`);
    }
  }

  // Weight pass: re-anchor every effect on the FINAL polyline so stations
  // are consistent after all inserts/deletes.
  const cumF = cumLengths(out, closed);
  const weightFloors = [];
  const weightScales = [];
  for (const e of later) {
    const proj = projectToPolyline(e.point[0], e.point[1], out, cumF, closed, e.station - 240, e.station + 240);
    const s = proj.d < 60 ? proj.s : e.station;
    if (e.kind === 'floor') weightFloors.push({ s0: s - e.half, s1: s + e.half, w: e.w });
    else weightScales.push({ s0: s - e.half, s1: s + e.half, f: e.f });
  }
  if (log && (applied || skipped)) log(`  overrides applied to ${routeId}: ${applied} op(s)${skipped ? `, ${skipped} skipped` : ''}`);
  return { pts: out, weightFloors, weightScales, applied, skipped, warnings };
}

// ---------------------------------------------------------------- fairing
/** Protected arc stations for a route: [ [s0,s1,weight], ... ] */
export function protectedZones(routeData, rawLen, rawPts, cum, data, params = DEFAULT_PARAMS) {
  const { W_PIN, W_PROT, END_SPAN, PROT_SPAN } = params;
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

/**
 * Prepare the solver state for one route.
 * ctx: { data, overrides, params, log }
 */
export function prepareRoute(routeData, ctx) {
  const { data, overrides = null, params = DEFAULT_PARAMS, log = null } = ctx;
  const { DS } = params;
  const ov = applyOverrides(routeData, overrides, { log });
  const rawPts = ov.pts;
  const closed = !!routeData.closed;
  const cum = cumLengths(rawPts, closed);
  const rawLen = cum[cum.length - 1];

  // synthetic connectors are generated geometry (measured clean) and very
  // tight — pass them through untouched, like anything too short to fair
  if (routeData.synthetic || rawLen < 160 || rawPts.length < 8) {
    return { id: routeData.id, routeData, rawPts, cum, rawLen, closed, skipped: true, params, overrideResult: ov };
  }

  // uniform resample (fit grid)
  const n = Math.max(8, Math.round(rawLen / DS)) + (closed ? 0 : 1);
  const step = rawLen / (closed ? n : n - 1);
  const grid = [];
  for (let i = 0; i < n; i += 1) grid.push(polylineAt(rawPts, cum, closed, i * step));

  // weights from protected zones (+ v2 override weight effects)
  const zones = protectedZones(routeData, rawLen, rawPts, cum, data, params);
  const floors = ov.weightFloors;
  const scales = ov.weightScales;
  const inSpan = (s, s0, s1) => {
    if (closed) {
      const t = ((s % rawLen) + rawLen) % rawLen;
      const a = ((s0 % rawLen) + rawLen) % rawLen;
      const b = ((s1 % rawLen) + rawLen) % rawLen;
      return a <= b ? (t >= a && t <= b) : (t >= a || t <= b);
    }
    return s >= s0 && s <= s1;
  };
  const weightAt = (s) => {
    let w = 1;
    for (const sc of scales) if (inSpan(s, sc.s0, sc.s1)) w *= sc.f;
    for (const fl of floors) if (inSpan(s, fl.s0, fl.s1)) w = Math.max(w, fl.w === null ? params.W_PROT : fl.w);
    for (const [s0, s1, wz] of zones) {
      if (inSpan(s, s0, s1)) w = Math.max(w, wz);
    }
    return w;
  };

  // solver arrays (with circular padding for closed routes)
  const pad = closed ? params.PAD : 0;
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
  return {
    id: routeData.id, routeData, rawPts, cum, rawLen, closed, skipped: false,
    n, step, grid, pad, N, gi, qx, qz, w, yAtStation, zones, params, overrideResult: ov,
  };
}

/** Solve/re-solve one route with deviation-cap reweighting. */
export function solveState(state, lambda = state.params.LAMBDA) {
  if (state.skipped) return;
  const { qx, qz, w, pad, N, rawPts, cum, closed, params } = state;
  const { CAP, W_PROT } = params;
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
export function clearanceGuard(states, params = DEFAULT_PARAMS) {
  const { W_PROT } = params;
  const LEVEL = 7;    // same-level threshold on deck height (m)
  const SLACK = 0.15; // allowed gap loss before pinning (m)
  const MARGIN = 1.4; // required plan clearance beyond the two half-widths
  const CELL = 24;
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
            const needed = routeHalfWidth(a.st.routeData) + routeHalfWidth(b.st.routeData) + MARGIN;
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

/**
 * Approximate runtime half-width from the data (map.js: lanes*laneWidth/2
 * + shoulder, one-way carriageways).
 */
export function routeHalfWidth(routeData) {
  const lanes = routeData.lanes || (routeData.kind === 'ramp' ? 1 : 2);
  const shoulder = routeData.kind === 'ramp' || routeData.kind === 'service' ? 0.95 : 2.5;
  return lanes * 3.5 * 0.5 + shoulder;
}

/** Final point list + stats for a solved state. */
export function finishRoute(state) {
  const { rawPts, cum, closed, params } = state;
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
  const { W_PROT, OUT_EVERY } = params;
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

/** Single-route pipeline (λ sweep + editor preview; no cross-route guard). */
export function fairRoute(routeData, ctx, lambda) {
  const state = prepareRoute(routeData, ctx);
  solveState(state, lambda ?? ctx.params?.LAMBDA ?? DEFAULT_PARAMS.LAMBDA);
  const r = finishRoute(state);
  r.overrideWarnings = state.overrideResult ? state.overrideResult.warnings : [];
  r.overrideApplied = state.overrideResult ? state.overrideResult.applied : 0;
  r.overrideSkipped = state.overrideResult ? state.overrideResult.skipped : 0;
  return r;
}

// ------------------------------------------------------------ full build
/**
 * Full network build — the exact pipeline of the CLI generator.
 * ctx: { overrides, params, log }
 * Returns { out, results, worstDev, guardRounds, routeLogs } where `out` is
 * the complete smoothed dataset (same shape as data/routes-smoothed.json,
 * WITHOUT meta.fairing which the caller stamps).
 */
export function buildSmoothedData(data, ctx = {}) {
  const params = ctx.params || DEFAULT_PARAMS;
  const log = ctx.log || null;
  const overrides = ctx.overrides || null;
  const fullCtx = { data, overrides, params, log };

  const out = JSON.parse(JSON.stringify(data));
  const states = data.routes.map((routeData) => prepareRoute(routeData, fullCtx));
  for (const state of states) solveState(state);
  const guardRounds = clearanceGuard(states, params);
  if (log) log(`clearance guard: ${guardRounds} repair round(s)`);
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

    if (!r.stats.skipped && log) {
      log(`  ${routeData.id.padEnd(14)} maxDev ${r.stats.maxDev.toFixed(2)} m  Δlen ${r.stats.lenDelta >= 0 ? '+' : ''}${r.stats.lenDelta.toFixed(1)} m  pts ${data.routes.find((x) => x.id === routeData.id).points.length} -> ${r.pts.length}`);
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

  return { out, results, worstDev, guardRounds };
}
