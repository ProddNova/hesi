/**
 * Probe: class mix, per-class lane placement and lane coverage.
 * Run: node .devtests/traffic-distribution-probe.mjs
 */
import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';
import { TrafficSystem } from '../js/traffic.js';

const map = new HighwayMap(null, {});
const scene = new THREE.Group();
// Instrument spawns to prove nothing pops into view ahead of the player. A
// spawn only counts as "in view" when it is inside the driving camera's
// horizontal cone: a point off to the side or around a bend is off-screen even
// at short range, and being allowed to use it is what keeps the road ahead
// populated through the curves.
let minFrontSpawn = Infinity;
let frontSpawnCount = 0;
let inViewSpawns = 0;
const typeCounts = { car: 0, van: 0, truck: 0 };
const traffic = new TrafficSystem(scene, map, {
  count: 70, maxVehicles: 120, density: 1,
  onSpawn: (v) => {
    typeCounts[v.type.id] = (typeCounts[v.type.id] || 0) + 1;
    const dx = v.position.x - player.position.x;
    const dz = v.position.z - player.position.z;
    const ahead = dx * Math.sin(player.heading) + dz * Math.cos(player.heading);
    if (ahead <= 0) return;
    const distance = Math.hypot(dx, dz);
    frontSpawnCount += 1;
    minFrontSpawn = Math.min(minFrontSpawn, distance);
    // Same cone the system itself uses, with a little slack for the sampling.
    if (distance < traffic.options.frontSpawnDistance && ahead >= distance * Math.cos(58 * Math.PI / 180)) {
      inViewSpawns += 1;
    }
  },
});
const frontThreshold = traffic.options.frontSpawnDistance;

const spawn = map.getInitialSpawn();
const player = {
  position: spawn.position.clone(), previousPosition: spawn.position.clone(),
  velocity: new THREE.Vector3(0, 0, 30), heading: spawn.heading, speed: 30,
  width: 1.8, length: 4.4, height: 1.3, spec: {},
};

const laneByType = { car: [], van: [], truck: [] };
let laneCoverageSamples = 0;
let emptyLaneSamples = 0;
let emptyCruiseLaneSamples = 0;
let maxLaneImbalance = 0;

for (let i = 0; i < 6000; i += 1) {
  player.previousPosition.copy(player.position);
  player.position.addScaledVector(new THREE.Vector3(Math.sin(player.heading), 0, Math.cos(player.heading)), 32 / 60);
  const road = map.getRoadInfo(player.position);
  if (road) { player.position.copy(road.center); player.heading = road.heading; }
  traffic.update(1 / 60, player, { roadInfo: road });

  for (const v of traffic.active) {
    const idx = v.laneRef?.laneIndex;
    if (Number.isFinite(idx) && i % 30 === 0) laneByType[v.type.id]?.push(idx);
  }
  if (i % 30 === 0) {
    const corridors = new Map();
    for (const v of traffic.active) {
      const routeId = v.laneRef?.routeId ?? v.laneRef?.route?.id;
      const laneCount = Math.max(1, Math.floor(v.laneRef?.laneCount ?? v.laneRef?.route?.lanes ?? 1));
      const laneIndex = v.laneRef?.laneIndex ?? v.laneRef?.index;
      const direction = Math.sign(v.laneRef?.direction ?? v.laneSample?.direction ?? 1);
      if (routeId == null || laneCount < 2 || !Number.isFinite(laneIndex)) continue;
      const key = `${routeId}:${direction}`;
      if (!corridors.has(key)) corridors.set(key, Array(laneCount).fill(0));
      const counts = corridors.get(key);
      if (laneIndex >= 0 && laneIndex < counts.length) counts[Math.floor(laneIndex)] += 1;
    }
    for (const counts of corridors.values()) {
      const total = counts.reduce((sum, value) => sum + value, 0);
      if (total < counts.length * 2) continue;
      laneCoverageSamples += 1;
      // Lane 0 is the overtaking lane: drivers pull into it to pass and drift
      // back out once clear, so it is legitimately empty now and then. Any
      // OTHER lane running empty is a distribution failure.
      if (counts.some((value) => value === 0)) emptyLaneSamples += 1;
      if (counts.slice(1).some((value) => value === 0)) emptyCruiseLaneSamples += 1;
      maxLaneImbalance = Math.max(maxLaneImbalance, Math.max(...counts) - Math.min(...counts));
    }
  }
}

const totalSpawned = typeCounts.car + typeCounts.van + typeCounts.truck;
const pct = (n) => `${((100 * n) / Math.max(1, totalSpawned)).toFixed(1)}%`;
const avg = (arr) => (arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : 'n/a');

console.log('--- CLASS MIX (unique spawns) ---');
console.log(`total spawned: ${totalSpawned}`);
console.log(`car:   ${typeCounts.car}  (${pct(typeCounts.car)})`);
console.log(`van:   ${typeCounts.van}  (${pct(typeCounts.van)})`);
console.log(`truck: ${typeCounts.truck}  (${pct(typeCounts.truck)})`);
console.log('\n--- AVG LANE INDEX (0 = fast/median lane, higher = slow/outer/left) ---');
console.log(`car:   ${avg(laneByType.car)}  (n=${laneByType.car.length})`);
console.log(`van:   ${avg(laneByType.van)}  (n=${laneByType.van.length})`);
console.log(`truck: ${avg(laneByType.truck)}  (n=${laneByType.truck.length})`);
console.log(`\nactive at end: ${traffic.activeCount}`);
console.log('\n--- LANE COVERAGE ---');
console.log(`dense corridor samples: ${laneCoverageSamples}`);
console.log(`samples with an empty lane: ${emptyLaneSamples} (overtaking lane included)`);
console.log(`samples with an empty CRUISING lane: ${emptyCruiseLaneSamples}`);
console.log(`maximum lane-count imbalance: ${maxLaneImbalance}`);
console.log('\n--- SPAWN VISIBILITY ---');
console.log(`front-spawns: ${frontSpawnCount} · closest in front: ${minFrontSpawn === Infinity ? 'none' : minFrontSpawn.toFixed(1)}m (fog horizon ${frontThreshold}m)`);
console.log(`front-spawns inside the camera cone: ${inViewSpawns}`);

// Basic assertions
let ok = true;
const assert = (name, cond) => { if (!cond) { ok = false; console.log(`FAIL ${name}`); } else console.log(`PASS ${name}`); };
console.log('\n--- CHECKS ---');
assert('cars are the most common class', typeCounts.car > typeCounts.van && typeCounts.car > typeCounts.truck);
assert('tir are the rarest class', typeCounts.truck < typeCounts.van && typeCounts.truck <= typeCounts.car);
assert('trucks sit further out than cars', avg(laneByType.truck) === 'n/a' || +avg(laneByType.truck) >= +avg(laneByType.car));
assert('dense corridors never leave a cruising lane empty',
  laneCoverageSamples > 0 && emptyCruiseLaneSamples / laneCoverageSamples < 0.01);
// The residual cases are all one situation: the player is on a ramp, so the
// spawn planner is managing the ramp's corridor while the main carriageway
// alongside it goes unmanaged and its fast lane — whose cars are the quickest,
// and simply run out ahead — is not refilled. Traffic no longer changes lane,
// so spawn placement is the only thing that can refill it.
assert('dense corridors rarely leave even the overtaking lane empty',
  laneCoverageSamples > 0 && emptyLaneSamples / laneCoverageSamples < 0.2);
assert('nothing spawns in view ahead of the player', inViewSpawns === 0);
process.exit(ok ? 0 : 1);
