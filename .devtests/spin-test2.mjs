import * as THREE from 'three';
import { VehiclePhysics } from '../js/physics.js';
const road = { height: 0, snapHeight: true, surfaceGrip: 1 };

// Angled wall impact at 150km/h: 10 m/s into the wall while doing 38 m/s forward
const phys = new VehiclePhysics({ power: 200, mass: 1100 });
phys.setPosition(0, 0, 0, 0);
phys.velocity.set(10, 0, 38);
phys.resolveCollision({ normal: new THREE.Vector3(-1, 0, 0), penetration: 0.05 });
console.log('after impact: yawRate', phys.yawRate.toFixed(2));
for (let i = 0; i < 180; i++) {
  phys.update(1/60, { throttle: 0, steer: 0 }, road, {});
  if (i % 30 === 29) console.log(`t+${((i+1)/60).toFixed(1)}s yaw=${phys.yawRate.toFixed(2)} lat=${phys.getState().lateralSpeed.toFixed(1)} fwd=${phys.getState().forwardSpeed.toFixed(1)}`);
}

// step-steer at 160 km/h with the new grip-aware authority
const p3 = new VehiclePhysics({ power: 250, mass: 1150 });
p3.setPosition(0,0,0,0); p3.setSpeed(45);
for (let i = 0; i < 300; i++) {
  p3.update(1/60, { throttle: .4, steer: i>30?1:0 }, road, {});
  if(i%60===59) console.log(`steer t+${((i+1)/60).toFixed(0)}s yaw=${p3.yawRate.toFixed(2)} lat=${p3.getState().lateralSpeed.toFixed(1)} fwd=${p3.getState().forwardSpeed.toFixed(1)} steering=${p3.steering.toFixed(3)}`);
}
// release: does it straighten without oscillation?
let over = 0;
let lastSign = 0, flips = 0;
for (let i = 0; i < 240; i++) {
  p3.update(1/60, { throttle: .4, steer: 0 }, road, {});
  const s = Math.sign(p3.yawRate.toFixed(2));
  if (s && lastSign && s !== lastSign) flips++;
  if (s) lastSign = s;
}
console.log('after release: yaw', p3.yawRate.toFixed(3), 'lat', p3.getState().lateralSpeed.toFixed(2), 'sign flips (oscillation):', flips);

// low-speed full lock still available? (parking / U-turn)
const p4 = new VehiclePhysics({});
p4.setPosition(0,0,0,0); p4.setSpeed(5);
for (let i = 0; i < 120; i++) p4.update(1/60, { throttle: .3, steer: 1 }, road, {});
console.log('low speed 2s turn: heading', p4.heading.toFixed(2), 'rad (want > 0.8)');
