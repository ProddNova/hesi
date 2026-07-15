/**
 * Client-side geometry helpers (DOM-free, also importable from Node tests).
 *
 * NOTE: the fair preview geometry ALWAYS comes from the server (shared
 * fairing core). The only curve computed here is the centripetal
 * Catmull-Rom used to DISPLAY a point list exactly as the game runtime
 * renders it — it is not a smoothing approximation of the fairing.
 */

export const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

export function cumLengths(pts, closed) {
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + dist2(pts[i], pts[i - 1]));
  if (closed) cum.push(cum[cum.length - 1] + dist2(pts[0], pts[pts.length - 1]));
  return cum;
}

/** Sample [x,y,z] on a polyline at arc station s. */
export function polylineAt(pts, cum, closed, s) {
  const total = cum[cum.length - 1];
  const t = closed ? ((s % total) + total) % total : Math.max(0, Math.min(total, s));
  let lo = 0; let hi = cum.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= t) lo = mid; else hi = mid; }
  const a = pts[lo % pts.length];
  const b = pts[(lo + 1) % pts.length];
  const span = cum[lo + 1] - cum[lo] || 1;
  const f = (t - cum[lo]) / span;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Projection of (x,z) on a polyline: { d, s, y, x, z, seg }. */
export function projectToPolyline(x, z, pts, cum, closed, sLo = -Infinity, sHi = Infinity) {
  let best = { d: Infinity, s: 0, y: pts[0][1], x: pts[0][0], z: pts[0][2], seg: 0 };
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
    const d = Math.hypot(x - qx, z - qz);
    if (d < best.d) {
      best = { d, s: cum[i] + Math.sqrt(len2) * f, y: a[1] + (b[1] - a[1]) * f, x: qx, z: qz, seg: i };
    }
  }
  return best;
}

/**
 * Centripetal Catmull-Rom sampling (Barry–Goldman) — the exact curve the
 * game runtime draws through a route's point list. XZ only; y carried.
 * Returns samples as [x,y,z] roughly `step` metres apart.
 */
export function crSample(P, closed, step = 3) {
  const n = P.length;
  if (n < 2) return P.map((p) => [...p]);
  const out = [];
  const idx = (i) => (closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)));
  const spans = closed ? n : n - 1;
  for (let s = 0; s < spans; s += 1) {
    const p0 = P[idx(s - 1)]; const p1 = P[idx(s)]; const p2 = P[idx(s + 1)]; const p3 = P[idx(s + 2)];
    const t0 = 0;
    const t1 = t0 + Math.sqrt(dist2(p0, p1)) || t0 + 1e-3;
    const t2 = t1 + Math.sqrt(dist2(p1, p2)) || t1 + 1e-3;
    const t3 = t2 + Math.sqrt(dist2(p2, p3)) || t2 + 1e-3;
    const len = dist2(p1, p2);
    const steps = Math.max(2, Math.ceil(len / step));
    for (let k = 0; k < steps; k += 1) {
      const t = t1 + ((t2 - t1) * k) / steps;
      const lerp = (a, b, ta, tb) => {
        const f = tb - ta < 1e-9 ? 0 : (t - ta) / (tb - ta);
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
      };
      const A1 = lerp(p0, p1, t0, t1); const A2 = lerp(p1, p2, t1, t2); const A3 = lerp(p2, p3, t2, t3);
      const B1 = lerp(A1, A2, t0, t2); const B2 = lerp(A2, A3, t1, t3);
      out.push(lerp(B1, B2, t1, t2));
    }
  }
  out.push([...P[closed ? 0 : n - 1]]);
  return out;
}

/**
 * Signed Menger curvature at each sample (window ±k samples).
 * >0 curva a sinistra guardando +X/+Z dall'alto, <0 a destra.
 */
export function curvature(samples, k = 4) {
  const kap = new Array(samples.length).fill(0);
  for (let i = k; i < samples.length - k; i += 1) {
    const p0 = samples[i - k]; const p1 = samples[i]; const p2 = samples[i + k];
    const a = dist2(p0, p1); const b = dist2(p1, p2); const c = dist2(p0, p2);
    if (a < 1e-9 || b < 1e-9 || c < 1e-9) continue;
    const cross = (p1[0] - p0[0]) * (p2[2] - p1[2]) - (p1[2] - p0[2]) * (p2[0] - p1[0]);
    kap[i] = (2 * cross) / (a * b * c);
  }
  return kap;
}

/** Bounding box { x0, z0, x1, z1 } of a point list. */
export function bbox(pts) {
  let x0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let z1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[2] < z0) z0 = p[2];
    if (p[2] > z1) z1 = p[2];
  }
  return { x0, z0, x1, z1 };
}

/** Circumcircle of three XZ points → { cx, cz, r } or null (collinear). */
export function circumcircle(a, b, c) {
  const ax = a[0]; const az = a[2]; const bx = b[0]; const bz = b[2]; const cx = c[0]; const cz = c[2];
  const d = 2 * (ax * (bz - cz) + bx * (cz - az) + cx * (az - bz));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((ax * ax + az * az) * (bz - cz) + (bx * bx + bz * bz) * (cz - az) + (cx * cx + cz * cz) * (az - bz)) / d;
  const uz = ((ax * ax + az * az) * (cx - bx) + (bx * bx + bz * bz) * (ax - cx) + (cx * cx + cz * cz) * (bx - ax)) / d;
  return { cx: ux, cz: uz, r: Math.hypot(ax - ux, az - uz) };
}

/** Slice a polyline between stations [s0, s1] (open routes). */
export function slicePolyline(pts, cum, s0, s1) {
  const out = [];
  const a = Math.max(0, Math.min(s0, s1));
  const b = Math.min(cum[cum.length - 1], Math.max(s0, s1));
  out.push(polylineAt(pts, cum, false, a));
  for (let i = 0; i < pts.length; i += 1) {
    if (cum[i] > a && cum[i] < b) out.push([...pts[i]]);
  }
  out.push(polylineAt(pts, cum, false, b));
  return out;
}
