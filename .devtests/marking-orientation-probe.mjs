/**
 * MARKING-ORIENTATION PROBE — measures the actual painted marking pieces
 * (options.markingDebug log) instead of trusting interval bookkeeping.
 * This is the probe that catches the user-reported slash/backslash bug:
 * junction paint that renders as alternating ~35 deg diagonal segments
 * where a smooth longitudinal dashed boundary belongs.
 *
 * Per painted strip piece (lane dividers, edge lines, zone dashes):
 *   1. DIRECTION vs INTENDED TANGENT — the piece's world direction must
 *      align with the marking path's local tangent (< 30 deg; real dashes
 *      run along the road, only width tapers bend edge lines slightly).
 *   2. LATERAL JUMP — consecutive pieces of one painted boundary must not
 *      jump sideways (> 0.8 m within 25 m of chainage = the line visibly
 *      teleports between host/branch frames).
 *   3. OWNERSHIP — every piece is attributed (host / branch / plain +
 *      painter tag) so a failure names the junction that produced it.
 *
 * Per gore chevron (instanced diagonal wedge paint):
 *   4. ALTERNATING DIAGONAL RUN — 3+ consecutive chevrons alternating
 *      +/-30..45 deg skew form exactly the / \ / \ pattern; any such run
 *      longer than the genuine gore nose (or sitting on a CROSSABLE zone
 *      interval where a longitudinal dashed boundary belongs) fails.
 *
 * Run: node .devtests/marking-orientation-probe.mjs [--verbose]
 */
const VERBOSE = process.argv.includes('--verbose');

const origWarn = console.warn;
console.warn = () => {};
const { HighwayMap } = await import('../js/map.js');
const map = new HighwayMap(null, { addLighting: false, markingDebug: true });
console.warn = origWarn;

let failures = 0;
const fail = (label, detail) => {
  failures += 1;
  console.log(`FAIL  ${label}: ${detail}`);
};
const deg = (rad) => (rad * 180) / Math.PI;

const strips = map._markingLog.filter((piece) => piece.kind === 'strip');
const chevrons = map._markingLog.filter((piece) => piece.kind === 'chevron');

// ownership: which zone (if any) covers this route/station
const ownerOf = (routeId, s) => {
  const route = map.routes.get(routeId);
  for (const zone of map.junctionZones || []) {
    if (zone.host === route && zone.hostContains(zone.crossable?.host, s)) return `host(${zone.branch.id})`;
    if (zone.branch === route && zone.crossable
      && s >= zone.crossable.branch[0] - 1 && s <= zone.crossable.branch[1] + 1) return `branch(${zone.host.id})`;
  }
  return 'plain';
};

// --- 1. direction vs intended tangent ----------------------------------------
// Paint follows the drawn deck; where the DECK ITSELF kinks (centreline
// tangent turning > 15 deg between adjacent surface frames — the documented
// route-data kink families, e.g. c1_2 @14180 and the u-turn stub cusps),
// a faithful stripe is exactly as bent as the asphalt and is not a marking
// defect. Those stations are excluded here and owned by the data pass.
const deckKinkAt = (routeId, s) => {
  const route = map.routes.get(routeId);
  const frames = route.surfaceFrames;
  for (let i = 0; i < frames.length; i += 1) {
    if (Math.abs(frames[i].distance - s) > 8) continue;
    const next = frames[(i + 1) % frames.length];
    const turn = deg(Math.acos(Math.min(1, frames[i].tangent.dot(next.tangent))));
    if (turn > 15) return true;
  }
  return false;
};
const summary = { strips: strips.length, chevrons: chevrons.length, worstAngle: 0, worstJump: 0, diagonalPieces: 0, kinkPieces: 0, alternatingRuns: 0, crossableChevrons: 0 };
for (const piece of strips) {
  const dx = piece.end.x - piece.start.x;
  const dz = piece.end.z - piece.start.z;
  const run = Math.hypot(dx, dz);
  if (run < 0.6) continue; // sub-metre slivers have no readable direction
  const tx = piece.tangent.x;
  const tz = piece.tangent.z;
  const dot = Math.abs((dx * tx + dz * tz) / (run * Math.hypot(tx, tz)));
  const angle = deg(Math.acos(Math.min(1, dot)));
  if (angle > 30 && deckKinkAt(piece.routeId, piece.sFrom)) {
    summary.kinkPieces += 1;
    if (VERBOSE) console.log(`  kink-following ${piece.routeId} ${piece.tag} s=${piece.sFrom.toFixed(0)} angle ${angle.toFixed(0)} deg (deck kink — data pass)`);
    continue;
  }
  summary.worstAngle = Math.max(summary.worstAngle, angle);
  if (angle > 30) {
    summary.diagonalPieces += 1;
    fail('diagonal-strip', `${piece.routeId} ${piece.tag} s=${piece.sFrom.toFixed(0)} `
      + `angle ${angle.toFixed(0)} deg owner=${ownerOf(piece.routeId, piece.sFrom)}`);
  } else if (VERBOSE && angle > 18) {
    console.log(`  warn ${piece.routeId} ${piece.tag} s=${piece.sFrom.toFixed(0)} angle ${angle.toFixed(1)} deg`);
  }
}

// --- 2. lateral jump between consecutive pieces of one boundary ---------------
const groups = new Map();
for (const piece of strips) {
  const lateralKey = piece.tag === 'edgeLine' ? (piece.latFrom >= 0 ? 'L' : 'R') : Math.round(piece.latFrom);
  const key = `${piece.routeId}|${piece.tag}|${piece.material}|${lateralKey}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(piece);
}
for (const [key, pieces] of groups) {
  pieces.sort((a, b) => a.sFrom - b.sFrom);
  for (let i = 1; i < pieces.length; i += 1) {
    const prev = pieces[i - 1];
    const next = pieces[i];
    const gap = next.sFrom - prev.sTo;
    if (gap > 25 || gap < -0.5) continue;
    const jump = Math.abs(next.latFrom - prev.latTo);
    summary.worstJump = Math.max(summary.worstJump, jump);
    if (jump > 0.8) {
      fail('lateral-jump', `${key} s=${prev.sTo.toFixed(0)}->${next.sFrom.toFixed(0)} jumps ${jump.toFixed(2)} m `
        + `owner=${ownerOf(next.routeId, next.sFrom)}`);
    }
  }
}

// --- 4. alternating diagonal chevron runs -------------------------------------
// group chevrons by junction (they are logged in walk order along the ramp)
const chevronGroups = new Map();
for (const chevron of chevrons) {
  const key = `${chevron.edgeKind} ${chevron.routeId} on ${chevron.hostId}`;
  if (!chevronGroups.has(key)) chevronGroups.set(key, []);
  chevronGroups.get(key).push(chevron);
}
for (const [key, list] of chevronGroups) {
  let run = 1;
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    const diagonal = Math.abs(c.skewDeg) >= 30 && Math.abs(c.skewDeg) <= 45 && c.length >= 2.5;
    const alternates = i > 0 && Math.sign(c.skewDeg) !== Math.sign(list[i - 1].skewDeg);
    run = diagonal && (i === 0 || alternates) ? run + 1 : 1;
    // where is this chevron relative to the junction zone?
    const host = map.routes.get(c.hostId);
    let onCrossable = false;
    if (host) {
      const projection = map._projectToRoute(host, { x: c.position.x, y: c.position.y, z: c.position.z });
      for (const zone of map.junctionZones || []) {
        if (zone.host !== host) continue;
        if (zone.branch.id !== c.routeId) continue;
        if (zone.hostContains(zone.crossable?.host, projection.distance)) { onCrossable = true; break; }
      }
    }
    if (onCrossable) {
      summary.crossableChevrons += 1;
      if (VERBOSE) console.log(`  crossable-chevron ${key} at (${c.position.x.toFixed(0)}, ${c.position.z.toFixed(0)}) skew ${c.skewDeg.toFixed(0)}`);
    }
    if (run === 3) {
      summary.alternatingRuns += 1;
      fail('alternating-diagonals', `${key}: 3+ consecutive +/-${Math.abs(c.skewDeg).toFixed(0)} deg segments `
        + `(the / \\ / \\ pattern) near (${c.position.x.toFixed(0)}, ${c.position.z.toFixed(0)})${onCrossable ? ' ON CROSSABLE BOUNDARY' : ''}`);
    }
  }
}
if (summary.crossableChevrons) {
  fail('chevron-on-merge-lane', `${summary.crossableChevrons} chevrons painted over crossable merge/diverge boundaries (longitudinal dashes belong there)`);
}

console.log(`\nstrip pieces=${summary.strips} chevrons=${summary.chevrons}`);
console.log(`worst: strip-vs-tangent ${summary.worstAngle.toFixed(1)} deg | lateral jump ${summary.worstJump.toFixed(2)} m`);
console.log(`diagonal strip pieces=${summary.diagonalPieces} (deck-kink followers excluded: ${summary.kinkPieces}) | alternating chevron runs=${summary.alternatingRuns} | chevrons on crossable boundary=${summary.crossableChevrons}`);
if (failures) { console.log(`MARKING ORIENTATION PROBE: FAIL (${failures})`); process.exit(1); }
console.log('MARKING ORIENTATION PROBE: PASS');
