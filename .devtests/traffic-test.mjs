import * as THREE from 'three';
import { TrafficSystem } from '../js/traffic.js';
import { HighwayMap } from '../js/map.js';

const scene = new THREE.Group();
const map = new HighwayMap(null, {});
const traffic = new TrafficSystem(scene, map, { count: 30, density: 0.78 });
let meshesPerVehicle = 0;
traffic.pool[0].mesh.traverse(o => { if (o.isMesh) meshesPerVehicle++; });
console.log('meshes per traffic vehicle:', meshesPerVehicle);

// simulate: player driving on wangan, traffic spawns/advances for 20s
const spawn = map.getInitialSpawn();
const player = { position: spawn.position.clone(), previousPosition: spawn.position.clone(), velocity: new THREE.Vector3(0,0,30), heading: spawn.heading, speed: 30, width: 1.7, length: 4.3, height: 1.3, spec: {} };
let events = 0, nearMisses = 0;
for (let i = 0; i < 1200; i++) {
  player.previousPosition.copy(player.position);
  player.position.addScaledVector(new THREE.Vector3(Math.sin(player.heading),0,Math.cos(player.heading)), 30/60);
  const road = map.getRoadInfo(player.position);
  if (road) { player.position.copy(road.center); player.heading = road.heading; }
  const evs = traffic.update(1/60, player) || [];
  events += evs.length;
  nearMisses += evs.filter(e=>e.type==='nearMiss').length;
}
console.log('after 20s: active vehicles', traffic.activeCount, '| events', events, '| nearMisses', nearMisses);
console.log('sample vehicle position finite:', traffic.active[0] ? Number.isFinite(traffic.active[0].position.x) : 'n/a');
