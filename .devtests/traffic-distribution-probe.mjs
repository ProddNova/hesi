/**
 * Probe: class mix, per-class lane placement and lane-change cadence.
 * Run: node .devtests/traffic-distribution-probe.mjs
 */
import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';
import { TrafficSystem } from '../js/traffic.js';

const map = new HighwayMap(null, {});
const scene = new THREE.Group();
const traffic = new TrafficSystem(scene, map, { count: 70, maxVehicles: 120, density: 1 });

const spawn = map.getInitialSpawn();
const player = {
  position: spawn.position.clone(), previousPosition: spawn.position.clone(),
  velocity: new THREE.Vector3(0, 0, 30), heading: spawn.heading, speed: 30,
  width: 1.8, length: 4.4, height: 1.3, spec: {},
};

const typeCounts = { car: 0, van: 0, truck: 0 };
const laneByType = { car: [], van: [], truck: [] };
let laneChangeStarts = 0;
let maxConcurrentChanges = 0;
const seen = new Set();

for (let i = 0; i < 6000; i += 1) {
  player.previousPosition.copy(player.position);
  player.position.addScaledVector(new THREE.Vector3(Math.sin(player.heading), 0, Math.cos(player.heading)), 32 / 60);
  const road = map.getRoadInfo(player.position);
  if (road) { player.position.copy(road.center); player.heading = road.heading; }
  traffic.update(1 / 60, player, { roadInfo: road });

  let changing = 0;
  for (const v of traffic.active) {
    if (!seen.has(v.id)) { seen.add(v.id); typeCounts[v.type.id] = (typeCounts[v.type.id] || 0) + 1; }
    if (v.laneChange) { changing += 1; }
    const idx = v.laneRef?.laneIndex;
    if (Number.isFinite(idx) && i % 30 === 0) laneByType[v.type.id]?.push(idx);
  }
  maxConcurrentChanges = Math.max(maxConcurrentChanges, changing);
}
// Count unique lane-change events over the run by sampling a marker id.
for (let i = 0; i < 3000; i += 1) {
  player.previousPosition.copy(player.position);
  player.position.addScaledVector(new THREE.Vector3(Math.sin(player.heading), 0, Math.cos(player.heading)), 32 / 60);
  const road = map.getRoadInfo(player.position);
  if (road) { player.position.copy(road.center); player.heading = road.heading; }
  traffic.update(1 / 60, player, { roadInfo: road });
  for (const v of traffic.active) {
    if (v.laneChange && !v._counted) { v._counted = true; laneChangeStarts += 1; }
    if (!v.laneChange) v._counted = false;
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
console.log('\n--- LANE CHANGES ---');
console.log(`lane-change events over ~50s: ${laneChangeStarts}`);
console.log(`max concurrent lane changes: ${maxConcurrentChanges}`);
console.log(`active at end: ${traffic.activeCount}`);

// Basic assertions
let ok = true;
const assert = (name, cond) => { if (!cond) { ok = false; console.log(`FAIL ${name}`); } else console.log(`PASS ${name}`); };
console.log('\n--- CHECKS ---');
assert('cars are the most common class', typeCounts.car > typeCounts.van && typeCounts.car > typeCounts.truck);
assert('tir are the rarest class', typeCounts.truck < typeCounts.van && typeCounts.truck <= typeCounts.car);
assert('trucks sit further out than cars', avg(laneByType.truck) === 'n/a' || +avg(laneByType.truck) >= +avg(laneByType.car));
process.exit(ok ? 0 : 1);
