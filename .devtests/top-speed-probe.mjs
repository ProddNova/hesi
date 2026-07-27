/**
 * Straight-line top-speed probe for the playable car.
 *
 * The sim derives top speed from the torque curve, the gearing and the drag
 * area — nothing declares it — so `topSpeedKmh` in js/data.js is only a claim
 * until something drives the car flat out and checks. This does that: full
 * throttle, flat road, automatic box, until the speed stops rising.
 *
 *   node .devtests/top-speed-probe.mjs
 */
import { VehiclePhysics } from '../js/physics.js';
import * as Data from '../js/data.js';

const TARGET_KMH = 220;
const TOLERANCE_KMH = 3;

function runFlatOut(spec, { seconds = 240, dt = 1 / 120 } = {}) {
  const car = new VehiclePhysics({ ...spec, transmissionMode: 'automatic', fuel: 1e6 });
  const input = { throttle: 1, brake: 0, steer: 0, handbrake: 0 };
  let best = 0, bestGear = 0, timeTo100 = null;
  for (let step = 0; step < seconds / dt; step += 1) {
    car.update(dt, input, { grade: 0, grip: 1 });
    const telemetry = car.getTelemetry();
    if (telemetry.speedKmh > best) { best = telemetry.speedKmh; bestGear = telemetry.gear; }
    if (timeTo100 === null && telemetry.speedKmh >= 100) timeTo100 = step * dt;
  }
  return { topSpeedKmh: best, gear: bestGear, timeTo100 };
}

const spec = Data.CARS[0];
const stock = runFlatOut(spec);
const declared = spec.topSpeedKmh;

const lines = [
  `car                ${spec.name} (${spec.id})`,
  `power              ${spec.engine.powerHp} hp · ${spec.engine.peakTorqueNm} Nm · redline ${spec.engine.redlineRpm}`,
  `gearing            top ${spec.transmission.gears.at(-1)} × final ${spec.transmission.finalDrive}`,
  `declared top speed ${declared} km/h`,
  `simulated top speed ${stock.topSpeedKmh.toFixed(1)} km/h in gear ${stock.gear}`,
  `0-100 km/h         ${stock.timeTo100 === null ? 'never' : `${stock.timeTo100.toFixed(2)} s`}`,
];

const declaredOk = Math.abs(declared - TARGET_KMH) < 0.5;
const simulatedOk = Math.abs(stock.topSpeedKmh - TARGET_KMH) <= TOLERANCE_KMH;
lines.push(
  `${declaredOk ? 'PASS' : 'FAIL'}  declared topSpeedKmh is ${TARGET_KMH}`,
  `${simulatedOk ? 'PASS' : 'FAIL'}  the car actually reaches ${TARGET_KMH} ±${TOLERANCE_KMH} km/h`,
);

console.log(lines.join('\n'));
process.exitCode = declaredOk && simulatedOk ? 0 : 1;
