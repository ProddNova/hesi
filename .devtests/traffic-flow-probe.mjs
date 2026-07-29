/**
 * Probe: the three things that make traffic read as "flowing" rather than
 * lagging and clumping.
 *
 *   1. Smoothness next to a slow player — traffic must not brake/throttle
 *      slam (judder) because the player is crawling alongside it.
 *   2. Coverage of the road ahead — no hundreds of empty metres in front.
 *   3. Side-by-side walls — a row of vehicles filling every lane must not
 *      persist. Traffic keeps its lane, so this has to come out of the flow
 *      itself: each lane cruises in its own speed band, and a driver level
 *      with a neighbour clears the situation.
 *
 * Run: node .devtests/traffic-flow-probe.mjs
 */
import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';
import { TrafficSystem } from '../js/traffic.js';

const map = new HighwayMap(null, {});
const FORWARD = (heading) => new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));

function makePlayer(speed) {
  const spawn = map.getInitialSpawn();
  return {
    position: spawn.position.clone(), previousPosition: spawn.position.clone(),
    velocity: new THREE.Vector3(0, 0, speed), heading: spawn.heading, speed,
    width: 1.8, length: 4.4, height: 1.3, spec: {},
  };
}

function step(traffic, player, dt = 1 / 60) {
  player.previousPosition.copy(player.position);
  player.position.addScaledVector(FORWARD(player.heading), player.speed * dt);
  const road = map.getRoadInfo(player.position);
  if (road) { player.position.copy(road.center); player.heading = road.heading; }
  traffic.update(dt, player, { roadInfo: road });
  return road;
}

// ---------------------------------------------------------------- 1. judder
// The player crawls along in the middle of the traffic stream. Nearby cars are
// watched for acceleration reversals (accelerating one frame, braking the
// next): that alternation is exactly what is seen as stuttering vehicles.
function judderProbe(playerSpeed) {
  const traffic = new TrafficSystem(new THREE.Group(), map, { count: 60, maxVehicles: 90, density: 1 });
  const player = makePlayer(playerSpeed);
  for (let i = 0; i < 1800; i += 1) step(traffic, player);

  const previous = new Map();
  let samples = 0;
  let reversals = 0;
  const jerks = [];
  for (let i = 0; i < 3600; i += 1) {
    step(traffic, player);
    for (const v of traffic.active) {
      if (v.position.distanceTo(player.position) > 45) { previous.delete(v.id); continue; }
      const last = previous.get(v.id);
      previous.set(v.id, v.acceleration);
      if (last === undefined) continue;
      samples += 1;
      jerks.push(Math.abs(v.acceleration - last) * 60);
      if (Math.sign(last) !== Math.sign(v.acceleration) && Math.abs(last - v.acceleration) > 1.2) reversals += 1;
    }
  }
  jerks.sort((a, b) => a - b);
  return {
    reversalsPerSample: reversals / Math.max(1, samples),
    // The peak is an emergency stop and is allowed to be sharp; p99 is what the
    // player actually watches, and it is what used to read as stuttering.
    jerkP99: jerks[Math.floor(jerks.length * 0.99)] ?? 0,
    peakJerk: jerks[jerks.length - 1] ?? 0,
    samples,
  };
}

// ------------------------------------------------------- 2. road ahead / 3. rows
function flowProbe(playerSpeed) {
  const traffic = new TrafficSystem(new THREE.Group(), map, { count: 70, maxVehicles: 120, density: 1 });
  const player = makePlayer(playerSpeed);
  for (let i = 0; i < 900; i += 1) step(traffic, player);

  const nearestAhead = [];
  const biggestHole = [];
  const wallAge = new Map();
  const wallLives = [];
  let longestWall = 0;
  let walledFrames = 0;
  let frames = 0;

  for (let i = 0; i < 9000; i += 1) {
    const road = step(traffic, player);
    frames += 1;

    // A "wall" is a set of vehicles filling EVERY lane of one carriageway
    // within 12 m of each other along the road: the formation the player ends
    // up queued behind with no way past. What matters is not that it forms —
    // with dense traffic that is inevitable — but how long the same formation
    // holds together before the lanes sort themselves out again.
    const walls = new Map();
    for (const v of traffic.active) {
      const routeId = v.laneRef?.routeId;
      const laneIndex = v.laneRef?.laneIndex;
      const laneCount = Math.floor(v.laneRef?.laneCount ?? 0);
      if (routeId == null || !Number.isFinite(laneIndex) || laneCount < 2) continue;
      const key = `${routeId}:${Math.sign(v.laneRef.direction ?? 1)}`;
      if (!walls.has(key)) walls.set(key, { laneCount, members: [] });
      walls.get(key).members.push(v);
    }
    const present = new Set();
    for (const { laneCount, members } of walls.values()) {
      for (const v of members) {
        const lanes = new Map([[v.laneRef.laneIndex, v.id]]);
        for (const other of members) {
          if (other === v || Math.abs(other.s - v.s) > 12) continue;
          if (!lanes.has(other.laneRef.laneIndex)) lanes.set(other.laneRef.laneIndex, other.id);
        }
        if (lanes.size < laneCount) continue;
        present.add([...lanes.values()].sort().join('|'));
      }
    }
    for (const key of present) {
      const age = (wallAge.get(key) ?? 0) + 1 / 60;
      wallAge.set(key, age);
      longestWall = Math.max(longestWall, age);
    }
    for (const key of [...wallAge.keys()]) {
      if (present.has(key)) continue;
      wallLives.push(wallAge.get(key));
      wallAge.delete(key);
    }
    if (present.size) walledFrames += 1;

    if (i % 20 !== 0) continue;
    const forward = FORWARD(player.heading);
    const right = new THREE.Vector3(Math.cos(player.heading), 0, -Math.sin(player.heading));
    const ahead = [];
    for (const v of traffic.active) {
      const dx = v.position.x - player.position.x;
      const dz = v.position.z - player.position.z;
      const along = dx * forward.x + dz * forward.z;
      const lateral = Math.abs(dx * right.x + dz * right.z);
      if (along > 0 && along < 620 && lateral < 26) ahead.push(along);
    }
    ahead.sort((a, b) => a - b);
    nearestAhead.push(ahead.length ? ahead[0] : 620);
    let previous = 0;
    let hole = 0;
    for (const along of ahead) { hole = Math.max(hole, along - previous); previous = along; }
    biggestHole.push(Math.max(hole, 620 - previous));
  }

  const percentile = (list, p) => {
    const sorted = list.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  };
  return {
    nearestMedian: percentile(nearestAhead, 0.5),
    nearestP90: percentile(nearestAhead, 0.9),
    holeMedian: percentile(biggestHole, 0.5),
    holeP90: percentile(biggestHole, 0.9),
    bigHoleShare: biggestHole.filter((h) => h > 300).length / biggestHole.length,
    longestWall,
    wallP95: percentile(wallLives, 0.95) ?? 0,
    wallShare: walledFrames / frames,
  };
}

const judder = judderProbe(7);
const flow = flowProbe(32);
const fastFlow = flowProbe(58);

console.log('--- JUDDER NEXT TO A CRAWLING PLAYER (7 m/s) ---');
console.log(`accel sign reversals: ${(100 * judder.reversalsPerSample).toFixed(2)}% of samples (n=${judder.samples})`);
console.log(`jerk: p99 ${judder.jerkP99.toFixed(1)} m/s³ · peak ${judder.peakJerk.toFixed(1)} m/s³`);

for (const [label, result] of [['CRUISING PLAYER (32 m/s)', flow], ['FAST PLAYER (58 m/s)', fastFlow]]) {
  console.log(`\n--- ROAD AHEAD · ${label} ---`);
  console.log(`nearest vehicle ahead: median ${result.nearestMedian.toFixed(0)}m · p90 ${result.nearestP90.toFixed(0)}m`);
  console.log(`largest hole in the 620m ahead: median ${result.holeMedian.toFixed(0)}m · p90 ${result.holeP90.toFixed(0)}m`);
  console.log(`frames with a >300m hole ahead: ${(100 * result.bigHoleShare).toFixed(1)}%`);
  console.log(`full-width wall of traffic: present ${(100 * result.wallShare).toFixed(1)}% of frames · lifetime p95 ${result.wallP95.toFixed(1)}s · longest ${result.longestWall.toFixed(1)}s`);
}

let ok = true;
const assert = (name, condition) => { if (!condition) { ok = false; console.log(`FAIL ${name}`); } else console.log(`PASS ${name}`); };
console.log('\n--- CHECKS ---');
assert('traffic beside a crawling player does not slam accel/brake',
  judder.reversalsPerSample < 0.004 && judder.jerkP99 < 10);
assert('the road ahead is rarely empty for hundreds of metres',
  flow.bigHoleShare < 0.22 && fastFlow.bigHoleShare < 0.22);
assert('there is usually a car within ~100m ahead',
  flow.nearestMedian < 100 && fastFlow.nearestMedian < 100);
// The single longest formation is a noisy tail statistic; p95 of every wall's
// lifetime is the stable measure of whether rows sort themselves out. Before
// this work it was 21.5 s at a cruising pace and 9.8 s at speed, over notably
// sparser traffic, and that was WITH traffic changing lane to escape.
assert('a full-width wall of traffic breaks up quickly',
  flow.wallP95 < 12 && fastFlow.wallP95 < 12);
process.exit(ok ? 0 : 1);
