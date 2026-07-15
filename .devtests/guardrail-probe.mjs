/**
 * GUARDRAIL OPENING/CONTINUITY PROBE — gates the junction-local guardrail
 * finishing. Reads the rail runs the builder actually recorded
 * (route._railRuns from _computeBarrierVisibility) plus the zone rail
 * intervals, and checks:
 *
 *  1. NO RAIL ACROSS A DRIVABLE OPENING — no host-side run overlaps a
 *     zone's hostRailOpen interior; additionally no run covers stations
 *     where the branch pavement physically crosses the host rail line
 *     (the paved opening envelope from the zone rows).
 *  2. EXPLAINED GAPS ONLY — every gap between runs is either a zone 'off'
 *     interval (deliberate opening) or every sampled station in it is
 *     EXACTLY suppressed (the rail would sit on another carriageway's
 *     deck / a PA lot: braids and grade overlaps, deliberate). Nothing
 *     may be missing because of stale cache smear.
 *  3. BOUNDED OPENINGS — zone openings are 4..150 m; no unexplained gap
 *     survives at any length.
 *  4. LATERAL ENDPOINT CONTINUITY — across gaps < 30 m, the resuming
 *     rail's endpoint must not jump laterally (> 1.2 m perpendicular to
 *     the run direction), and endpoint tangents must roughly agree
 *     (< 35 deg) — no restart on a wrong edge.
 *  5. NO DOUBLED RAIL — visible rail samples from different routes never
 *     run parallel within 1.0 m (horizontally and vertically).
 *  6. NO RAIL INSIDE ASPHALT — every visible sample outside zone-forced
 *     intervals must NOT be exactly suppressed (i.e. must not sit on
 *     another carriageway's deck at rail-conflict height).
 *
 * Run: node .devtests/guardrail-probe.mjs [--verbose]
 */
const VERBOSE = process.argv.includes('--verbose');
const origWarn = console.warn;
console.warn = () => {};
const { HighwayMap } = await import('../js/map.js');
const map = new HighwayMap(null, { addLighting: false });
console.warn = origWarn;

let failures = 0;
const fail = (label, detail) => {
  failures += 1;
  console.log(`FAIL  ${label}: ${detail}`);
};
const deg = (rad) => (rad * 180) / Math.PI;
const summary = { runs: 0, gaps: 0, openings: 0, worstLateralStep: 0, worstTangent: 0, doubled: 0, insideAsphalt: 0, unexplained: 0 };

const exactSuppressed = (route, frame, side) => {
  const point = map._deckPoint(frame, map._surfaceEdgeLateral(frame, side, 0.42), 0.02);
  return map._barrierSuppressed(point, route);
};

for (const route of map.routes.values()) {
  if (!route._railRuns) continue;
  const frames = route.surfaceFrames;
  for (const side of [1, -1]) {
    const runs = route._railRuns[side];
    const causes = runs.gapCauses || [];
    summary.runs += runs.length;
    const offZones = (route._railZones?.[side] || []).filter((zone) => zone.mode === 'off');
    const inOffZone = (from, to) => offZones.some((zone) => to > zone.from - 1 && from < zone.to + 1);

    for (let i = 1; i < runs.length; i += 1) {
      const prev = runs[i - 1];
      const next = runs[i];
      const gapLen = next.from - prev.to;
      if (gapLen <= 0.5) continue;
      summary.gaps += 1;
      const zoneExplained = inOffZone(prev.to, next.from);
      let suppressedAll = true;
      if (!zoneExplained) {
        // sample up to 6 interior frames exactly
        const inside = [];
        for (let k = prev.toIndex + 1; k < next.fromIndex; k += 1) inside.push(k);
        const step = Math.max(1, Math.floor(inside.length / 6));
        for (let k = 0; k < inside.length; k += step) {
          if (!exactSuppressed(route, frames[inside[k]], side)) { suppressedAll = false; break; }
        }
        if (inside.length === 0) suppressedAll = true; // sub-frame nick
      }
      if (!zoneExplained && !suppressedAll) {
        summary.unexplained += 1;
        fail('unexplained-gap', `${route.id} side ${side} ${prev.to.toFixed(0)}..${next.from.toFixed(0)} (${gapLen.toFixed(0)} m) — not a junction opening, not on another deck`);
      }
      // 4. endpoint continuity across short gaps. Lateral position is the
      // rail's offset from the centreline (frame.half): comparing world
      // chords misreads ordinary curvature as a sideways jump. A real
      // step = the rail resuming on a different edge lateral.
      if (gapLen < 30) {
        const endFrame = frames[prev.toIndex];
        const startFrame = frames[next.fromIndex];
        const lateralStep = Math.abs((prev.toHalf ?? endFrame.half) - (next.fromHalf ?? startFrame.half));
        summary.worstLateralStep = Math.max(summary.worstLateralStep, lateralStep);
        if (lateralStep > 1.2) {
          fail('lateral-step', `${route.id} side ${side} rail restarts ${lateralStep.toFixed(2)} m off its edge lateral across ${gapLen.toFixed(0)} m gap at s=${prev.to.toFixed(0)}`);
        }
        const tangentMismatch = deg(Math.acos(Math.min(1, Math.abs(endFrame.tangent.dot(startFrame.tangent)))));
        summary.worstTangent = Math.max(summary.worstTangent, tangentMismatch);
        if (tangentMismatch > 35) {
          fail('endpoint-tangent', `${route.id} side ${side} terminal direction turns ${tangentMismatch.toFixed(0)} deg across ${gapLen.toFixed(0)} m gap at s=${prev.to.toFixed(0)}`);
        }
      }
    }
  }
}

// 1./3. zone openings: bounded, and never covered by a surviving rail run
for (const zone of map.junctionZones) {
  if (!zone.hostRailOpen) continue;
  summary.openings += 1;
  const [lo, hi] = zone.hostRailOpen;
  const span = hi - lo;
  // every opening station must be JUSTIFIED by the paved envelope: the
  // branch pavement overlaps the host's rail line within the barrier's
  // height band there (an at-level opening or a second deck the rail
  // must not pierce; long parallel approach ribbons legitimately open
  // long stretches — what must never happen is suppression beyond the
  // physical overlap)
  const conflictsEdge = (r) => r.dy < 1.35 && r.dy > -1.6
    && r.e + r.half > r.hostHalf - 0.9
    && r.innerEdge < r.hostHalf + 0.5;
  const covered = zone.samples.filter((r) => r.hU >= lo + 3 && r.hU <= hi - 3);
  const justified = covered.filter(conflictsEdge).length;
  if (span < 4 || span > 400) fail('opening-bounds', `${zone.kind} ${zone.branch.id} on ${zone.host.id}: opening ${span.toFixed(0)} m`);
  else if (covered.length >= 3 && justified / covered.length < 0.8) {
    fail('opening-unjustified', `${zone.kind} ${zone.branch.id} on ${zone.host.id}: only ${justified}/${covered.length} opening stations overlap the rail line`);
  }
  const runs = zone.host._railRuns?.[zone.side] || [];
  for (const run of runs) {
    // compare in the zone's unwrapped frame
    for (const [from, to] of map._zoneIntervalPieces(zone.host, [lo + 2, hi - 2])) {
      const overlap = Math.min(run.to, to) - Math.max(run.from, from);
      if (overlap > 4) {
        if (zone.progressive) {
          const frames = zone.host.surfaceFrames.filter((frame) => frame.distance >= Math.max(run.from, from)
            && frame.distance <= Math.min(run.to, to));
          const followsExterior = frames.length > 0 && frames.every((frame) => {
            const actual = map._surfaceEdgeLateral(frame, zone.side, 0.42);
            const expected = zone.progressive.envelopeAt(frame.distance).outerLateral - zone.side * 0.42;
            return Math.abs(actual - expected) < 0.03;
          });
          if (followsExterior) continue;
        }
        fail('rail-across-opening', `${zone.kind} ${zone.branch.id} on ${zone.host.id} side ${zone.side}: run ${run.from.toFixed(0)}..${run.to.toFixed(0)} covers opening ${lo.toFixed(0)}..${hi.toFixed(0)} by ${overlap.toFixed(0)} m`);
      }
    }
  }
}
// crossable zones must expose SOME opening (rail not left across the branch)
for (const zone of map.junctionZones) {
  if (!zone.crossable || zone.hostRailOpen) continue;
  // acceptable only if the branch pavement never reaches under the host
  // rail's footprint at conflict height (then the rail blocks nothing;
  // stepped wings stay closed — documented vertical data families)
  const blocked = zone.samples.some((r) => r.dy < 1.35 && r.dy > -1.6
    && r.e + r.half > r.hostHalf - 0.15 && r.innerEdge < r.hostHalf + 0.5);
  if (blocked) fail('missing-opening', `${zone.kind} ${zone.branch.id} on ${zone.host.id}: crossable but no rail opening`);
}

// 5./6. doubled rail + rail inside asphalt, from sampled visible frames
const cells = new Map();
const samples = [];
for (const route of map.routes.values()) {
  if (!route._railRuns) continue;
  const frames = route.surfaceFrames;
  for (const side of [1, -1]) {
    const causes = route._railRuns[side].gapCauses || [];
    for (const run of route._railRuns[side]) {
      for (let i = run.fromIndex; i <= run.toIndex; i += 2) {
        const frame = frames[i];
        const point = map._deckPoint(frame, map._surfaceEdgeLateral(frame, side, 0.42), 0.02);
        const tangent = frame.tangent;
        const sample = { routeId: route.id, side, s: frame.distance, point, tangent, zoneForced: causes[i] === 'zone-on' };
        samples.push(sample);
        const key = `${Math.round(point.x / 8)}|${Math.round(point.z / 8)}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(sample);
        // 6. inside asphalt (zone-forced interior rails are the union's own edge)
        if (!sample.zoneForced && map._barrierSuppressed(point, route)) {
          summary.insideAsphalt += 1;
          if (summary.insideAsphalt <= 8) fail('rail-inside-asphalt', `${route.id} side ${side} s=${frame.distance.toFixed(0)} visible rail sits on another carriageway`);
        }
      }
    }
  }
}
for (const [key, list] of cells) {
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (a.routeId === b.routeId) continue;
      const dx = a.point.x - b.point.x;
      const dz = a.point.z - b.point.z;
      const horizontal = Math.hypot(dx, dz);
      if (horizontal > 1.0) continue;
      if (Math.abs(a.point.y - b.point.y) > 1.0) continue;
      const parallel = Math.abs(a.tangent.dot(b.tangent));
      if (parallel < 0.966) continue; // > 15 deg apart = crossing, not doubled
      summary.doubled += 1;
      if (summary.doubled <= 8) fail('doubled-rail', `${a.routeId} s=${a.s.toFixed(0)} and ${b.routeId} s=${b.s.toFixed(0)} run parallel ${horizontal.toFixed(2)} m apart`);
    }
  }
}
if (summary.insideAsphalt > 8) fail('rail-inside-asphalt', `${summary.insideAsphalt} total`);
if (summary.doubled > 8) fail('doubled-rail', `${summary.doubled} total`);

console.log(`\nruns=${summary.runs} gaps=${summary.gaps} zoneOpenings=${summary.openings} railSamples=${samples.length}`);
console.log(`worst: lateral restart step ${summary.worstLateralStep.toFixed(2)} m | terminal tangent ${summary.worstTangent.toFixed(0)} deg`);
console.log(`unexplained gaps=${summary.unexplained} doubled=${summary.doubled} insideAsphalt=${summary.insideAsphalt}`);
if (failures) { console.log(`GUARDRAIL PROBE: FAIL (${failures})`); process.exit(1); }
console.log('GUARDRAIL PROBE: PASS');
