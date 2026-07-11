import * as THREE from 'three';
import { VehiclePhysics } from '../js/physics.js';

// Reproduce the camera math from game.js updateCamera + three.js lookAt to
// determine what "screen right" is, then apply steer=+1 (the D / steer-right input)
const phys = new VehiclePhysics({ power: 200, mass: 1100 });
phys.setPosition(0, 0, 0, 0);
phys.setSpeed(30); // 108 km/h forward

const road = { height: 0, snapHeight: true, surfaceGrip: 1 };
for (let i = 0; i < 120; i++) phys.update(1/60, { throttle: 0.5, steer: 1 }, road, { gearbox: 'auto' });

const h = phys.heading;
const f = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
// camera screen-right = up x (eye-target) per three.js lookAt: for view dir f -> x = up × (-f)
const screenRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), f.clone().negate()).normalize();
console.log('heading after 2s of steer=+1 (input "right"):', h.toFixed(3));
console.log('position:', phys.position.x.toFixed(1), phys.position.z.toFixed(1));
console.log('screenRight at h=0 was (-1,0,0); car moved along X:', phys.position.x > 0 ? '+X' : '-X');
console.log('=> car turned', phys.position.x > 0 ? 'SCREEN-LEFT (INVERTED!)' : 'screen-right (correct)');
