/**
 * Route edit analysis: quality metrics, warnings and hard errors for the
 * manual road editor. All user-facing messages are in Italian.
 *
 * Severities:
 *   'error'   — structurally unsafe, BLOCKS applying/saving the edit
 *               (self-intersection, new same-level crossing, protected-zone
 *               violation without explicit unlock, absurd deviation);
 *   'warning' — allowed but flagged (deviation above cap, tighter radius,
 *               extra oscillation, clearance loss, length change…).
 *
 * The processed geometry analysed here is ALWAYS produced by the shared
 * fairing core (tools/road-editor/lib/fairing.mjs) — the same code that
 * generates data/routes-smoothed.json.
 */
import { curveQuality } from '../../fairing-metrics.mjs';
import {
  fairRoute, cumLengths, projectToPolyline, protectedZones, routeHalfWidth,
  overrideOpsFor, resolveAnchor, hyp, DEFAULT_PARAMS,
} from './fairing.mjs';

export const THRESHOLDS = Object.freeze({
  DEV_WARN: 1.8,          // deviation from raw OSM (m) — warning
  DEV_ERROR: 8,           // deviation from raw OSM (m) — hard error
  RADIUS_WARN: 30,        // absolute tight radius (m)
  RADIUS_REL: 0.8,        // edited min radius < base * REL → warning
  JERK_REL: 1.6,          // curvature-change worsening factor → warning
  FLIPS_REL: 1.35,        // oscillation worsening factor → warning
  FLIPS_ABS: 0.75,        // + absolute flips/km guard band
  CLEAR_LOSS: 0.2,        // same-level clearance loss (m) → warning
  LEVEL: 7,               // same-level Δy threshold (m) — mirrors the guard
  CROSS_LEVEL: 5.5,       // Δy below this at a plan crossing → same level
  LEN_WARN: 5,            // |Δ length| (m) → warning
  TANGENT_WARN_DEG: 2.5,  // endpoint tangent deviation → warning
  ANCHOR_NEAR: 60,        // op anchored within this of a zone edge → warning
});

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

// ------------------------------------------------------------ geometry bits
function segIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    const t = d1 / (d1 - d2 || 1e-12);
    return { x: cx + (dx - cx) * t, z: cz + (dz - cz) * t };
  }
  return null;
}

/** Self-intersection scan on an XZ polyline (skips adjacent segments). */
export function selfIntersections(pts, closed) {
  const segs = closed ? pts.length : pts.length - 1;
  const hits = [];
  const cum = cumLengths(pts, closed);
  for (let i = 0; i < segs; i += 1) {
    const a = pts[i]; const b = pts[(i + 1) % pts.length];
    for (let j = i + 2; j < segs; j += 1) {
      if (closed && i === 0 && j === segs - 1) continue; // wrap-adjacent
      const c = pts[j]; const d = pts[(j + 1) % pts.length];
      const hit = segIntersect(a[0], a[2], b[0], b[2], c[0], c[2], d[0], d[2]);
      if (hit) hits.push({ x: hit.x, z: hit.z, s: cum[i] });
      if (hits.length > 8) return hits;
    }
  }
  return hits;
}

/**
 * Plan crossings between polyline A and polyline B where the deck heights
 * are close (same level). Returns [{x, z, sA, dy}].
 */
function sameLevelCrossings(A, closedA, B, closedB, level = THRESHOLDS.CROSS_LEVEL) {
  const cumA = cumLengths(A, closedA);
  const segsA = closedA ? A.length : A.length - 1;
  const segsB = closedB ? B.length : B.length - 1;
  // coarse spatial hash of B segments
  const CELL = 64;
  const hash = new Map();
  for (let j = 0; j < segsB; j += 1) {
    const c = B[j]; const d = B[(j + 1) % B.length];
    const x0 = Math.floor(Math.min(c[0], d[0]) / CELL); const x1 = Math.floor(Math.max(c[0], d[0]) / CELL);
    const z0 = Math.floor(Math.min(c[2], d[2]) / CELL); const z1 = Math.floor(Math.max(c[2], d[2]) / CELL);
    for (let gx = x0; gx <= x1; gx += 1) {
      for (let gz = z0; gz <= z1; gz += 1) {
        const key = `${gx},${gz}`;
        if (!hash.has(key)) hash.set(key, []);
        hash.get(key).push(j);
      }
    }
  }
  const hits = [];
  for (let i = 0; i < segsA; i += 1) {
    const a = A[i]; const b = A[(i + 1) % A.length];
    const x0 = Math.floor(Math.min(a[0], b[0]) / CELL); const x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
    const z0 = Math.floor(Math.min(a[2], b[2]) / CELL); const z1 = Math.floor(Math.max(a[2], b[2]) / CELL);
    const cand = new Set();
    for (let gx = x0; gx <= x1; gx += 1) {
      for (let gz = z0; gz <= z1; gz += 1) {
        const bucket = hash.get(`${gx},${gz}`);
        if (bucket) for (const j of bucket) cand.add(j);
      }
    }
    for (const j of cand) {
      const c = B[j]; const d = B[(j + 1) % B.length];
      const hit = segIntersect(a[0], a[2], b[0], b[2], c[0], c[2], d[0], d[2]);
      if (!hit) continue;
      const ya = (a[1] + b[1]) / 2; const yb = (c[1] + d[1]) / 2;
      const dy = Math.abs(ya - yb);
      if (dy < level) hits.push({ x: hit.x, z: hit.z, sA: cumA[i], dy });
      if (hits.length > 16) return hits;
    }
  }
  return hits;
}

/** Crossing signature for old/new comparison (rounded position). */
const crossKey = (h) => `${Math.round(h.x / 8)},${Math.round(h.z / 8)}`;

/**
 * Minimum same-level clearance between polyline A points and polyline B
 * points, sampled at B's vertices vs A's segments. Cheap but effective for
 * parallel-carriageway pinch detection.
 */
function minClearance(A, closedA, B, needed) {
  const cumA = cumLengths(A, closedA);
  let worst = { gap: Infinity, x: 0, z: 0 };
  for (let j = 0; j < B.length; j += 1) {
    const p = B[j];
    const prj = projectToPolyline(p[0], p[2], A, cumA, closedA);
    if (prj.d < needed + 8 && Math.abs(prj.y - p[1]) <= THRESHOLDS.LEVEL && prj.d < worst.gap) {
      worst = { gap: prj.d, x: p[0], z: p[2] };
    }
  }
  return worst;
}

// -------------------------------------------------------------- base quality
/**
 * Network-wide base quality snapshot (no overrides): per-route curvature
 * metrics of the CURRENT processed centrelines, used by the sidebar to help
 * the user find bad curves. → { [routeId]: {flipsPerKm, jerk, maxKappa,
 * minRadius, findings: n} }
 */
export function baseQualitySnapshot(smoothedData) {
  const out = {};
  for (const r of smoothedData.routes) {
    if (r.points.length < 8) { out[r.id] = { flipsPerKm: 0, jerk: 0, maxKappa: 0, minRadius: Infinity, hints: 0 }; continue; }
    const q = curveQuality(r.points, !!r.closed);
    const minRadius = q.maxKappa > 1e-9 ? 1 / q.maxKappa : Infinity;
    let hints = 0;
    if (q.flipsPerKm > 6) hints += 1;
    if (minRadius < 35 && r.kind !== 'ramp') hints += 1;
    if (q.jerk > 3e-4) hints += 1;
    out[r.id] = {
      flipsPerKm: q.flipsPerKm, jerk: q.jerk, maxKappa: q.maxKappa,
      minRadius: Number.isFinite(minRadius) ? minRadius : 1e9, hints,
    };
  }
  return out;
}

// ---------------------------------------------------------------- main entry
/**
 * Analyse one route with the given overrides document applied.
 *
 * @param {object} args
 * @param {object} args.data          raw dataset (data/routes.json)
 * @param {object} args.smoothedData  current processed dataset
 * @param {string} args.routeId
 * @param {object|null} args.overrides   full overrides doc (v1 or v2)
 * @param {object} [args.params]
 * @param {boolean} [args.light]      skip cross-route scans (drag preview)
 */
// Baseline (no-override) previews are override-independent — cache per run.
const baseCache = new WeakMap(); // data → Map(routeId → pts)
function basePreviewPts(data, routeData, params) {
  let m = baseCache.get(data);
  if (!m) { m = new Map(); baseCache.set(data, m); }
  if (!m.has(routeData.id)) {
    m.set(routeData.id, fairRoute(routeData, { data, overrides: null, params }).pts);
  }
  return m.get(routeData.id);
}

export function analyzeRouteEdit({ data, smoothedData, routeId, overrides, params = DEFAULT_PARAMS, light = false }) {
  const routeData = data.routes.find((r) => r.id === routeId);
  if (!routeData) return { ok: false, error: `percorso sconosciuto '${routeId}'` };
  const smoothed = smoothedData.routes.find((r) => r.id === routeId);
  const findings = [];

  const edited = fairRoute(routeData, { data, overrides, params });
  const editedPts = edited.pts;
  // Comparison baseline: the SAME single-route fairing without overrides —
  // not the committed network output (whose clearance-guard pins would show
  // up as spurious differences unrelated to the user's edit).
  const basePts = basePreviewPts(data, routeData, params);
  const closed = !!routeData.closed;

  // NaN guard — anything non-finite is a hard error
  for (const p of editedPts) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) {
      findings.push({ severity: 'error', code: 'nan', message: 'La geometria calcolata contiene valori non validi (NaN): modifica troppo estrema.' });
      break;
    }
  }

  // deviation from the pristine raw OSM polyline
  const rawPts = routeData.points;
  const rawCum = cumLengths(rawPts, closed);
  let dev = { max: 0, s: 0, x: 0, z: 0 };
  const editedCum = cumLengths(editedPts, closed);
  for (let i = 0; i < editedPts.length; i += 1) {
    const p = editedPts[i];
    const prj = projectToPolyline(p[0], p[2], rawPts, rawCum, closed);
    if (prj.d > dev.max) dev = { max: prj.d, s: editedCum[i], x: p[0], z: p[2] };
  }
  if (dev.max > THRESHOLDS.DEV_ERROR) {
    findings.push({
      severity: 'error', code: 'deviation', station: dev.s, x: dev.x, z: dev.z,
      message: `Deviazione dall'OSM di ${fmt(dev.max)} m (limite assoluto ${THRESHOLDS.DEV_ERROR} m): la strada non corrisponde più al tracciato reale.`,
    });
  } else if (dev.max > THRESHOLDS.DEV_WARN) {
    findings.push({
      severity: 'warning', code: 'deviation', station: dev.s, x: dev.x, z: dev.z,
      message: `Deviazione dall'OSM di ${fmt(dev.max)} m (soglia ${THRESHOLDS.DEV_WARN} m). Verifica che la curva resti fedele alla strada reale.`,
    });
  }

  // curvature quality old vs new
  const editedQ = editedPts.length >= 8 ? curveQuality(editedPts, closed) : null;
  const baseQ = basePts.length >= 8 ? curveQuality(basePts, closed) : null;
  if (editedQ && baseQ) {
    const rEd = editedQ.maxKappa > 1e-9 ? 1 / editedQ.maxKappa : Infinity;
    const rBase = baseQ.maxKappa > 1e-9 ? 1 / baseQ.maxKappa : Infinity;
    if (rEd < THRESHOLDS.RADIUS_WARN && rEd < rBase * THRESHOLDS.RADIUS_REL) {
      findings.push({
        severity: 'warning', code: 'radius',
        message: `Raggio minimo ridotto a ${fmt(rEd, 0)} m (prima ${fmt(rBase, 0)} m): curva molto stretta.`,
      });
    }
    if (editedQ.jerk > baseQ.jerk * THRESHOLDS.JERK_REL && editedQ.jerk > 1e-4) {
      findings.push({
        severity: 'warning', code: 'jerk',
        message: 'Variazione di curvatura brusca: la transizione della curva è meno fluida di prima.',
      });
    }
    if (editedQ.flipsPerKm > baseQ.flipsPerKm * THRESHOLDS.FLIPS_REL + THRESHOLDS.FLIPS_ABS) {
      findings.push({
        severity: 'warning', code: 'oscillation',
        message: `Oscillazioni sinistra/destra aumentate (${fmt(editedQ.flipsPerKm)} vs ${fmt(baseQ.flipsPerKm)} inversioni/km).`,
      });
    }
  }

  // self-intersection — hard error
  const selfHits = selfIntersections(editedPts, closed);
  for (const h of selfHits.slice(0, 3)) {
    findings.push({
      severity: 'error', code: 'self-intersection', station: h.s, x: h.x, z: h.z,
      message: 'La strada si interseca con sé stessa: correggi le maniglie.',
    });
  }

  // protected zones: ops anchored inside are errors unless explicitly unlocked
  const ops = overrideOpsFor(overrides, routeId) || [];
  const zones = protectedZones(routeData, rawCum[rawCum.length - 1], rawPts, rawCum, data, params);
  const zoneInfo = describeZones(routeData, data);
  for (const op of ops) {
    if (!op.anchor || op.enabled === false) continue;
    const res = resolveAnchor(op.anchor, rawPts, rawCum, closed);
    if (!res.ok) {
      findings.push({
        severity: 'warning', code: 'anchor-lost', opId: op.id,
        message: `Una modifica non trova più il suo aggancio sul percorso (${res.reason}) ed è stata ignorata.`,
      });
      continue;
    }
    const zone = zoneAt(zones, res.s, rawCum[rawCum.length - 1], closed);
    if (zone) {
      const why = zoneInfo.describe(res.s);
      if (op.unlockProtected === true) {
        findings.push({
          severity: 'warning', code: 'protected-unlocked', opId: op.id, station: res.s,
          message: `Modifica in ZONA PROTETTA (${why}) con sblocco esplicito: massima attenzione, la geometria è vincolante per gli svincoli.`,
        });
      } else {
        findings.push({
          severity: 'error', code: 'protected', opId: op.id, station: res.s,
          message: `Modifica in zona protetta: ${why}. Sposta la maniglia fuori dalla zona o usa lo sblocco avanzato.`,
        });
      }
    } else {
      const near = nearZoneEdge(zones, res.s, THRESHOLDS.ANCHOR_NEAR, rawCum[rawCum.length - 1], closed);
      if (near) {
        findings.push({
          severity: 'warning', code: 'near-protected', opId: op.id, station: res.s,
          message: `Maniglia a ${fmt(near, 0)} m da una zona protetta: l'effetto potrebbe essere attenuato dal vincolo.`,
        });
      }
    }
  }

  // endpoint tangent
  if (!closed && editedPts.length > 2 && rawPts.length > 2) {
    const ang = (a, b) => Math.atan2(b[2] - a[2], b[0] - a[0]);
    const dStart = Math.abs(normDeg((ang(editedPts[0], editedPts[1]) - ang(rawPts[0], rawPts[1])) * 180 / Math.PI));
    const dEnd = Math.abs(normDeg((ang(editedPts[editedPts.length - 2], editedPts[editedPts.length - 1]) - ang(rawPts[rawPts.length - 2], rawPts[rawPts.length - 1])) * 180 / Math.PI));
    if (dStart > THRESHOLDS.TANGENT_WARN_DEG || dEnd > THRESHOLDS.TANGENT_WARN_DEG) {
      findings.push({
        severity: 'warning', code: 'endpoint-tangent',
        message: `Direzione all'estremo cambiata di ${fmt(Math.max(dStart, dEnd))}°: il raccordo con lo svincolo potrebbe piegarsi.`,
      });
    }
  }

  // length change
  const newLen = editedCum[editedCum.length - 1];
  const baseLen = smoothed ? smoothed.length : newLen;
  if (Math.abs(newLen - baseLen) > THRESHOLDS.LEN_WARN) {
    findings.push({
      severity: 'warning', code: 'length',
      message: `Lunghezza del percorso cambiata di ${fmt(newLen - baseLen)} m: le distanze delle connessioni verranno rimappate in rigenerazione.`,
    });
  }

  // cross-route scans (skippable while dragging)
  if (!light) {
    let bb = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
    for (const p of editedPts.concat(basePts)) {
      bb = { x0: Math.min(bb.x0, p[0]), x1: Math.max(bb.x1, p[0]), z0: Math.min(bb.z0, p[2]), z1: Math.max(bb.z1, p[2]) };
    }
    const PADB = 40;
    const overlaps = (r) => r.points.some((p) => p[0] > bb.x0 - PADB && p[0] < bb.x1 + PADB && p[2] > bb.z0 - PADB && p[2] < bb.z1 + PADB);
    const others = smoothedData.routes.filter((r) => r.id !== routeId && r.points.length > 2 && overlaps(r));
    const baseCross = new Set();
    for (const o of others) {
      for (const h of sameLevelCrossings(basePts, closed, o.points, !!o.closed)) baseCross.add(`${o.id}:${crossKey(h)}`);
    }
    for (const o of others) {
      const hits = sameLevelCrossings(editedPts, closed, o.points, !!o.closed);
      for (const h of hits) {
        if (baseCross.has(`${o.id}:${crossKey(h)}`)) continue; // pre-existing (junction throat)
        findings.push({
          severity: 'error', code: 'crossing', station: h.sA, x: h.x, z: h.z,
          message: `La strada attraversa ${o.name || o.id} allo stesso livello (Δh ${fmt(h.dy)} m).`,
        });
      }
      // clearance pinch on near-parallel carriageways
      const needed = routeHalfWidth(routeData) + routeHalfWidth(o) + 1.4;
      const before = minClearance(basePts, closed, o.points, needed);
      const after = minClearance(editedPts, closed, o.points, needed);
      if (after.gap < needed && after.gap < before.gap - THRESHOLDS.CLEAR_LOSS) {
        findings.push({
          severity: 'warning', code: 'clearance', x: after.x, z: after.z,
          message: `Distanza da ${o.name || o.id} ridotta a ${fmt(after.gap)} m (prima ${fmt(before.gap)} m, richiesti ${fmt(needed)} m): le carreggiate rischiano di toccarsi.`,
        });
      }
    }
  }

  return {
    ok: true,
    routeId,
    pts: editedPts,
    stats: {
      maxDev: edited.stats.maxDev,
      devFromRaw: dev,
      lenDelta: newLen - baseLen,
      length: newLen,
      skippedFairing: !!edited.stats.skipped,
      base: baseQ ? { flipsPerKm: baseQ.flipsPerKm, jerk: baseQ.jerk, maxKappa: baseQ.maxKappa } : null,
      edited: editedQ ? { flipsPerKm: editedQ.flipsPerKm, jerk: editedQ.jerk, maxKappa: editedQ.maxKappa } : null,
    },
    findings,
    hasErrors: findings.some((f) => f.severity === 'error'),
    overrideWarnings: edited.overrideWarnings || [],
  };
}

function normDeg(d) {
  let a = d % 360;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return a;
}

function zoneAt(zones, s, total, closed) {
  for (const [s0, s1] of zones) {
    if (closed) {
      const t = ((s % total) + total) % total;
      const a = ((s0 % total) + total) % total;
      const b = ((s1 % total) + total) % total;
      if (a <= b ? (t >= a && t <= b) : (t >= a || t <= b)) return [s0, s1];
    } else if (s >= s0 && s <= s1) return [s0, s1];
  }
  return null;
}

function nearZoneEdge(zones, s, within, total, closed) {
  let best = null;
  for (const [s0, s1] of zones) {
    for (const edge of [s0, s1]) {
      let d = Math.abs(s - edge);
      if (closed) d = Math.min(d, total - d);
      if (d <= within && (best === null || d < best)) best = d;
    }
  }
  return best;
}

/**
 * Human explanations for why stretches of a route are protected.
 * Returns { spans: [{s0, s1, why}], describe(s) }.
 */
export function describeZones(routeData, data, params = DEFAULT_PARAMS) {
  const spans = [];
  const { END_SPAN, PROT_SPAN } = params;
  const len = routeData.length;
  if (!routeData.closed) {
    spans.push({ s0: 0, s1: END_SPAN, why: 'estremità del percorso (posizione e direzione ancorate allo svincolo)' });
    spans.push({ s0: len - END_SPAN, s1: len, why: 'estremità del percorso (posizione e direzione ancorate allo svincolo)' });
  }
  for (const edge of data.edges || []) {
    if (edge.from.route === routeData.id) {
      spans.push({ s0: edge.from.distance - PROT_SPAN, s1: edge.from.distance + PROT_SPAN, why: `connessione ${edge.kind} verso ${edge.to.route}` });
    }
    if (edge.to.route === routeData.id) {
      spans.push({ s0: edge.to.distance - PROT_SPAN, s1: edge.to.distance + PROT_SPAN, why: `connessione ${edge.kind} da ${edge.from.route}` });
    }
  }
  if (!routeData.closed) {
    const endDrop = Math.abs(routeData.points[0][1] - routeData.points[routeData.points.length - 1][1]);
    const steep = endDrop > routeData.length * 0.05;
    const anchorSpan = steep ? 30 : Math.min(95, Math.max(30, routeData.length * 0.22));
    const blend = anchorSpan * 2 + 30;
    for (const edge of data.edges || []) {
      if (edge.kind === 'diverge' && edge.to.route === routeData.id && edge.to.distance < 50) {
        spans.push({ s0: 0, s1: blend, why: 'zona di ancoraggio della rampa in uscita (gore): il runtime fonde qui la geometria con la carreggiata principale' });
      }
      if (edge.kind === 'merge' && edge.from.route === routeData.id && edge.from.distance > routeData.length - 50) {
        spans.push({ s0: len - blend, s1: len, why: 'zona di ancoraggio della rampa in ingresso (gore): il runtime fonde qui la geometria con la carreggiata principale' });
      }
    }
  }
  for (const sa of data.serviceAreas || []) {
    if (sa.routeId === routeData.id) {
      const half = (sa.length || 220) * 0.5 + 120;
      spans.push({ s0: sa.distance - half, s1: sa.distance + half, why: `area di servizio ${sa.name}: il runtime costruisce parcheggio e corsie di accesso da questa geometria` });
    }
    if (sa.grounded) {
      const cum = cumLengths(routeData.points, !!routeData.closed);
      for (let k = 0; k < routeData.points.length; k += 1) {
        if (hyp(routeData.points[k][0] - sa.x, routeData.points[k][2] - sa.z) < 700) {
          spans.push({ s0: cum[k] - 40, s1: cum[k] + 40, why: `pila di ${sa.name} (Daikoku): geometria vincolante per le spirali di accesso` });
        }
      }
    }
  }
  return {
    spans,
    describe(s) {
      for (const z of spans) if (s >= z.s0 && s <= z.s1) return z.why;
      return 'zona protetta';
    },
  };
}
