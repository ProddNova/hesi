import * as THREE from 'three';
import { VehiclePhysics } from '../js/physics.js';

const phys = new VehiclePhysics({ power: 200, mass: 1100 });
phys.setPosition(0, 0, 0, 0);
phys.setSpeed(40); // 144 km/h
const road = { height: 0, snapHeight: true, surfaceGrip: 1 };

// simulate a wall scrape: resolveCollision called every frame for 0.5s (as game.js + physics both do)
for (let i = 0; i < 30; i++) {
  phys.update(1/60, { throttle: 0.6, steer: 0 }, road, {});
  phys.resolveCollision({ normal: new THREE.Vector3(1, 0, 0), penetration: 0.02 });
}
console.log('yawRate right after 0.5s scrape:', phys.yawRate.toFixed(2));
// then free run, no input, watch spin decay
let peak = 0;
for (let i = 0; i < 360; i++) {
  phys.update(1/60, { throttle: 0, steer: 0 }, road, {});
  peak = Math.max(peak, Math.abs(phys.yawRate));
  if (i % 60 === 0) console.log(`t+${i/60}s yawRate=${phys.yawRate.toFixed(2)} speed=${(phys.getState().speedKmh).toFixed(0)}km/h latSpeed=${phys.getState().lateralSpeed.toFixed(1)}`);
}
console.log('peak yawRate during free run:', peak.toFixed(2));

// straight-line stability at high speed
const p2 = new VehiclePhysics({ power: 300, mass: 1200 });
p2.setPosition(0, 0, 0, 0); p2.setSpeed(60);
let maxYaw2 = 0;
for (let i = 0; i < 600; i++) { p2.update(1/60, { throttle: 1, steer: 0 }, road, { gearbox: 'auto' }); maxYaw2 = Math.max(maxYaw2, Math.abs(p2.yawRate)); }
console.log('straight-line 10s @high speed: maxYaw', maxYaw2.toFixed(4), 'x-drift', p2.position.x.toFixed(2));

// step-steer at 160km/h: does it oscillate/snap?
const p3 = new VehiclePhysics({ power: 250, mass: 1150 });
p3.setPosition(0,0,0,0); p3.setSpeed(45);
let log=[];
for (let i = 0; i < 240; i++) { p3.update(1/60, { throttle: .4, steer: i>30?1:0 }, road, {}); if(i%30===0)log.push(p3.yawRate.toFixed(2)); }
console.log('step-steer yawRate samples:', log.join(' '), '| latSpeed', p3.getState().lateralSpeed.toFixed(1));
