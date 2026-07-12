/**
 * Low/mid-speed grip: a full steering press at 60 and 100 km/h must corner
 * hard with no slide/drift; near-limit behaviour stays progressive.
 * Run: node .devtests/grip-test.mjs
 */
import { VehiclePhysics } from '../js/physics.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const spec = {
  id: 'test-street', mass: 1120, power: 150, peakTorque: 190, redline: 7000,
  tireGrip: 1.0, brakeForce: 12000, drivetrain: 'RWD',
};
const road = { surfaceGrip: 1, grade: 0, onRoad: true };

for (const kmh of [60, 100]) {
  const car = new VehiclePhysics(spec);
  car.setPosition(0, 0, 0, 0);
  car.setSpeed(kmh / 3.6);
  let maxRearSat = 0;
  let maxLatSpeed = 0;
  let maxLatG = 0;
  for (let i = 0; i < 60 * 4; i += 1) {
    car.update(1 / 60, { throttle: 0.35, steer: 1 }, road, {});
    const t = car.getTelemetry();
    maxRearSat = Math.max(maxRearSat, t.rearSaturation);
    maxLatSpeed = Math.max(maxLatSpeed, Math.abs(t.lateralSpeed));
    maxLatG = Math.max(maxLatG, Math.abs(t.gLateral));
  }
  const t = car.getTelemetry();
  check(`${kmh} km/h full press: rear never saturates (no drift)`, maxRearSat < 0.99, `max rear sat ${maxRearSat.toFixed(2)}`);
  check(`${kmh} km/h full press: lateral slip stays small`, maxLatSpeed < 2.0, `max lat speed ${maxLatSpeed.toFixed(2)} m/s`);
  check(`${kmh} km/h full press: corners hard`, maxLatG > 0.55, `peak ${maxLatG.toFixed(2)} g`);
  check(`${kmh} km/h: still pointed and rolling (yaw rate sane)`, Math.abs(t.yawRate) < 1.2 && Number.isFinite(t.yawRate), `yaw ${t.yawRate.toFixed(2)}`);
}

// Flick left-right at 80 km/h: must settle straight, not spin.
{
  const car = new VehiclePhysics(spec);
  car.setPosition(0, 0, 0, 0);
  car.setSpeed(80 / 3.6);
  for (let i = 0; i < 30; i += 1) car.update(1 / 60, { throttle: 0.3, steer: 1 }, road, {});
  for (let i = 0; i < 30; i += 1) car.update(1 / 60, { throttle: 0.3, steer: -1 }, road, {});
  let maxYawAfter = 0;
  for (let i = 0; i < 120; i += 1) {
    car.update(1 / 60, { throttle: 0.3, steer: 0 }, road, {});
    if (i > 45) maxYawAfter = Math.max(maxYawAfter, Math.abs(car.getTelemetry().yawRate));
  }
  check('80 km/h flick settles straight', maxYawAfter < 0.08, `residual yaw ${maxYawAfter.toFixed(3)}`);
}

// Near-limit at 160 km/h full lock: allowed to slide but must stay catchable
// (bounded yaw, finite state).
{
  const car = new VehiclePhysics(spec);
  car.setPosition(0, 0, 0, 0);
  car.setSpeed(160 / 3.6);
  let maxYaw = 0;
  for (let i = 0; i < 60 * 5; i += 1) {
    car.update(1 / 60, { throttle: 0.5, steer: 1 }, road, {});
    maxYaw = Math.max(maxYaw, Math.abs(car.getTelemetry().yawRate));
  }
  const t = car.getTelemetry();
  check('160 km/h sustained lock stays catchable', maxYaw < 1.3 && Number.isFinite(t.speed), `max yaw ${maxYaw.toFixed(2)}`);
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
