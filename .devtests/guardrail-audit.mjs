/**
 * Exploratory audit of guardrail runs/gaps (route._railRuns recorded by
 * _computeBarrierVisibility). Lists, per route side, every gap between
 * rail runs with its length, cause and junction-zone context, plus
 * lateral half-width steps across gaps. Diagnostic only — the gating
 * checks live in .devtests/guardrail-probe.mjs.
 *
 * Run: node .devtests/guardrail-audit.mjs [--all]
 */
const ALL = process.argv.includes('--all');
const origWarn = console.warn;
console.warn = () => {};
const { HighwayMap } = await import('../js/map.js');
const map = new HighwayMap(null, { addLighting: false });
console.warn = origWarn;

const stats = { gaps: 0, zoneGaps: 0, probeGaps: 0, shortProbeGaps: [], lateralSteps: [], railAcross: 0 };

for (const route of map.routes.values()) {
  if (!route._railRuns) continue;
  for (const side of [1, -1]) {
    const runs = route._railRuns[side];
    for (let i = 1; i < runs.length; i += 1) {
      const prev = runs[i - 1];
      const next = runs[i];
      const gapLen = next.from - prev.to;
      if (gapLen <= 0.5) continue;
      stats.gaps += 1;
      // zone context: any zone interval overlapping the gap on this side
      let zoneContext = null;
      for (const zone of map.junctionZones) {
        if (zone.host === route && zone.side === side && zone.hostRailOpen
          && next.from > zone.hostRailOpen[0] - 1 && prev.to < zone.hostRailOpen[1] + 1) zoneContext = `hostRailOpen(${zone.branch.id})`;
        if (zone.branch === route) {
          for (const [tag, interval, sign] of [
            ['branchInnerRailOff', zone.branchInnerRailOff, zone.hostwardSign],
            ['branchOuterRailOff', zone.branchOuterRailOff, -zone.hostwardSign],
          ]) {
            if (interval && sign === side && next.from > interval[0] - 1 && prev.to < interval[1] + 1) zoneContext = `${tag}(${zone.host.id})`;
          }
        }
      }
      const cause = prev.cutCause || 'unknown';
      if (zoneContext) stats.zoneGaps += 1; else stats.probeGaps += 1;
      const step = Math.abs(prev.toHalf - next.fromHalf);
      if (step > 0.8 && gapLen < 40) {
        stats.lateralSteps.push(`${route.id} side ${side} gap ${prev.to.toFixed(0)}..${next.from.toFixed(0)} (${gapLen.toFixed(0)}m ${cause}${zoneContext ? ' ' + zoneContext : ''}) half ${prev.toHalf.toFixed(1)} -> ${next.fromHalf.toFixed(1)}`);
      }
      if (!zoneContext && gapLen >= 8 && gapLen <= 80) {
        stats.shortProbeGaps.push(`${route.id} side ${side} ${prev.to.toFixed(0)}..${next.from.toFixed(0)} (${gapLen.toFixed(0)}m, ${cause})`);
      }
      if (ALL) console.log(`${route.id} side ${side}: gap ${prev.to.toFixed(0)}..${next.from.toFixed(0)} len ${gapLen.toFixed(0)}m cause=${cause} zone=${zoneContext || '-'}`);
    }
  }
}

// rails still crossing a joining road: crossable zones with no hostRailOpen
for (const zone of map.junctionZones) {
  if (!zone.crossable || zone.hostRailOpen) continue;
  // does a host-side rail run cover the crossable interval?
  const runs = zone.host._railRuns?.[zone.side] || [];
  const [lo, hi] = zone.crossable.host;
  for (const run of runs) {
    const overlap = Math.min(run.to, hi) - Math.max(run.from, lo);
    if (overlap > 4) {
      stats.railAcross += 1;
      console.log(`RAIL-ACROSS? ${zone.kind} ${zone.branch.id} ${zone.which} on ${zone.host.id} side ${zone.side}: run ${run.from.toFixed(0)}..${run.to.toFixed(0)} overlaps crossable ${lo.toFixed(0)}..${hi.toFixed(0)} by ${overlap.toFixed(0)}m (railOpen=${JSON.stringify(zone.hostRailOpen)}, crossOuter max ${Math.max(...zone.samples.filter((r) => r.crossable).map((r) => r.crossOuter - r.hostHalf)).toFixed(2)} beyond host)`);
      break;
    }
  }
}

console.log(`\ngaps=${stats.gaps} (zone=${stats.zoneGaps} probe=${stats.probeGaps}) railAcrossCandidates=${stats.railAcross}`);
console.log(`\nshort probe-driven gaps near nothing (8..80 m): ${stats.shortProbeGaps.length}`);
for (const gap of stats.shortProbeGaps) console.log('  ' + gap);
console.log(`\nlateral steps > 0.8 m across short gaps: ${stats.lateralSteps.length}`);
for (const step of stats.lateralSteps) console.log('  ' + step);
