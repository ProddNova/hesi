/**
 * MERGE-GUARDRAIL PROBE — merge-local guardrail continuity, gating the
 * "merge-markings-guardrails-final" pass. Complements guardrail-probe.mjs
 * (network-wide gap/doubling/asphalt checks) and junction-finishing-probe's
 * rail-handoff check with the one thing neither measures directly: whether
 * a branch's own forced-on outer rail actually hands off to the host's
 * rail at the SAME station the host's own opening was built from, instead
 * of merely not-double-counting or not-leaving-an-explained-gap.
 *
 *  1. OUTER-RAIL CONVERGENCE CONTINUITY — for every merge/diverge zone
 *     with both a host rail opening and a branch outer rail, the branch's
 *     forced-on interval's tip must project onto the host route within a
 *     few metres of the host opening's own boundary. A mismatch here is
 *     exactly the "20-40 m unguarded gap" / "outer rail doesn't converge"
 *     failure mode: the two sides deriving their hand-off from different
 *     thresholds instead of one shared envelope.
 *  2. NO RAIL ACROSS THE MERGE OPENING — re-asserts guardrail-probe's
 *     check scoped to merge/diverge zones specifically (belt and braces
 *     for this pass, since it is the one explicitly called out by name).
 *  3. UNEXPLAINED GAP LENGTH — every gap between the branch's own rail
 *     runs inside its crossable span is either a zone-forced opening or
 *     genuinely off the barrier-conflict window; nothing is missing
 *     because of stale bookkeeping.
 *
 * Run: node .devtests/merge-guardrail-probe.mjs [--verbose]
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

const zones = map.junctionZones.filter((z) => z.crossable);
const summary = { convergenceChecked: 0, worstConvergence: 0, openingCrossed: 0, unexplainedGaps: 0 };

// The old chainage-only assertion produced a false positive once a progressive
// host rail remained visible through the former mouth opening: it could not
// distinguish an illegal rail on the stable host edge from the correct rail
// relocated to the widened carriageway exterior. Compare emitted parapet
// vertices with the shared envelope. A truly interior rail still mismatches
// both outer and base laterals and fails this invariant.
const progressiveRailFollowsExterior = (zone, from, to) => {
  const samples = (zone.host._progressiveRailSamples || []).filter((sample) => (
    sample.transitionId === zone.progressive.id
    && sample.side === zone.side
    && sample.distance >= from - 0.01
    && sample.distance <= to + 0.01));
  return samples.length > 0 && samples.every((sample) => {
    const envelope = zone.progressive.envelopeAt(sample.distance);
    const squeeze = 0.36 * (1 - sample.terminalFactor);
    const expectedBase = envelope.outerLateral - zone.side * (0.42 - squeeze);
    return Math.abs(sample.actualOuterLateral - envelope.outerLateral) < 0.03
      && Math.abs(sample.actualBaseLateral - expectedBase) < 0.03;
  });
};

// 1. outer-rail convergence continuity
for (const zone of zones) {
  if (zone.progressive) {
    summary.convergenceChecked += 1;
    const first = zone.progressive.guardrailEnvelope[0];
    const last = zone.progressive.guardrailEnvelope.at(-1);
    const firstFrame = map._frameAt(zone.host, first.hostS);
    const lastFrame = map._frameAt(zone.host, last.hostS);
    const firstBase = zone.side * map._halfWidthAt(zone.host, first.hostS);
    const lastBase = zone.side * map._halfWidthAt(zone.host, last.hostS);
    const difference = Math.max(Math.abs(first.lateral - firstBase), Math.abs(last.lateral - lastBase));
    summary.worstConvergence = Math.max(summary.worstConvergence, difference);
    if (difference > 0.05 || !firstFrame || !lastFrame) {
      fail('outer-rail-convergence', `${zone.id}: progressive envelope does not return to the stable host edge (${difference.toFixed(2)} m)`);
    }
    continue;
  }
  const pieces = zone.branchOuterRailOnPieces?.length ? zone.branchOuterRailOnPieces
    : (zone.branchOuterRailOn ? [zone.branchOuterRailOn] : null);
  if (!zone.hostRailOpen || !pieces) continue;
  summary.convergenceChecked += 1;
  const branch = zone.branch;
  const host = zone.host;
  // Every piece endpoint is a candidate hand-off; the one that actually
  // partners the host's opening is whichever projects CLOSEST to it (a
  // kinked route can carry a second, disjoint piece far from the mouth —
  // picking "the piece with the largest raw station" would grade that
  // unrelated piece instead of the real hand-off).
  let best = Infinity;
  let bestStation = null;
  let bestBound = null;
  for (const piece of pieces) {
    for (const end of piece) {
      const sample = map._sampleCenter(branch, map._normalizeDistance(branch, end), 1);
      const projection = map._projectToRoute(host, sample.position);
      for (const bound of zone.hostRailOpen) {
        const diff = Math.abs(projection.distance - bound);
        if (diff < best) { best = diff; bestStation = projection.distance; bestBound = bound; }
      }
    }
  }
  summary.worstConvergence = Math.max(summary.worstConvergence, best);
  if (best > 5) {
    fail('outer-rail-convergence', `${zone.kind} ${branch.id} on ${host.id}: nearest branch outer-rail piece endpoint projects to hS=${bestStation.toFixed(1)}, host opening bound=${bestBound.toFixed(1)} (${best.toFixed(1)} m apart)`);
  }
}

// 2. no rail across the merge opening (scoped re-assertion)
for (const zone of zones) {
  if (!zone.hostRailOpen) continue;
  const [lo, hi] = zone.hostRailOpen;
  const runs = zone.host._railRuns?.[zone.side] || [];
  for (const run of runs) {
    for (const [from, to] of map._zoneIntervalPieces(zone.host, [lo + 2, hi - 2])) {
      const overlap = Math.min(run.to, to) - Math.max(run.from, from);
      if (overlap > 4) {
        if (zone.progressive) {
          const overlapFrom = Math.max(run.from, from);
          const overlapTo = Math.min(run.to, to);
          if (progressiveRailFollowsExterior(zone, overlapFrom, overlapTo)) continue;
        }
        summary.openingCrossed += 1;
        fail('rail-across-merge-opening', `${zone.kind} ${zone.branch.id} on ${zone.host.id}: run ${run.from.toFixed(0)}..${run.to.toFixed(0)} crosses opening ${lo.toFixed(0)}..${hi.toFixed(0)} by ${overlap.toFixed(0)} m`);
      }
    }
  }
}

// 3. unexplained gap length along the branch's own crossable span
for (const zone of zones) {
  const branch = zone.branch;
  const side = -zone.hostwardSign;
  const runs = branch._railRuns?.[side] || [];
  const offZones = (branch._railZones?.[side] || []).filter((z) => z.mode === 'off');
  const inOffZone = (from, to) => offZones.some((z) => to > z.from - 1 && from < z.to + 1);
  const [bLo, bHi] = zone.crossable.branch;
  for (let i = 1; i < runs.length; i += 1) {
    const prev = runs[i - 1];
    const next = runs[i];
    if (next.from < bLo - 5 || prev.to > bHi + 5) continue; // outside this zone's span
    const gapLen = next.from - prev.to;
    if (gapLen <= 0.5) continue;
    if (inOffZone(prev.to, next.from)) continue;
    const frames = branch.surfaceFrames;
    const inside = [];
    for (let k = prev.toIndex + 1; k < next.fromIndex; k += 1) inside.push(k);
    const step = Math.max(1, Math.floor(inside.length / 6));
    let suppressedAll = true;
    for (let k = 0; k < inside.length; k += step) {
      const probe = map._deckPoint(frames[inside[k]], map._surfaceEdgeLateral(frames[inside[k]], side, 0.42), 0.02);
      if (!map._barrierSuppressed(probe, branch)) { suppressedAll = false; break; }
    }
    if (!suppressedAll) {
      summary.unexplainedGaps += 1;
      fail('unexplained-branch-gap', `${zone.kind} ${branch.id} on ${zone.host.id}: outer rail gap ${prev.to.toFixed(0)}..${next.from.toFixed(0)} (${gapLen.toFixed(0)} m) inside crossable span, not a zone opening`);
    }
  }
}

console.log(`\nzones with crossable=${zones.length} convergence-checked=${summary.convergenceChecked}`);
console.log(`worst convergence diff=${summary.worstConvergence.toFixed(2)} m | opening-crossed=${summary.openingCrossed} | unexplained-branch-gaps=${summary.unexplainedGaps}`);
if (failures) { console.log(`MERGE GUARDRAIL PROBE: FAIL (${failures})`); process.exit(1); }
console.log('MERGE GUARDRAIL PROBE: PASS');
