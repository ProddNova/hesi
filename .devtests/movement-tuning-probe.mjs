/**
 * MOVIMENTI — the vehicle-movement record (js/vehicle-movement.js) as physics
 * actually reads it.
 *
 * Two things have to hold, and they pull in opposite directions:
 *
 *   1. **The defaults change nothing.** Every feel number the panel exposes used
 *      to be a constant inside js/physics.js. A car nobody has tuned must drive
 *      exactly as it did before the panel existed, so the shipped record is
 *      checked against the numbers the old constants produced (3.5°/g of roll,
 *      1.6°/g of dive, the same steering budget, the same yaw ceiling…).
 *   2. **Every dial does something.** A slider that is wired to nothing is worse
 *      than no slider: it looks like the parameter exists. Each group therefore
 *      gets a measurement that moves in the right direction when its dials move.
 *
 * Plus the boring guarantees the panel and the save path depend on: clamping,
 * normalizing rubbish, presets being whole records, and a signature that only
 * changes when a value does.
 *
 * Run: node .devtests/movement-tuning-probe.mjs
 */
import { VehiclePhysics } from '../js/physics.js';
import { CAR_SPECS } from '../js/data.js';
import {
  DEFAULT_MOVEMENT,
  MOVEMENT_FIELDS,
  MOVEMENT_GROUPS,
  MOVEMENT_PRESETS,
  clampMovementValue,
  formatMovementValue,
  isDefaultMovement,
  movementChangeCount,
  movementFromDocument,
  movementSignature,
  normalizeMovement,
  setDocumentMovement,
} from '../js/vehicle-movement.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const STARTER = CAR_SPECS.find((car) => car.id === 'suzume-e90');
const ROAD = { surfaceGrip: 1, grade: 0, onRoad: true };
const deg = (radians) => radians * 180 / Math.PI;

function car(movement = null, speedKmh = 100) {
  const vehicle = new VehiclePhysics(STARTER);
  if (movement) vehicle.setMovementTuning({ ...DEFAULT_MOVEMENT, ...movement });
  vehicle.setPosition(0, 0, 0, 0);
  vehicle.setSpeed(speedKmh / 3.6);
  return vehicle;
}

/** Drives an input for `seconds` and reports what the body and the tires did. */
function drive(vehicle, seconds, input, settings = {}) {
  const steps = Math.round(seconds * 60);
  let peakRoll = 0;
  let peakPitch = 0;
  let peakSteer = 0;
  let peakYaw = 0;
  for (let i = 0; i < steps; i += 1) {
    vehicle.update(1 / 60, input, ROAD, settings);
    peakRoll = Math.max(peakRoll, Math.abs(vehicle.bodyRoll));
    peakPitch = Math.max(peakPitch, Math.abs(vehicle.bodyPitch));
    peakSteer = Math.max(peakSteer, Math.abs(vehicle.steering));
    peakYaw = Math.max(peakYaw, Math.abs(vehicle.yawRate));
  }
  const telemetry = vehicle.getTelemetry();
  return {
    peakRoll, peakPitch, peakSteer, peakYaw,
    roll: vehicle.bodyRoll,
    pitch: vehicle.bodyPitch,
    lateralG: telemetry.gLateral,
    longitudinalG: telemetry.gLongitudinal,
    speedKmh: telemetry.speedKmh,
    y: vehicle.position.y,
  };
}

// --- 1 · the record itself --------------------------------------------------
{
  check('every field has a default', MOVEMENT_FIELDS.every((f) => Number.isFinite(DEFAULT_MOVEMENT[f.key])));
  check('every default sits inside its own range',
    MOVEMENT_FIELDS.every((f) => DEFAULT_MOVEMENT[f.key] >= f.min && DEFAULT_MOVEMENT[f.key] <= f.max));
  check('every field belongs to a declared group',
    MOVEMENT_FIELDS.every((f) => MOVEMENT_GROUPS.some((g) => g.id === f.group)));
  check('no group is empty (a section with no dials is a bug in the panel)',
    MOVEMENT_GROUPS.every((g) => MOVEMENT_FIELDS.some((f) => f.group === g.id)));
  check('no default carries a stray key', Object.keys(DEFAULT_MOVEMENT).length === MOVEMENT_FIELDS.length,
    `${Object.keys(DEFAULT_MOVEMENT).length} defaults vs ${MOVEMENT_FIELDS.length} fields`);

  const rubbish = normalizeMovement({ rollPerGDeg: 'nonsense', suspensionRate: 99, yawDamping: -5, unknown: 3 });
  check('normalize survives rubbish and clamps to the sliders',
    rubbish.rollPerGDeg === DEFAULT_MOVEMENT.rollPerGDeg && rubbish.suspensionRate === 2.2 && rubbish.yawDamping === 0
      && !('unknown' in rubbish),
    `roll ${rubbish.rollPerGDeg}, rate ${rubbish.suspensionRate}, damping ${rubbish.yawDamping}`);
  check('normalize(null) is the shipped record', isDefaultMovement(normalizeMovement(null)));
  check('clamp is per field', clampMovementValue('rollLimitDeg', 999) === 25 && clampMovementValue('nope', 7) === 7);
  check('change count and default flag agree',
    movementChangeCount(null) === 0 && movementChangeCount({ gripScale: 1.4 }) === 1
      && !isDefaultMovement({ gripScale: 1.4 }));
  check('formatting reads like a setting',
    formatMovementValue('rollPerGDeg', 3.5) === '3.50°/g'
    && formatMovementValue('steerGripBudget', 0.94) === '94%'
    && formatMovementValue('counterSteerAssist', 0) === 'OFF'
    && formatMovementValue('rideHeightDelta', 0.03) === '+0.030 m',
    [formatMovementValue('rollPerGDeg', 3.5), formatMovementValue('steerGripBudget', 0.94),
      formatMovementValue('counterSteerAssist', 0), formatMovementValue('rideHeightDelta', 0.03)].join(' · '));

  const signature = movementSignature(DEFAULT_MOVEMENT);
  check('the signature is stable and value-sensitive',
    signature === movementSignature(normalizeMovement(null))
    && signature !== movementSignature({ ...DEFAULT_MOVEMENT, rollPerGDeg: 3.55 }),
    signature);

  const document = {};
  check('a document with no movement section reads as "nothing published"', movementFromDocument(document) === null);
  setDocumentMovement(document, { rollPerGDeg: 7 });
  check('publishing writes a complete record under runtimeTuning.movement',
    document.runtimeTuning.movement.rollPerGDeg === 7
    && Object.keys(document.runtimeTuning.movement).length === MOVEMENT_FIELDS.length
    && movementFromDocument(document).rollPerGDeg === 7);

  for (const [name, preset] of Object.entries(MOVEMENT_PRESETS)) {
    const normalized = normalizeMovement(preset);
    check(`preset ${name} normalizes to a complete in-range record`,
      MOVEMENT_FIELDS.every((f) => normalized[f.key] >= f.min && normalized[f.key] <= f.max));
  }
  check('preset stock is the shipped record', isDefaultMovement(MOVEMENT_PRESETS.stock));
  check('every other preset actually changes something',
    Object.entries(MOVEMENT_PRESETS).filter(([name]) => name !== 'stock').every(([, p]) => movementChangeCount(p) > 0));
}

// --- 2 · the defaults reproduce the old constants ---------------------------
// A steady 100 km/h corner. ROLL_GRADIENT was 0.061 rad/g at the stock
// suspension rate, PITCH_GRADIENT 0.028 rad/g; both are now authored in degrees
// (3.5 and 1.6), so the lean per g must still land on those numbers — divided by
// the car's own suspension rate, which is what "at the stock rate" meant. The
// starter car is a used one, so its rate is 0.88 rather than 1 and it leans
// proportionally more; that division is the behaviour, not an allowance.
{
  const stock = car(null, 100);
  const suspensionFactor = stock.spec.suspensionStiffness;
  const state = drive(stock, 4, { throttle: 0.3, steer: 1 });
  const rollPerG = deg(Math.abs(state.roll)) / Math.abs(state.lateralG);
  check('default roll gradient is the old 0.061 rad/g',
    Math.abs(rollPerG - 3.5 / suspensionFactor) < 0.15,
    `${rollPerG.toFixed(2)}°/g at ${state.lateralG.toFixed(2)} g, suspension ${suspensionFactor.toFixed(2)}`);
  check('and the shell still leans OUTWARD of the corner',
    Math.sign(state.roll) === -Math.sign(state.lateralG), `roll ${state.roll.toFixed(4)} rad`);

  const braking = car(null, 160);
  const stop = drive(braking, 1.2, { brake: 1 });
  const pitchPerG = deg(Math.abs(stop.pitch)) / Math.abs(stop.longitudinalG);
  check('default dive gradient is the old 0.028 rad/g',
    Math.abs(pitchPerG - 1.6 / suspensionFactor) < 0.15, `${pitchPerG.toFixed(2)}°/g at ${stop.longitudinalG.toFixed(2)} g`);
  check('braking dives (positive pitch, nose down on the shell)', stop.pitch > 0, `pitch ${stop.pitch.toFixed(4)}`);

  const launch = drive(car(null, 30), 2, { throttle: 1 });
  check('accelerating squats instead', launch.pitch < 0, `pitch ${launch.pitch.toFixed(4)}`);

  check('a physics instance nobody tuned holds the shipped record',
    isDefaultMovement(new VehiclePhysics(STARTER).movement));
}

// --- 3 · body attitude group ------------------------------------------------
{
  const corner = { throttle: 0.3, steer: 1 };
  // The limit is opened up here, otherwise a big gradient simply parks on it and
  // the measurement reads the cap instead of the gradient.
  const soft = drive(car({ rollPerGDeg: 10, rollLimitDeg: 25 }, 100), 4, corner);
  const stock = drive(car(null, 100), 4, corner);
  const flat = drive(car({ rollPerGDeg: 0 }, 100), 4, corner);
  check('INCLINAZIONE IN CURVA scales the lean',
    Math.abs(soft.roll) > Math.abs(stock.roll) * 2 && Math.abs(flat.roll) < 1e-6,
    `${deg(Math.abs(soft.roll)).toFixed(2)}° vs ${deg(Math.abs(stock.roll)).toFixed(2)}° vs ${deg(Math.abs(flat.roll)).toFixed(3)}°`);

  const inward = drive(car({ rollPerGDeg: -6, rollLimitDeg: 25 }, 100), 4, corner);
  check('a negative gradient leans the body INTO the corner',
    Math.sign(inward.roll) === Math.sign(inward.lateralG), `roll ${inward.roll.toFixed(4)}`);

  const capped = drive(car({ rollPerGDeg: 20, rollLimitDeg: 2 }, 100), 4, corner);
  check('ROLLIO MASSIMO caps it', deg(Math.abs(capped.roll)) <= 2.001, `${deg(Math.abs(capped.roll)).toFixed(3)}°`);

  const dive = drive(car({ divePerGDeg: 8, diveLimitDeg: 12 }, 160), 1.2, { brake: 1 });
  const diveCapped = drive(car({ divePerGDeg: 8, diveLimitDeg: 1 }, 160), 1.2, { brake: 1 });
  check('BECCHEGGIO and AFFONDO MASSIMO both bite',
    deg(dive.pitch) > 3 && deg(diveCapped.pitch) <= 1.001,
    `${deg(dive.pitch).toFixed(2)}° free, ${deg(diveCapped.pitch).toFixed(3)}° capped`);

  const squatCapped = drive(car({ divePerGDeg: 8, diveLimitDeg: 12, squatLimitDeg: 0.5 }, 30), 2, { throttle: 1 });
  check('CORICAMENTO MASSIMO caps the other direction', deg(-squatCapped.pitch) <= 0.501,
    `${deg(-squatCapped.pitch).toFixed(3)}°`);

  // Response: after a tenth of a second the quick body is further along.
  const quick = car({ bodyResponse: 20, bodyResponseStiffness: 0 }, 100);
  const slow = car({ bodyResponse: 0.5, bodyResponseStiffness: 0 }, 100);
  const quickRoll = drive(quick, 0.12, corner).roll;
  const slowRoll = drive(slow, 0.12, corner).roll;
  check('REATTIVITÀ SCOCCA decides how fast the lean arrives',
    Math.abs(quickRoll) > Math.abs(slowRoll) * 3,
    `${deg(Math.abs(quickRoll)).toFixed(3)}° vs ${deg(Math.abs(slowRoll)).toFixed(3)}° after 0.12 s`);
}

// --- 4 · ride --------------------------------------------------------------
{
  // The road-height follower only runs when the surface supplies a height.
  const flatRoad = { ...ROAD, height: 0, snapHeight: true };
  const settle = (movement) => {
    const vehicle = car(movement, 80);
    for (let i = 0; i < 240; i += 1) vehicle.update(1 / 60, { throttle: 0.2 }, flatRoad, {});
    return vehicle.position.y;
  };
  const stockHeight = settle(null);
  const lowered = settle({ rideHeightDelta: -0.1 });
  const raised = settle({ rideHeightDelta: 0.2 });
  check('ALTEZZA DA TERRA moves the car up and down',
    Math.abs(lowered - (stockHeight - 0.1)) < 0.01 && Math.abs(raised - (stockHeight + 0.2)) < 0.01,
    `${stockHeight.toFixed(3)} → ${lowered.toFixed(3)} / ${raised.toFixed(3)} m`);

  const corner = { throttle: 0.3, steer: 1 };
  const stiff = drive(car({ suspensionRate: 2.2 }, 100), 4, corner);
  const stockRoll = drive(car(null, 100), 4, corner);
  check('DUREZZA SOSPENSIONI leans less and grips more',
    Math.abs(stiff.roll) < Math.abs(stockRoll.roll) * 0.6 && Math.abs(stiff.lateralG) >= Math.abs(stockRoll.lateralG) * 0.95,
    `${deg(Math.abs(stiff.roll)).toFixed(2)}° vs ${deg(Math.abs(stockRoll.roll)).toFixed(2)}°`);

  // A step in the surface height: a soft spring takes visibly longer to arrive.
  const step = (movement) => {
    const vehicle = car(movement, 80);
    for (let i = 0; i < 120; i += 1) vehicle.update(1 / 60, { throttle: 0.2 }, flatRoad, {});
    const from = vehicle.position.y;
    for (let i = 0; i < 12; i += 1) vehicle.update(1 / 60, { throttle: 0.2 }, { ...flatRoad, height: 1 }, {});
    return vehicle.position.y - from;
  };
  const hard = step({ surfaceSpring: 220 });
  const soft = step({ surfaceSpring: 25 });
  check('MOLLA MANTO decides how fast the wheels follow a step',
    hard > soft * 2, `${hard.toFixed(3)} m vs ${soft.toFixed(3)} m in 0.2 s`);
}

// --- 5 · steering ----------------------------------------------------------
{
  // Measured over a very short window, with the "a big error moves the wheel
  // faster" term and the rate floor turned down: at a tenth of a second both
  // settings have already arrived at the modest lock a 100 km/h corner asks for,
  // and the dial being tested would look inert.
  const wheel = { steerCatchGain: 0.5, steerRateFloor: 0.1 };
  const short = drive(car({ ...wheel, steerBuildTime: 0.05 }, 100), 0.04, { steer: 1 });
  const long = drive(car({ ...wheel, steerBuildTime: 1.2 }, 100), 0.04, { steer: 1 });
  check('TEMPO PIENO STERZO decides how fast the wheel moves',
    short.peakSteer > long.peakSteer * 4, `${deg(short.peakSteer).toFixed(2)}° vs ${deg(long.peakSteer).toFixed(2)}° after 0.04 s`);

  const wide = drive(car({ steerGripBudget: 1.15 }, 100), 3, { steer: 1 });
  const narrow = drive(car({ steerGripBudget: 0.5 }, 100), 3, { steer: 1 });
  check('BUDGET ADERENZA STERZO decides how much lock a held turn may ask for',
    wide.peakSteer > narrow.peakSteer * 1.5 && Math.abs(wide.lateralG) > Math.abs(narrow.lateralG),
    `${deg(wide.peakSteer).toFixed(2)}° / ${wide.lateralG.toFixed(2)} g vs ${deg(narrow.peakSteer).toFixed(2)}° / ${narrow.lateralG.toFixed(2)} g`);

  const locked = drive(car({ steerLock: 0.4 }, 60), 3, { steer: 1 });
  const open = drive(car({ steerLock: 2 }, 60), 3, { steer: 1 });
  check('ANGOLO DI STERZO caps the wheel', open.peakSteer > locked.peakSteer,
    `${deg(locked.peakSteer).toFixed(2)}° vs ${deg(open.peakSteer).toFixed(2)}°`);

  // A gentle turn at moderate speed (nothing sliding, no assist steering for
  // us), then let go of the wheel: how much of the held lock is left a tenth of
  // a second later is the dial under test. The wheel's own rate limiter is
  // slowed right down for this, because on its own it already walks the lock
  // back to centre — this dial is the spring that hurries it along.
  const release = (movement) => {
    const vehicle = car({ steerRateFloor: 0.1, steerCatchGain: 0.5, steerBuildTime: 1.2, ...movement }, 60);
    for (let i = 0; i < 180; i += 1) vehicle.update(1 / 60, { steer: 0.35, throttle: 0.15 }, ROAD, { drivingAssist: 0 });
    const held = Math.abs(vehicle.steering);
    for (let i = 0; i < 6; i += 1) vehicle.update(1 / 60, { throttle: 0.15 }, ROAD, { drivingAssist: 0 });
    return Math.abs(vehicle.steering) / Math.max(1e-6, held);
  };
  const quickReturn = release({ steerReturnRate: 18 });
  const lazyReturn = release({ steerReturnRate: 0 });
  check('RITORNO AL CENTRO decides how quickly the lock unwinds',
    quickReturn < lazyReturn * 0.6,
    `${quickReturn.toFixed(3)} vs ${lazyReturn.toFixed(3)} of the held angle left`);
}

// --- 6 · grip and balance --------------------------------------------------
{
  const corner = { throttle: 0.3, steer: 1 };
  const grippy = drive(car({ gripScale: 1.8 }, 120), 4, corner);
  const greasy = drive(car({ gripScale: 0.5 }, 120), 4, corner);
  check('ADERENZA GENERALE moves the cornering limit',
    Math.abs(grippy.lateralG) > Math.abs(greasy.lateralG) * 1.6,
    `${grippy.lateralG.toFixed(2)} g vs ${greasy.lateralG.toFixed(2)} g`);

  // Balance: a soft rear takes bigger slip angles for the same corner, so it
  // rotates more. Measured as peak yaw rate through the same input.
  const loose = drive(car({ rearCornerScale: 0.5 }, 120), 4, corner);
  const planted = drive(car({ rearCornerScale: 1.8 }, 120), 4, corner);
  check('RIGIDEZZA POSTERIORE moves the balance',
    loose.peakYaw > planted.peakYaw, `${loose.peakYaw.toFixed(3)} vs ${planted.peakYaw.toFixed(3)} rad/s`);

  // Handbrake, with its two dials separated: the grip the rear tires keep, and
  // the braking force sent to them. Either one alone will spin the car, so each
  // is measured with the other neutralized.
  const handbrake = (movement) => {
    const vehicle = car(movement, 90);
    let peak = 0;
    for (let i = 0; i < 90; i += 1) {
      vehicle.update(1 / 60, { steer: 1, handbrake: 1 }, ROAD, { drivingAssist: 0 });
      const t = vehicle.getTelemetry();
      peak = Math.max(peak, Math.abs(Math.atan2(t.lateralSpeed, Math.max(1, Math.abs(t.forwardSpeed)))));
    }
    return peak;
  };
  const slippery = handbrake({ handbrakeRearGrip: 0.05, handbrakeForce: 0 });
  const gripping = handbrake({ handbrakeRearGrip: 1, handbrakeForce: 0 });
  check('ADERENZA CON FRENO A MANO decides how far the tail comes round',
    slippery > gripping * 1.5, `${deg(slippery).toFixed(1)}° vs ${deg(gripping).toFixed(1)}°`);
  const hard = handbrake({ handbrakeRearGrip: 1, handbrakeForce: 1.6 });
  check('FORZA FRENO A MANO is the other half of it',
    hard > gripping * 1.5, `${deg(hard).toFixed(1)}° vs ${deg(gripping).toFixed(1)}° with no force behind it`);
}

// --- 7 · slide and assists -------------------------------------------------
{
  // Provoke a slide with the handbrake, release, and see how quickly the assists
  // put it straight. Assists ON in both runs; only the gains differ.
  const recover = (movement) => {
    const vehicle = car(movement, 110);
    for (let i = 0; i < 45; i += 1) vehicle.update(1 / 60, { steer: 1, handbrake: 1 }, ROAD, { drivingAssist: 1 });
    for (let i = 0; i < 120; i += 1) vehicle.update(1 / 60, { throttle: 0.2 }, ROAD, { drivingAssist: 1 });
    const t = vehicle.getTelemetry();
    return Math.abs(Math.atan2(t.lateralSpeed, Math.max(1, Math.abs(t.forwardSpeed))));
  };
  const helped = recover({ stabilityYawGain: 6, counterSteerAssist: 1 });
  const alone = recover({ stabilityYawGain: 0, counterSteerAssist: 0 });
  check('CONTROLLO STABILITÀ / CONTROSTERZO decide how much help arrives',
    helped < alone, `${deg(helped).toFixed(2)}° left vs ${deg(alone).toFixed(2)}° with the assists at zero`);

  // Traction control: full throttle out of a corner in first gear.
  const spin = (movement) => {
    const vehicle = car(movement, 40);
    let peak = 0;
    for (let i = 0; i < 150; i += 1) {
      vehicle.update(1 / 60, { throttle: 1, steer: 0.8 }, ROAD, { drivingAssist: 1 });
      peak = Math.max(peak, vehicle.getTelemetry().rearSaturation);
    }
    return peak;
  };
  check('MARGINE CONTROLLO TRAZIONE decides how much wheelspin is allowed',
    spin({ tractionHeadroom: 2.5 }) > spin({ tractionHeadroom: 0.8 }),
    `${spin({ tractionHeadroom: 2.5 }).toFixed(3)} vs ${spin({ tractionHeadroom: 0.8 }).toFixed(3)} rear saturation`);
}

// --- 8 · rotation ----------------------------------------------------------
{
  const flick = { steer: 1, throttle: 0.3 };
  const eager = drive(car({ inertiaScale: 0.3 }, 90), 1, flick);
  const heavy = drive(car({ inertiaScale: 1.6 }, 90), 1, flick);
  check('INERZIA IN IMBARDATA decides how willingly the car rotates',
    eager.peakYaw > heavy.peakYaw, `${eager.peakYaw.toFixed(3)} vs ${heavy.peakYaw.toFixed(3)} rad/s`);

  const settle = (movement) => {
    const vehicle = car(movement, 120);
    for (let i = 0; i < 45; i += 1) vehicle.update(1 / 60, { steer: 1, handbrake: 1 }, ROAD, { drivingAssist: 0 });
    for (let i = 0; i < 60; i += 1) vehicle.update(1 / 60, {}, ROAD, { drivingAssist: 0 });
    return Math.abs(vehicle.yawRate);
  };
  check('SMORZAMENTO IMBARDATA decides how long the rotation lingers',
    settle({ yawDamping: 2 }) < settle({ yawDamping: 0 }),
    `${settle({ yawDamping: 2 }).toFixed(4)} vs ${settle({ yawDamping: 0 }).toFixed(4)} rad/s left`);

  const ceiling = (movement) => {
    const vehicle = car(movement, 140);
    let peak = 0;
    for (let i = 0; i < 240; i += 1) {
      vehicle.update(1 / 60, { steer: 1, handbrake: 1 }, ROAD, { drivingAssist: 0 });
      peak = Math.max(peak, Math.abs(vehicle.yawRate));
    }
    return peak;
  };
  check('LIMITE IMBARDATA caps the pirouette',
    ceiling({ yawLimit: 0.5, yawLimitFloor: 0 }) < ceiling({ yawLimit: 4, yawLimitFloor: 1.5 }),
    `${ceiling({ yawLimit: 0.5, yawLimitFloor: 0 }).toFixed(2)} vs ${ceiling({ yawLimit: 4, yawLimitFloor: 1.5 }).toFixed(2)} rad/s`);
}

// --- 9 · brakes, engine, gearbox ------------------------------------------
{
  const stop = (movement) => {
    const vehicle = car(movement, 160);
    for (let i = 0; i < 90; i += 1) vehicle.update(1 / 60, { brake: 1 }, ROAD, {});
    return vehicle.getTelemetry().speedKmh;
  };
  // Not proportionally: the pedal is ABS-limited by the tires, so doubling the
  // caliper force buys a fraction of the stopping distance, not half of it.
  check('FORZA FRENANTE decides how hard it stops',
    stop({ brakeScale: 2 }) < stop({ brakeScale: 0.4 }) - 10,
    `${stop({ brakeScale: 2 }).toFixed(1)} km/h vs ${stop({ brakeScale: 0.4 }).toFixed(1)} km/h left after 1.5 s`);

  const coast = (movement) => {
    const vehicle = car(movement, 140);
    for (let i = 0; i < 180; i += 1) vehicle.update(1 / 60, {}, ROAD, {});
    return vehicle.getTelemetry().speedKmh;
  };
  check('FRENO MOTORE slows a lifted throttle',
    coast({ engineBraking: 3 }) < coast({ engineBraking: 0 }) - 3,
    `${coast({ engineBraking: 3 }).toFixed(1)} km/h vs ${coast({ engineBraking: 0 }).toFixed(1)} km/h after 3 s`);

  const shiftAt = (movement) => {
    const vehicle = car(movement, 20);
    let gear = vehicle.gear;
    for (let i = 0; i < 600; i += 1) {
      vehicle.update(1 / 60, { throttle: 1 }, ROAD, {});
      if (vehicle.gear > gear) return vehicle.getTelemetry().rpm;
      gear = vehicle.gear;
    }
    return NaN;
  };
  const early = shiftAt({ upshiftRPM: 0.6 });
  // Not the top of the range: past the limiter there is no torque to reach the
  // threshold with, so the gearbox would sit on the redline and never shift.
  const late = shiftAt({ upshiftRPM: 1.05 });
  check('SOGLIA SALITA MARCE moves the shift point',
    Number.isFinite(early) && Number.isFinite(late) && late > early + 200,
    `${early.toFixed(0)} rpm vs ${late.toFixed(0)} rpm`);
}

// --- 10 · resistances -----------------------------------------------------
{
  const roll = (movement) => {
    const vehicle = car(movement, 200);
    for (let i = 0; i < 300; i += 1) vehicle.update(1 / 60, {}, ROAD, {});
    return vehicle.getTelemetry().speedKmh;
  };
  check('RESISTENZA ARIA decides how fast a lift bleeds speed',
    roll({ dragScale: 2.5, engineBraking: 0, rollingResistanceScale: 0 })
      < roll({ dragScale: 0, engineBraking: 0, rollingResistanceScale: 0 }) - 30,
    `${roll({ dragScale: 2.5, engineBraking: 0, rollingResistanceScale: 0 }).toFixed(1)} km/h vs ${roll({ dragScale: 0, engineBraking: 0, rollingResistanceScale: 0 }).toFixed(1)} km/h`);

  check('ATTRITO DI ROTOLAMENTO does too',
    roll({ dragScale: 0, engineBraking: 0, rollingResistanceScale: 3 })
      < roll({ dragScale: 0, engineBraking: 0, rollingResistanceScale: 0 }) - 3);

  const climb = (movement) => {
    const vehicle = car(movement, 120);
    for (let i = 0; i < 180; i += 1) vehicle.update(1 / 60, { throttle: 0.2 }, { ...ROAD, grade: 0.12 }, {});
    return vehicle.getTelemetry().speedKmh;
  };
  check('PESO DELLE PENDENZE decides how much a climb costs',
    climb({ gradeForce: 2.5 }) < climb({ gradeForce: 0 }) - 20,
    `${climb({ gradeForce: 2.5 }).toFixed(1)} km/h vs ${climb({ gradeForce: 0 }).toFixed(1)} km/h up a 12% grade`);
}

// --- 11 · live retuning ---------------------------------------------------
{
  // The panel drags mid-corner: swapping the record must not disturb the car's
  // state, only the rules it moves by from the next substep on.
  const vehicle = car(null, 120);
  for (let i = 0; i < 120; i += 1) vehicle.update(1 / 60, { steer: 1, throttle: 0.3 }, ROAD, {});
  const before = { x: vehicle.position.x, speed: vehicle.getTelemetry().speed, roll: vehicle.bodyRoll };
  vehicle.setMovementTuning({ ...DEFAULT_MOVEMENT, rollPerGDeg: 14, rollLimitDeg: 25 });
  check('installing a record mid-corner keeps position, speed and attitude',
    vehicle.position.x === before.x && vehicle.getTelemetry().speed === before.speed && vehicle.bodyRoll === before.roll);
  for (let i = 0; i < 60; i += 1) vehicle.update(1 / 60, { steer: 1, throttle: 0.3 }, ROAD, {});
  check('and the new lean arrives within a second',
    Math.abs(vehicle.bodyRoll) > Math.abs(before.roll) * 2,
    `${deg(Math.abs(before.roll)).toFixed(2)}° → ${deg(Math.abs(vehicle.bodyRoll)).toFixed(2)}°`);

  const changed = new VehiclePhysics(STARTER);
  changed.setMovementTuning({ gripScale: 1.4 });
  changed.changeSpec({ ...STARTER, mass: 1400 });
  check('changing car keeps the movement record', changed.movement.gripScale === 1.4);
}

// --- 12 · no dead sliders -------------------------------------------------
// The catch-all, and the reason a new field cannot be added without wiring it:
// every dial is driven to each end of its range through a set of manoeuvres, and
// at least one of them has to come out differently. A slider that is connected
// to nothing is worse than no slider — it advertises a parameter that is not
// there — and this sweep is what makes that a failing test rather than a
// surprise for whoever is tuning.
{
  // The three slope dials are read by game.js's updateBodyClimb (they pitch the
  // SHELL on a gradient, which the sim itself has no opinion about), so they
  // cannot move anything here. .devtests/body-attitude-probe.mjs drives that
  // path in the real game.
  const OUTSIDE_PHYSICS = new Set(['slopeFollow', 'slopeLimitDeg', 'slopeSmoothing']);

  const flatRoad = { ...ROAD, height: 0, snapHeight: true };
  const wall = {
    getRoadInfo: () => flatRoad,
    // A wall across the road, struck off-centre so the impact has a lever arm.
    sweep: (from, to) => (to.z < 40 ? null : {
      hit: true,
      normal: { x: 0.25, y: 0, z: -1 },
      correctedPosition: { x: to.x, y: to.y, z: 40 },
      point: { x: to.x + 0.8, y: to.y, z: 40 },
      kind: 'wall',
      restitution: 0.2,
      friction: 0.5,
    }),
  };

  // `phases` exists for the dials that only speak during a change of input: the
  // wheel's return to centre needs the button RELEASED, and the direction-change
  // boost needs a corner taken against the load of the previous one.
  const SCENARIOS = [
    { name: 'corner', speed: 100, phases: [[3, { throttle: 0.4, steer: 1 }]], road: flatRoad },
    { name: 'brake into a turn', speed: 160, phases: [[2, { brake: 1, steer: 0.35 }]], road: flatRoad },
    { name: 'launch', speed: 0, phases: [[4, { throttle: 1, steer: 0.5 }]], road: flatRoad },
    { name: 'handbrake slide', speed: 110, phases: [[2, { steer: 1, handbrake: 1 }]], road: flatRoad, settings: { drivingAssist: 0 } },
    { name: 'coast up a grade', speed: 140, phases: [[3, {}]], road: { ...flatRoad, grade: 0.1 } },
    { name: 'crest', speed: 120, phases: [[1.5, { throttle: 0.3 }]], road: { ...flatRoad, height: 1.2 } },
    { name: 'wall', speed: 120, phases: [[1.5, { throttle: 0.5 }]], road: wall },
    { name: 'turn and let go', speed: 100, phases: [[1.5, { steer: 0.5, throttle: 0.2 }], [1, { throttle: 0.2 }]], road: flatRoad },
    { name: 'left-right transition', speed: 200, phases: [[0.7, { steer: 1, throttle: 0.3 }], [0.9, { steer: -1, throttle: 0.3 }]], road: flatRoad },
  ];

  const fingerprint = (scenario, movement) => {
    const vehicle = car(movement, scenario.speed);
    for (const [seconds, input] of scenario.phases) {
      const steps = Math.round(seconds * 60);
      for (let i = 0; i < steps; i += 1) vehicle.update(1 / 60, input, scenario.road, scenario.settings || {});
    }
    return [
      vehicle.position.x, vehicle.position.y, vehicle.position.z,
      vehicle.heading, vehicle.yawRate, vehicle.steering, vehicle.rpm, vehicle.gear,
      vehicle.bodyRoll, vehicle.bodyPitch, vehicle.velocity.length(),
    ].map((value) => value.toFixed(9)).join('|');
  };

  const baseline = SCENARIOS.map((scenario) => fingerprint(scenario, null));
  let dead = 0;
  for (const field of MOVEMENT_FIELDS) {
    if (OUTSIDE_PHYSICS.has(field.key)) continue;
    const ends = [field.min, field.max].filter((value) => value !== DEFAULT_MOVEMENT[field.key]);
    const moved = [];
    for (const value of ends) {
      SCENARIOS.forEach((scenario, index) => {
        if (fingerprint(scenario, { [field.key]: value }) !== baseline[index]) moved.push(scenario.name);
      });
    }
    if (!moved.length) {
      dead += 1;
      console.log(`FAIL  ${field.key} is not wired to anything the sim does`);
    }
  }
  check(`all ${MOVEMENT_FIELDS.length - OUTSIDE_PHYSICS.size} sim-side dials change the driving`, dead === 0,
    dead ? `${dead} dead slider(s)` : `${SCENARIOS.length} manoeuvres`);
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
