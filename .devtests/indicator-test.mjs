/**
 * Verifies the lane-change indicator blinks on the side the car actually
 * moves toward — in world space, for both carriageway directions.
 * Run: node .devtests/indicator-test.mjs
 */
import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';
import { TrafficSystem } from '../js/traffic.js';

const map = new HighwayMap(null, {});
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

for (const direction of [1, -1]) {
  for (const laneDelta of [1, -1]) {
    const scene = new THREE.Group();
    const traffic = new TrafficSystem(scene, map, { count: 2, maxVehicles: 2 });
    const startLane = laneDelta > 0 ? 0 : 2; // room to move in the delta direction
    const spawn = map.sampleLane('wangan', 6000, startLane, direction);
    const vehicle = traffic.spawnVehicle({ ...spawn, laneRef: spawn.laneRef, playerDistance: 500 });
    if (!vehicle) { check(`spawn dir ${direction}`, false); continue; }

    const adjacent = traffic._adjacentLane(vehicle, laneDelta);
    if (!adjacent) { check(`adjacent lane dir ${direction} delta ${laneDelta}`, false); continue; }
    vehicle.laneChange = { from: vehicle.laneRef, to: adjacent, direction: laneDelta, elapsed: 0, duration: 2.4 };
    vehicle.indicator = laneDelta;

    // Fake player 300 m behind on the same road: inside the despawn radius,
    // far enough not to interact.
    const playerSpot = map.sampleLane('wangan', 6300, 0, direction);
    const player = { position: playerSpot.position.clone(), velocity: new THREE.Vector3(), heading: 0, speed: 0 };
    const before = vehicle.position.clone();
    const tangent = vehicle.tangent.clone();
    for (let i = 0; i < 40; i += 1) traffic.update(1 / 60, player);

    const carLeft = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), tangent).normalize();
    const move = vehicle.position.clone().sub(before);
    const lateralMove = move.dot(carLeft); // >0 = car moved to ITS left

    // Which world side does the blinking lamp sit on?
    const entry = vehicle.mesh.userData.indicators.find((candidate) => candidate.side === vehicle.indicator);
    check(`indicator entry exists (dir ${direction}, delta ${laneDelta})`, !!entry);
    if (!entry) continue;
    const lampMesh = entry.meshes[0];
    lampMesh.geometry.computeBoundingBox();
    const localCenter = lampMesh.geometry.boundingBox.getCenter(new THREE.Vector3());
    vehicle.mesh.updateMatrixWorld(true);
    const lampWorld = localCenter.clone().applyMatrix4(lampMesh.matrixWorld);
    const lampSide = lampWorld.sub(vehicle.position).dot(carLeft); // >0 = lamp on car's left

    const moveSide = lateralMove > 0 ? 'left' : 'right';
    const blinkSide = lampSide > 0 ? 'left' : 'right';
    check(
      `dir ${direction} lane ${startLane}->${startLane + laneDelta}: blinker matches movement`,
      Math.sign(lateralMove) === Math.sign(lampSide) && Math.abs(lateralMove) > 0.15,
      `moves ${moveSide} (${lateralMove.toFixed(2)} m), blinks ${blinkSide}`,
    );
    traffic.dispose();
  }
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
