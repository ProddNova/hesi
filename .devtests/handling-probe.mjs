/**
 * Handling probe — the three things the driving actually has to do, measured
 * on the real starter car rather than on a synthetic spec:
 *
 *   1. hold a corner on full throttle without snapping into a spin,
 *   2. let a slide be CAUGHT once it has started, and
 *   3. swerve through traffic and settle straight afterwards.
 *
 * Run: node .devtests/handling-probe.mjs
 */
import { VehiclePhysics } from '../js/physics.js';
import { CAR_SPECS } from '../js/data.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const STARTER = CAR_SPECS.find((car) => car.id === 'suzume-e90');
const ROAD = { surfaceGrip: 1, grade: 0, onRoad: true };
const deg = (radians) => radians * 180 / Math.PI;

function makeCar(settings = {}) {
  const car = new VehiclePhysics(STARTER);
  car.setPosition(0, 0, 0, 0);
  return { car, settings };
}

// Drift angle: how far the car is pointing away from where it is going. This
// is the "the body sits sideways" complaint expressed as a number.
const drift = (car) => {
  const t = car.getTelemetry();
  return Math.abs(Math.atan2(t.lateralSpeed, Math.max(1, Math.abs(t.forwardSpeed))));
};

function drive(car, seconds, input, settings = {}) {
  const steps = Math.round(seconds * 60);
  let peakDrift = 0;
  let peakYaw = 0;
  for (let i = 0; i < steps; i += 1) {
    car.update(1 / 60, input, ROAD, settings);
    peakDrift = Math.max(peakDrift, drift(car));
    peakYaw = Math.max(peakYaw, Math.abs(car.getTelemetry().yawRate));
  }
  return { peakDrift, peakYaw };
}

// 1 · Power-on corner. Full lock and full throttle held from 80 km/h: the car
// may run wide, it may not swap ends.
{
  const { car } = makeCar();
  car.setSpeed(80 / 3.6);
  const { peakDrift, peakYaw } = drive(car, 5, { throttle: 1, steer: 1 });
  check('80 km/h full throttle + full lock never swaps ends',
    peakDrift < 0.24 && peakYaw < 0.9 && Number.isFinite(car.state.speed),
    `peak drift ${deg(peakDrift).toFixed(1)}°, peak yaw ${peakYaw.toFixed(2)} rad/s`);
  check('and it is still pointing down the road at the end',
    drift(car) < 0.12, `settled drift ${deg(drift(car)).toFixed(1)}°`);
}

// 2 · Catch a slide, provoked for real with the handbrake.
//
// Two different drivers, because they are two different claims. With the
// assists on, the crude input a keyboard actually produces — hold opposite,
// then let go — has to be enough. With them off, the car still has to be
// catchable, but only by someone modulating the lock, so that run is closed on
// the front axle's own velocity angle the way a pair of hands would be.
const provokeSlide = (settings) => {
  const { car } = makeCar();
  car.setSpeed(90 / 3.6);
  drive(car, 0.8, { throttle: 0.3, steer: 1, handbrake: 1 }, settings);
  return car;
};

{
  const settings = { drivingAssist: 1 };
  const car = provokeSlide(settings);
  const provoked = drift(car);
  const counter = drive(car, 0.7, { throttle: 0.15, steer: -1 }, settings);
  const settle = drive(car, 2, { throttle: 0.2, steer: 0 }, settings);
  check('handbrake provokes a real slide', provoked > 0.12,
    `drift after handbrake ${deg(provoked).toFixed(1)}°`);
  check('assists on: blunt opposite lock catches it', drift(car) < 0.05,
    `drift ${deg(provoked).toFixed(1)}° → ${deg(drift(car)).toFixed(1)}°`);
  check('assists on: the catch never becomes a tank-slapper',
    Math.max(counter.peakYaw, settle.peakYaw) < 1.6 && settle.peakDrift <= provoked,
    `peak yaw ${Math.max(counter.peakYaw, settle.peakYaw).toFixed(2)} rad/s`);
}

{
  const settings = { drivingAssist: 0 };
  const car = provokeSlide(settings);
  let peakLock = 0;
  let peakDrift = 0;
  let peakYaw = 0;
  for (let i = 0; i < 60 * 3; i += 1) {
    const t = car.getTelemetry();
    // Opposite lock proportional to how far the car is travelling away from
    // where it points, unwound as the slide comes back.
    const hands = Math.max(-1, Math.min(1, Math.atan2(t.lateralSpeed, Math.max(1, t.forwardSpeed)) * 5));
    car.update(1 / 60, { throttle: 0.12, steer: hands }, ROAD, settings);
    const after = car.getTelemetry();
    peakLock = Math.max(peakLock, Math.abs(after.steeringAngle));
    peakDrift = Math.max(peakDrift, drift(car));
    peakYaw = Math.max(peakYaw, Math.abs(after.yawRate));
  }
  // The regression this guards is the one that made slides unrecoverable: the
  // steering cap used to hold opposite lock to about 3 degrees at speed, so
  // there was nothing to catch a slide WITH. Assists off is allowed to end in a
  // spin — a real car does — but only after the driver has had the lock.
  check('assists off: near-full opposite lock is available', peakLock > 0.35,
    `${deg(peakLock).toFixed(0)}° of counter-steer reached`);
  check('assists off: the slide stays bounded and physical',
    peakDrift < 1.05 && peakYaw < 1.7 && Number.isFinite(car.state.speed),
    `peak drift ${deg(peakDrift).toFixed(0)}°, peak yaw ${peakYaw.toFixed(2)} rad/s`);
}

// 3 · Swerve through traffic: a lane change at 130 km/h has to move the car a
// full lane sideways, stay composed while it does it, and settle straight.
{
  const { car } = makeCar();
  car.setSpeed(130 / 3.6);
  const startX = car.position.x;
  let peak = 0;
  const leg = (seconds, steer) => {
    const result = drive(car, seconds, { throttle: 0.45, steer });
    peak = Math.max(peak, result.peakDrift);
  };
  leg(0.7, 1);
  leg(0.7, -1);
  const displaced = Math.abs(car.position.x - startX);
  const settle = drive(car, 2, { throttle: 0.45, steer: 0 });
  check('130 km/h lane change clears a lane', displaced > 3.2,
    `${displaced.toFixed(1)} m of lateral movement in 1.4 s`);
  check('130 km/h lane change stays composed', peak < 0.14,
    `peak drift ${deg(peak).toFixed(1)}°`);
  check('and comes back to straight afterwards',
    Math.abs(car.getTelemetry().yawRate) < 0.05 && drift(car) < 0.03,
    `residual yaw ${car.getTelemetry().yawRate.toFixed(3)} rad/s, peak during settle ${settle.peakYaw.toFixed(2)}`);
}

// 4 · Body attitude stays in road-car territory rather than motorcycle lean.
{
  const { car } = makeCar();
  car.setSpeed(90 / 3.6);
  let peakRoll = 0;
  let peakPitch = 0;
  for (let i = 0; i < 240; i += 1) {
    car.update(1 / 60, { throttle: 0.6, steer: 1 }, ROAD, {});
    peakRoll = Math.max(peakRoll, Math.abs(car.getTelemetry().bodyRoll));
  }
  for (let i = 0; i < 120; i += 1) {
    car.update(1 / 60, { brake: 1, steer: 0 }, ROAD, {});
    peakPitch = Math.max(peakPitch, Math.abs(car.getTelemetry().bodyPitch));
  }
  check('body roll stays under 6 degrees', peakRoll < 0.105, `${deg(peakRoll).toFixed(1)}° at the limit`);
  check('brake dive stays under 4 degrees', peakPitch < 0.07, `${deg(peakPitch).toFixed(1)}° under full braking`);
}

// 5 · Assists fully off must still integrate cleanly (no NaN, no launch).
{
  const { car } = makeCar();
  car.setSpeed(140 / 3.6);
  const settings = { drivingAssist: 0 };
  drive(car, 3, { throttle: 1, steer: 1, handbrake: 1 }, settings);
  const t = car.getTelemetry();
  check('assists off stays numerically sane',
    Number.isFinite(t.speed) && Number.isFinite(t.yawRate) && t.speedKmh < 300,
    `${t.speedKmh.toFixed(0)} km/h, yaw ${t.yawRate.toFixed(2)}`);
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
